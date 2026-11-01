#!/usr/bin/env node
/**
 * muse-noise.mjs — Phase 2: headless Meta Muse client (no browser).
 *
 * Talks to the Hatch VM directly over the encrypted Noise WebSocket
 *   wss://hatch.metaaivm.com/v1/noise?vm_id=…&auth_token=…&notary_token=…
 * transport  Noise_XX_25519_AESGCM_SHA256  (X25519 + HKDF-SHA256 + AES-256-GCM)
 * framing    protobuf (hatch.noise.* + ingress_rev_proxy.NoiseTransportFrame),
 *            HTTP/2-style multiplexed requests carried inside the Noise tunnel.
 *
 * Everything below was reverse-engineered from the real client (see
 * tools/capture-noise.mjs + tools/decode-desc.mjs) and verified against it.
 *
 * Bootstrap (cookie-authed REST, from the logged-in session):
 *   POST /api/auth/check  -> {ok, access_token, viewer_id}
 *   GET  /api/session     -> {vm_id, endpoint_url}
 *   POST /api/hatch/vm/wake {vm_id}
 *   POST /api/hatch/token   {vmAddress, vmName} -> {token, notary_token}
 *
 * The client is pure Node (WebCrypto + `ws`, or wreq-js with MUSE_TLS=wreq); it only needs the login cookies.
 */
import { WebSocket } from 'ws'

// TLS like Chrome: MUSE_TLS=wreq sends the REST calls and the WS handshake through wreq-js (BoringSSL with Chrome's
// ClientHello and HTTP/2 SETTINGS) instead of Node's OpenSSL, whose ClientHello no browser sends (01/11: JA4
// t13d5212h1_… for Node's fetch, t13d1516h2_8daaf6152771_… for Chrome). Its newest preset is Chrome 149: the ML-DSA
// sigalgs and trust-anchors extension of Chrome 153 cannot be set, so Muse sees a real Chrome 149 hello.
// MUSE_TLS=node (default) keeps Node's fetch + ws.
const TLS = (process.env.MUSE_TLS || 'node').trim().toLowerCase()
const wreq = TLS === 'wreq' ? await import('wreq-js') : null

const C = globalThis.crypto || globalThis.webcrypto
const LB_HOST = process.env.MUSE_NOISE_HOST || 'hatch.metaaivm.com'
const NOISE_PATH = '/v1/noise'
const APP_ID = 'hatch-web'
// Next.js RSC server-action id for fetchSubscriptionAction (the Usage/credits meter). Build-specific hash: a Muse
// redeploy changes it (24/10/2026 01:07 UTC 4029ac5c… → 40034617…, every meter read then got 404 "Server action not
// found" and the pool kept stale quotas) → usage() finds the new id in the app's JS (refreshSubscriptionAction).
// MUSE_SUBSCRIPTION_ACTION_ID sets the id to start from.
let subscriptionActionId = process.env.MUSE_SUBSCRIPTION_ACTION_ID || '409b972cbb33d3e372f4ca9d3c8332677217064f62' // 27/10
export const subscriptionAction = () => subscriptionActionId
const PROTONAME = 'Noise_XX_25519_AESGCM_SHA256'
const CHUNK_MAX = 65489
// Capabilities the real client sends in chat.subscribe (buildHatchChatCapabilities).
export const DEFAULT_CAPS = ['chat_cancel', 'delta_stream', 'custom_reactions', 'custom_reactions_facebook_thumbs_up_v1', 'voice_reply_captions', 'voice_user_live_transcript']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ crypto
const sha256 = async (data) => new Uint8Array(await C.subtle.digest('SHA-256', data))
async function hmac(key, msg) {
  const k = await C.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await C.subtle.sign('HMAC', k, msg))
}
// Noise HKDF: returns n 32-byte outputs.
async function hkdf(ck, ikm, n) {
  const tmpk = await hmac(ck, ikm)
  const a = await hmac(tmpk, new Uint8Array([1]))
  const b = await hmac(tmpk, concat(a, new Uint8Array([2])))
  if (n === 2) return [a, b]
  const c = await hmac(tmpk, concat(b, new Uint8Array([3])))
  return [a, b, c]
}
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0))
  let o = 0
  for (const a of arrs) { out.set(a, o); o += a.length }
  return out
}
// AES-256-GCM cipherstate; nonce = 4 zero bytes + 8-byte big-endian counter.
class CipherState {
  constructor(key) {
    this.key = key
    this._n = 0
    this.ready = C.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt'])
  }
  _iv() {
    const iv = new Uint8Array(12)
    const dv = new DataView(iv.buffer)
    dv.setUint32(4, Math.floor(this._n / 0x100000000), false)
    dv.setUint32(8, this._n >>> 0, false)
    this._n++
    return iv
  }
  async encrypt(ad, pt) {
    const k = await this.ready
    return new Uint8Array(await C.subtle.encrypt({ name: 'AES-GCM', iv: this._iv(), additionalData: ad }, k, pt))
  }
  async decrypt(ad, ct) {
    const k = await this.ready
    return new Uint8Array(await C.subtle.decrypt({ name: 'AES-GCM', iv: this._iv(), additionalData: ad }, k, ct))
  }
}
async function genX25519() {
  const kp = await C.subtle.generateKey('X25519', true, ['deriveBits', 'deriveKey'])
  const pub = new Uint8Array(await C.subtle.exportKey('raw', kp.publicKey))
  return { priv: kp.privateKey, pub }
}
async function dh(priv, pubBytes) {
  if (pubBytes.length !== 32) throw new Error('x25519: bad public key length')
  const pub = await C.subtle.importKey('raw', pubBytes, 'X25519', false, [])
  return new Uint8Array(await C.subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256))
}

// ------------------------------------------------------------------ Noise_XX
class SymmetricState {
  constructor() { this.h = null; this.ck = null; this.cipher = null }
  async initialize() {
    // The real client pads the protocol name to 32 bytes and uses that as the
    // initial cipher key WITHOUT hashing it, and does not key the cipherstate
    // until the first MixKey — so the handshake msg1 payload travels in the clear.
    const name = new TextEncoder().encode(PROTONAME)
    const padded = new Uint8Array(32)
    padded.set(name.subarray(0, 32))
    this.ck = padded.slice()
    this.h = padded.slice()
    await this.mixHash(new Uint8Array(0)) // h = SHA256(padded)
    this.cipher = null
  }
  async mixHash(data) { this.h = await sha256(concat(this.h, data)) }
  async mixKey(dhOut) {
    const [ck2, key] = await hkdf(this.ck, dhOut, 2)
    this.ck = ck2
    this.cipher = new CipherState(key)
  }
  async encryptAndHash(pt) {
    const ct = this.cipher ? await this.cipher.encrypt(this.h, pt) : pt
    await this.mixHash(ct)
    return ct
  }
  async decryptAndHash(ct) {
    const pt = this.cipher ? await this.cipher.decrypt(this.h, ct) : ct
    await this.mixHash(ct)
    return pt
  }
  async split() {
    const [k1, k2] = await hkdf(this.ck, new Uint8Array(0), 2)
    return [new CipherState(k1), new CipherState(k2)]
  }
}

// msg1 payload: protobuf field 1 (tag 0x0A) = 32-byte client nonce.
function encodeClientNonce(nonce) { return concat(new Uint8Array([0x0a, 0x20]), nonce) }

class NoiseXX {
  async writeMessage1() {
    this.e = await genX25519()
    await this.s.mixHash(this.e.pub)
    const nonce = new Uint8Array(C.getRandomValues(new Uint8Array(32)))
    const payload = encodeClientNonce(nonce)
    const ct = await this.s.encryptAndHash(payload) // cipher null -> plaintext
    return concat(this.e.pub, ct)
  }
  async readMessage2(msg) {
    if (msg.length < 96) throw new Error(`noise msg2 too short (${msg.length})`)
    const e2 = msg.subarray(0, 32)
    this.remoteEphemeral = new Uint8Array(e2) // #m in the real client
    await this.s.mixHash(e2)
    await this.s.mixKey(await dh(this.e.priv, e2)) // ee
    this.remoteStatic = await this.s.decryptAndHash(msg.subarray(32, 80)) // #p
    await this.s.mixKey(await dh(this.e.priv, this.remoteStatic)) // es
    const payload = await this.s.decryptAndHash(msg.subarray(80))
    return payload
  }
  async writeMessage3() {
    this.s2 = await genX25519() // client static (#w)
    const encStatic = await this.s.encryptAndHash(this.s2.pub) // write s
    // "se" = DH(initiator static, responder EPHEMERAL) — matches the real client's
    // w(#w.privateKey, #m). Using remoteStatic here breaks the split key and the
    // server closes right after msg3.
    await this.s.mixKey(await dh(this.s2.priv, this.remoteEphemeral)) // se
    const ct = await this.s.encryptAndHash(new Uint8Array(0))
    return concat(encStatic, ct)
  }
  async split() { return this.s.split() }
}

// ------------------------------------------------------------------ protobuf
// Minimal encoder/decoder for the recovered hatch.noise.* schemas.
// field kinds: 'varint' (int32/int64/uint32/enum/bool), 'bytes' (string/bytes),
// 'msg' (embedded message). rep = repeated. of = sub-schema. oneof = group name.
const S_HEADER = [{ n: 'key', f: 1, k: 'bytes' }, { n: 'value', f: 2, k: 'bytes' }]
const S_AREQ = [
  { n: 'verb', f: 1, k: 'bytes' }, { n: 'path', f: 2, k: 'bytes' },
  { n: 'headers', f: 3, k: 'msg', of: S_HEADER, rep: true },
  { n: 'body', f: 4, k: 'bytes' }, { n: 'end_body', f: 5, k: 'varint' },
]
const S_ARESP = [
  { n: 'status', f: 1, k: 'varint' }, { n: 'headers', f: 2, k: 'msg', of: S_HEADER, rep: true },
  { n: 'body', f: 3, k: 'bytes' }, { n: 'end_body', f: 4, k: 'varint' },
]
const S_BCHUNK = [{ n: 'data', f: 1, k: 'bytes' }, { n: 'end_body', f: 2, k: 'varint' }]
const S_RESET = [{ n: 'code', f: 1, k: 'varint' }, { n: 'reason', f: 2, k: 'bytes' }]
const S_FRAME = [
  { n: 'stream_id', f: 1, k: 'varint' },
  { n: 'request', f: 2, k: 'msg', of: S_AREQ, oneof: 'kind' },
  { n: 'response', f: 3, k: 'msg', of: S_ARESP, oneof: 'kind' },
  { n: 'body_chunk', f: 4, k: 'msg', of: S_BCHUNK, oneof: 'kind' },
  { n: 'reset', f: 5, k: 'msg', of: S_RESET, oneof: 'kind' },
]
const S_SREQ = [{ n: 'service', f: 1, k: 'varint' }, { n: 'payload', f: 2, k: 'bytes' }]
const S_SRESP = [{ n: 'payload', f: 1, k: 'bytes' }]
const S_CHUNK = [
  { n: 'chunk_id', f: 1, k: 'varint' }, { n: 'chunk_index', f: 2, k: 'varint' },
  { n: 'total_chunks', f: 3, k: 'varint' }, { n: 'payload', f: 4, k: 'bytes' },
]

function varintBytes(val) {
  let v = typeof val === 'bigint' ? val : BigInt(val)
  v = BigInt.asUintN(64, v) // two's-complement for negatives
  const out = []
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b) } while (v)
  return Uint8Array.from(out)
}
function utf8(s) { return new TextEncoder().encode(s) }
// Normalize a workspace path/URI to the gateway form "workspace/<...>".
function wsPath(p) {
  let s = String(p).trim()
  if (s.startsWith('sandbox://')) s = s.slice(10)
  s = s.replace(/^\/+/, '')
  if (!s.startsWith('workspace/')) s = 'workspace/' + s
  return s
}
function b64u8(b64) { const s = Buffer.from(b64, 'base64').toString('binary'); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u }

function encodeMessage(obj, schema) {
  const parts = []
  for (const fld of schema) {
    const val = obj[fld.n]
    if (val === undefined || val === null) continue
    const items = fld.rep ? val : [val]
    for (const it of items) {
      if (fld.k === 'varint') {
        const num = typeof it === 'boolean' ? (it ? 1 : 0) : it
        if (num === 0 || num === false || num === 0n) { /* proto3 default: skip */ }
        parts.push(varintBytes((fld.f << 3) | 0), varintBytes(num))
      } else if (fld.k === 'bytes') {
        const bytes = typeof it === 'string' ? utf8(it) : Uint8Array.from(it)
        if (bytes.length === 0 && !fld.rep) { /* empty default: still emit for required bytes? keep */ }
        parts.push(varintBytes((fld.f << 3) | 2), varintBytes(bytes.length), bytes)
      } else if (fld.k === 'msg') {
        const sub = encodeMessage(it, fld.of)
        parts.push(varintBytes((fld.f << 3) | 2), varintBytes(sub.length), sub)
      }
    }
  }
  return concat(...(parts.length ? parts : [new Uint8Array(0)]))
}

function decodeMessage(bytes, schema) {
  const obj = {}
  let i = 0
  const rdVarint = () => { let out = 0n, shift = 0n; while (true) { const b = bytes[i++]; out |= BigInt(b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7n } return out }
  while (i < bytes.length) {
    const key = Number(rdVarint())
    const fn = key >> 3, wt = key & 7
    let val
    if (wt === 0) val = rdVarint()
    else if (wt === 2) { const len = Number(rdVarint()); val = bytes.subarray(i, i + len); i += len }
    else if (wt === 5) { val = bytes.readUInt32LE(i); i += 4 }
    else if (wt === 1) { val = bytes.readBigUInt64LE(i); i += 8 }
    else { throw new Error(`protobuf wire type ${wt}`) }
    const fld = schema.find((s) => s.f === fn)
    if (!fld) continue
    if (fld.k === 'varint') obj[fld.n] = fld.n === 'end_body' ? Boolean(Number(BigInt.asIntN(64, val))) : BigInt.asIntN(64, val)
    else if (fld.k === 'bytes') obj[fld.n] = val
    else if (fld.k === 'msg') { const sub = decodeMessage(val, fld.of); if (fld.rep) (obj[fld.n] ||= []).push(sub); else obj[fld.n] = sub }
    if (fld.oneof) obj.kind = { case: fld.n, value: obj[fld.n] }
  }
  return obj
}

// ------------------------------------------------------------------ transport
function chunkMessage(bytes) {
  const chunkId = BigInt.asIntN(64, (BigInt(Math.floor(Math.random() * 0x100000000)) << 32n) | BigInt(Math.floor(Math.random() * 0x100000000)))
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK_MAX))
  const out = []
  for (let idx = 0; idx < total; idx++) {
    const slice = bytes.subarray(idx * CHUNK_MAX, Math.min((idx + 1) * CHUNK_MAX, bytes.length))
    out.push(encodeMessage({ chunk_id: chunkId, chunk_index: idx, total_chunks: total, payload: slice }, S_CHUNK))
  }
  return out
}

class NoiseTransport {
  constructor(c1, c2) { this.c1 = c1; this.c2 = c2; this.nextStream = 1n; this.pending = new Map(); this._sendQ = Promise.resolve() }
  allocStream() { return this.nextStream++ }
  // Encrypt + send one message's chunks, one message at a time. The cipher takes its nonce when encrypt() is called but
  // WebCrypto finishes out of order (a 512 KB fs.write chunk after a small frame queued behind it), so concurrent turns
  // put frames on the wire out of nonce order; the gateway fails to decrypt and drops the connection (1006) with every
  // turn on it. 5 parallel 300 KB uploads were enough to kill a connection, ~36 turns lost per drop.
  _sendChunks(h) {
    const run = this._sendQ.then(async () => {
      for (const c of chunkMessage(h)) {
        const ct = await this.c1.encrypt(new Uint8Array(0), c)
        this.ws.send(ct)
      }
    })
    this._sendQ = run.catch(() => {}) // keep the queue alive after a failed send
    return run
  }
  async sendRequest(streamId, service, appReq) {
    // Set the oneof member directly (encodeMessage has no oneof awareness):
    // ServiceFrame{stream_id, request=ApplicationRequest}.
    const frame = encodeMessage({ stream_id: streamId, request: appReq }, S_FRAME)
    await this._sendChunks(encodeMessage({ service, payload: frame }, S_SREQ))
    return streamId
  }
  // Client-side stream reset (like HTTP/2 RST_STREAM): the gateway caps a connection at ~256 open streams and
  // never ends a /chat/subscribe on its own, so a finished turn must reset its feed or the slot leaks until the
  // gateway answers `reset code=3 too many concurrent streams` and drops the whole connection. Code 8 = cancel.
  async resetStream(streamId, code = 8) {
    const frame = encodeMessage({ stream_id: streamId, reset: { code, reason: new Uint8Array(0) } }, S_FRAME)
    await this._sendChunks(encodeMessage({ service: 0, payload: frame }, S_SREQ))
  }
  // decrypt one wire frame -> NoiseTransportFrame, reassemble by chunk_id.
  async feedFrame(bytes) {
    const pt = await this.c2.decrypt(new Uint8Array(0), bytes)
    const f = decodeMessage(pt, S_CHUNK)
    const id = BigInt.asIntN(64, f.chunk_id)
    let entry = this.pending.get(id)
    if (!entry) { entry = { total: Number(f.total_chunks), got: new Map(), last: Date.now() }; this.pending.set(id, entry) }
    entry.got.set(Number(f.chunk_index), f.payload)
    entry.last = Date.now()
    if (entry.got.size < entry.total) return null
    const parts = []
    for (let i = 0; i < entry.total; i++) parts.push(entry.got.get(i) || new Uint8Array(0))
    this.pending.delete(id)
    const resp = decodeMessage(concat(...parts), S_SRESP)
    const dframe = decodeMessage(resp.payload, S_FRAME)
    return dframe // {stream_id, kind:{case,value}}
  }
}

// ------------------------------------------------------------------ client
// Parse a Next.js RSC "flight" action response into the returned value.
// The result object is referenced by the first line's `a` field (`$@N` -> line N).
export function parseFlightResult(txt) {
  const lines = String(txt).split('\n').filter(Boolean)
  if (!lines.length) throw new Error('empty flight response')
  let ref = '1'
  const m = lines[0].match(/^0:(\{.*\})\s*$/)
  if (m) { try { const a = (JSON.parse(m[1]).a || ''); const mm = a.match(/\$(\d+)/); if (mm) ref = mm[1] } catch {} }
  const line = lines.find((l) => l.startsWith(ref + ':'))
  if (!line) throw new Error('no result line ' + ref)
  return JSON.parse(line.slice(ref.length + 1))
}

// The browser every request shows (without the client hints Cloudflare answers the app origin 403). Defaults to the
// Chromium 153 the shim signs in with; useBrowserIdentity() (from grabCookies) swaps in the one that read the cookies,
// so an account shows Muse one browser from sign-in to chat.
const BROWSER = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Chromium";v="153", "Not_A Brand";v="8"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
}
export function useBrowserIdentity(headers) { Object.assign(BROWSER, headers) }
const clientHints = () => ({
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-prefers-color-scheme': 'light',
  ...BROWSER,
})
const wreqOs = () => ({ '"Windows"': 'windows', '"macOS"': 'macos', '"Android"': 'android' })[BROWSER['sec-ch-ua-platform']] || 'linux'
// Chrome's order for a fetch(), the page's own headers between sec-ch-ua and sec-ch-ua-mobile (wreq sends them as given)
const CHROME_HEAD = ['sec-ch-ua-platform', 'user-agent', 'sec-ch-ua']
const CHROME_TAIL = ['sec-ch-ua-mobile', 'accept', 'origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'referer', 'accept-encoding', 'accept-language', 'cookie', 'priority']
function chromeOrder(headers) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  const pick = (names) => names.filter((n) => n in h).map((n) => [n, h[n]])
  const fixed = new Set([...CHROME_HEAD, ...CHROME_TAIL])
  return [...pick(CHROME_HEAD), ...Object.entries(h).filter(([n]) => !fixed.has(n)), ...pick(CHROME_TAIL)]
}
// Chrome's ClientHello for a WebSocket (http/1.1 only, so no ALPS), spelled out: wreq's Chrome preset would also put its
// navigation headers (Accept: text/html, Sec-Fetch-*, a Chrome 149 sec-ch-ua) on the upgrade request, and tlsOptions
// replace a preset's TLS instead of layering on it. Matches Chrome 149's WS hello (JA4 t13d1515h1_8daaf6152771_0a20fe35d3a5).
const WS_TLS = {
  cipherList: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:' +
    'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:' +
    'ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
  curvesList: 'X25519MLKEM768:X25519:P-256:P-384',
  sigalgsList: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:' +
    'rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512',
  greaseEnabled: true, enableEchGrease: true, permuteExtensions: true, enableOcspStapling: true, enableSignedCertTimestamps: true,
  certificateCompressionAlgorithms: ['brotli'], sessionTicket: true, preSharedKey: true, renegotiation: true,
  preserveTls13CipherList: true, aesHwOverride: true, alpnProtocols: ['HTTP1'], alpsProtocols: [],
}
// A wreq-js WebSocket through the slice of the `ws` API this client uses (message/close/error events, send, close, readyState)
function wreqWs(sock) {
  const listeners = { message: [], close: [], error: [] }
  const emit = (type, ...a) => { for (const f of listeners[type]) f(...a) }
  sock.binaryType = 'nodebuffer'
  sock.onmessage = (ev) => emit('message', ev.data)
  sock.onclose = (ev) => emit('close', ev.code, ev.reason)
  sock.onerror = (ev) => emit('error', new Error(ev.message || 'websocket error'))
  return {
    on(type, f) { listeners[type]?.push(f); return this },
    send: (data) => sock.send(data),
    close: () => sock.close(),
    get readyState() { return sock.readyState },
  }
}
// The client bundle declares each action as createServerReference("<id>", x.callServer, void 0, x.findSourceMapURL, "<name>").
const ACTION_RE = /"([0-9a-f]{40,})"\s*,[^"]{0,160}?"fetchSubscriptionAction"/
const CHUNK_RE = /static\/chunks\/[\w.\-/]+?\.js/g
const ACTION_REFRESH_MS = 10 * 60e3
let actionRefresh = null
let actionRefreshAt = 0
// Find fetchSubscriptionAction's current id in the app's JS. Its chunk loads lazily (the Settings dialog), so walk the
// chunk references out from the signed-in page (24/10: found after 314 public chunks, 27 MB, 7 s, no browser). One walk
// for every account at a time, at most one per ACTION_REFRESH_MS. → true when the id changed.
function refreshSubscriptionAction(client) {
  if (actionRefresh) return actionRefresh
  if (Date.now() - actionRefreshAt < ACTION_REFRESH_MS) return Promise.resolve(false)
  actionRefresh = (async () => {
    const t0 = Date.now()
    const page = await client.http(client.origin + '/', {
      headers: { ...clientHints(), accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', cookie: client.cookieHeader },
      redirect: 'manual',
    })
    if (page.status !== 200) throw new Error(`app page -> ${page.status} (signed out?)`)
    const seen = new Set()
    const queue = []
    const add = (s) => { const u = client.origin + '/_next/' + s; if (!seen.has(u)) { seen.add(u); queue.push(u) } }
    for (const m of (await page.text()).matchAll(CHUNK_RE)) add(m[0])
    while (queue.length && seen.size <= 1500) {
      const batch = queue.splice(0, 16)
      const texts = await Promise.all(batch.map((u) => client.http(u, { headers: BROWSER }).then((r) => (r.ok ? r.text() : '')).catch(() => '')))
      for (const t of texts) {
        const m = t.match(ACTION_RE)
        if (m) {
          const changed = m[1] !== subscriptionActionId
          client.log(`[muse-noise] fetchSubscriptionAction id ${changed ? `${subscriptionActionId} -> ${m[1]}` : 'unchanged'} (${seen.size} chunks, ${Date.now() - t0} ms)`)
          subscriptionActionId = m[1]
          return changed
        }
        for (const r of t.matchAll(CHUNK_RE)) add(r[0])
      }
    }
    throw new Error(`fetchSubscriptionAction not found in ${seen.size} chunks`)
  })().catch((e) => { client.log(`[muse-noise] usage action id refresh failed: ${e.message}`); return false })
    .finally(() => { actionRefresh = null; actionRefreshAt = Date.now() })
  return actionRefresh
}

// Follows one turn on its feed. A turn may post a commentary message first ("I'll open the attached image…",
// metadata.message_kind "commentary") and its answer in a second message: delta.message_done closes each MESSAGE,
// task.status (root agent) closes the TURN. Stopping at the first message_done took the commentary for the reply —
// 12 of 15 schema parse-fails on 23/10, while Muse went on to write (and bill) the real answer nobody read.
// A feed that never showed task.status (joined mid-turn): after a message_done, quiet this long → confirm with the history.
// A feed that did show it waits for the terminal task.status: a commentary can be followed by 45 s of silent image reading.
const DONE_GRACE_MS = Number(process.env.MUSE_DONE_GRACE_MS ?? 15000)
const DEBUG_TURN = process.env.MUSE_DEBUG_TURN === '1' // log every non-delta event of a turn (diagnostics)
const TASK_END = new Set(['completed', 'failed', 'errored', 'cancelled', 'canceled', 'interrupted'])
// An event about THIS session. A feed also carries broadcasts (sessions.updated / tasks.updated of other sessions and
// background jobs) that kept the idle timer alive while the session's own events had stopped: turns sat up to the 30-min
// backstop on sessions Muse had completed 12 minutes earlier (23/10).
function ownEvent(ev, sid) {
  if (!sid) return true
  const pl = ev.payload || {}
  if (pl.session_id) return pl.session_id === sid // a task.status / message of ANOTHER session must not end this turn
  const n = ev.event || ev.event_name || ''
  return n.startsWith('delta.') || n === 'task.status' || n === 'agent.status' // (Muse stamps these with session_id anyway)
}
function turnTracker() {
  let streamed = '', final = null
  return {
    messageDone: false, // at least one message closed (its text is the reply unless another message follows)
    taskEnded: null, // task.status of the root agent once the turn is over
    sawTask: false, // this feed reports task.status: wait for its end instead of guessing from silence
    messageId: null,
    get reply() { return final !== null ? final : streamed },
    set final(v) { final = v; this.messageDone = true },
    // → 'message' (a message closed), 'end' (the turn is over) or null
    feed(ev) {
      const name = ev.event || ev.event_name, pl = ev.payload || {}
      if (name === 'delta.message_start') { streamed = ''; return null }
      if (name === 'delta.text_append') { if (typeof pl.text === 'string') streamed += pl.text; return null }
      if (name === 'delta.message_done') {
        const msgs = (pl.transcript?.messages || []).filter((m) => m.role === 'assistant')
        let t = ''
        for (const c of msgs[msgs.length - 1]?.content || []) if (c.type === 'text' && typeof c.text === 'string') t += c.text
        final = t || streamed
        this.messageDone = true
        this.messageId = pl.message_id || this.messageId
        return 'message'
      }
      if (name === 'task.status' && (!pl.root_agent_id || !pl.agent_id || pl.root_agent_id === pl.agent_id)) {
        this.sawTask = true
        if (TASK_END.has(pl.status)) { this.taskEnded = pl.status; return 'end' }
      }
      return null
    },
  }
}

export class MuseNoiseClient {
  constructor({ cookies, origin = 'https://muse.ai', log = () => {} } = {}) {
    this.cookieHeader = Array.isArray(cookies) ? cookies.map((c) => `${c.name}=${c.value}`).join('; ') : (cookies || '')
    this.origin = origin
    this.log = log
    this.ws = null
    this.transport = null
    this.handlers = new Map() // streamId(string) -> {onFrame, onEnd}
    this._settled = new Set() // streamIds whose handler already finished (ignore benign tails); oldest dropped past 20k
    this._pumping = false
    this.sessions = new Set() // session ids of turns running on this connection ('' = primary), for cancelAll()
    this.closing = false // set by cancelAll(): no new turn starts on this connection
    this._pool = null // wreq-js connection pool of this client (MUSE_TLS=wreq)
  }
  // fetch() for every request of this client: Node's, or wreq-js on this client's own pool so two accounts never share a
  // connection (Node's fetch pools them process-wide). wreq adds no header of its own: Chrome's always-sent ones go here.
  async http(url, init = {}) {
    if (!wreq) return fetch(url, init)
    this._pool ??= wreq.createTransport({ browser: 'chrome', os: wreqOs() })
    const headers = chromeOrder({ 'accept-language': 'en-US,en;q=0.9', ...init.headers, 'accept-encoding': 'gzip, deflate, br, zstd' })
    return wreq.fetch(url, { ...init, headers, transport: await this._pool, disableDefaultHeaders: true })
  }
  async rest(method, path, body) {
    const res = await this.http(this.origin + path, {
      method,
      headers: {
        // Chrome sends content-type and origin only on a non-GET; a bodyless GET that carries either is a tell
        ...(body ? { 'content-type': 'application/json' } : {}),
        cookie: this.cookieHeader,
        ...(method === 'GET' || method === 'HEAD' ? {} : { origin: this.origin }),
        referer: this.origin + '/',
        accept: '*/*',
        ...BROWSER,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        priority: 'u=1, i',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const txt = await res.text()
    let json = null
    try { json = JSON.parse(txt) } catch {}
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${txt.slice(0, 200)}`)
    return json
  }
  // Usage/credits meter via the Next.js RSC server action fetchSubscriptionAction.
  // Plain HTTPS POST to the app origin (no noise WS needed) — only the login cookies.
  // Cloudflare bot-checks the request, so send full browser client-hint headers.
  // 404 "Server action not found" / 409 "Server Action unavailable" (since 27/10, for an id from before the redeploy)
  // = Muse redeployed: look up the new action id once, then read again.
  async usage({ includeAgreement = true } = {}, retried = false) {
    const id = subscriptionActionId
    const res = await this.http(this.origin + '/', {
      method: 'POST',
      headers: {
        ...clientHints(),
        accept: 'text/x-component',
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': id,
        origin: this.origin,
        referer: this.origin + '/',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        cookie: this.cookieHeader,
        priority: 'u=1, i',
      },
      body: JSON.stringify([{ includeAgreement }]),
    })
    const txt = await res.text()
    // another account's read may have found the new id while this one was on the wire
    if ((res.status === 404 || res.status === 409) && /server action (not found|unavailable)/i.test(txt) && !retried
      && (id !== subscriptionActionId || await refreshSubscriptionAction(this))) return this.usage({ includeAgreement }, true)
    if (!res.ok) throw new Error(`usage action -> ${res.status}: ${txt.slice(0, 200)}`)
    const r = parseFlightResult(txt)
    if (!r || !r.success) throw new Error('usage action failed: ' + JSON.stringify((r && r.error) || r).slice(0, 200))
    return r.subscription
  }
  async bootstrap() {
    const auth = await this.rest('POST', '/api/auth/check', {})
    if (!auth || !auth.ok) throw new Error('not logged in (auth/check not ok)')
    const sess = await this.rest('GET', '/api/session')
    const vmId = sess.vm_id
    const endpoint = sess.endpoint_url
    if (!vmId || !endpoint) throw new Error('no vm assigned: ' + JSON.stringify(sess).slice(0, 200))
    const woke = await this.rest('POST', '/api/hatch/vm/wake', { vm_id: vmId }).then(() => null, (e) => e)
    // DISABLED = Meta switched Muse off for the account (muse.ai: "We disconnected Muse to protect your information. Submit
    // a feedback ticket to reconnect"): wake answers 409 "VM wake unavailable" and the WS 502s, every try (31/10/2026)
    if (sess.vm_state === 'DISABLED' && woke) throw vmDisabledError(vmId, woke.message)
    const tok = await this.rest('POST', '/api/hatch/token', { vmAddress: endpoint, vmName: vmId })
    if (!tok || !tok.token) throw new Error('no token: ' + JSON.stringify(tok).slice(0, 200))
    const url = `wss://${LB_HOST}${NOISE_PATH}?vm_id=${encodeURIComponent(vmId)}&auth_token=${encodeURIComponent(tok.token)}&notary_token=${encodeURIComponent(tok.notary_token || '')}&app_id=${APP_ID}&request_id=${crypto.randomUUID()}`
    this.log(`bootstrap ok vm=${vmId} host=${LB_HOST}`)
    return { url, vmId }
  }
  // The account's VM as /api/session reports it (plain HTTPS with the login cookies, no connection): RUNNING, DISABLED, …
  async vmState() {
    const sess = await this.rest('GET', '/api/session')
    return { vmId: (sess && sess.vm_id) || null, state: (sess && sess.vm_state) || null }
  }
  async connect() {
    const { url } = await this.bootstrap()
    const ws = await new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('ws open timeout')), 15000)
      if (wreq) {
        // Chrome's upgrade request, in its order (no client hints on a WS handshake)
        const headers = [['Pragma', 'no-cache'], ['Cache-Control', 'no-cache'], ['User-Agent', BROWSER['user-agent']], ['Origin', this.origin],
          ['Accept-Encoding', 'gzip, deflate, br, zstd'], ['Accept-Language', 'en-US,en;q=0.9'], ['Cookie', this.cookieHeader]]
        wreq.websocket(url, { emulation: { tlsOptions: WS_TLS }, headers }).then((s) => resolve(wreqWs(s)), reject)
        return
      }
      const w = new WebSocket(url, { headers: { origin: this.origin, 'user-agent': BROWSER['user-agent'], cookie: this.cookieHeader } }) // Chrome sends no client hints on a WS handshake
      w.on('open', () => resolve(w))
      w.on('error', reject)
    })
    this.ws = ws
    await this._handshake(ws)
    this.lastFrameAt = Date.now()
    this._startPump()
    return true
  }
  async _handshake(ws) {
    const noise = new NoiseXX()
    noise.s = new SymmetricState()
    await noise.s.initialize()
    const msg1 = await noise.writeMessage1()
    const recv = _frameReader(ws, this.log)
    this.log('send msg1 len', msg1.length)
    ws.send(msg1)
    const msg2 = await recv.next()
    this.log('recv msg2 len', msg2 && msg2.length)
    const m2payload = await noise.readMessage2(msg2)
    this.log('msg2 payload len', m2payload.length, 'remote static', Buffer.from(noise.remoteStatic).toString('hex').slice(0, 24))
    const msg3 = await noise.writeMessage3()
    this.log('send msg3 len', msg3.length)
    ws.send(msg3)
    const [c1, c2] = await noise.split()
    this.transport = new NoiseTransport(c1, c2)
    this.transport.ws = ws
    this._recv = recv
    this.log('noise handshake complete')
  }
  // Central frame pump: decrypt each wire frame, reassemble chunks, dispatch by stream_id.
  _startPump() {
    this._pumping = true
    this._settled.clear() // fresh connection → stream ids restart; drop stale settled keys
    ;(async () => {
      while (this._pumping) {
        const raw = await this._recv.next(0)
        if (raw === null || !this._pumping || !this.transport) break
        this.lastFrameAt = Date.now()
        let frame = null
        try { frame = await this.transport.feedFrame(raw) } catch (e) { this.log('feedFrame error:', e.message, 'len', raw.length); continue }
        if (!frame) continue
        const key = String(BigInt(frame.stream_id))
        const h = this.handlers.get(key)
        if (h) { try { h.onFrame(frame) } catch (e) { this.log('handler error:', e.message) } }
        else if (this._settled.has(key)) { /* stream already finished — ignore benign trailing body_chunk/response */ }
        else this.log('unhandled frame stream', key, 'kind', frame.kind && frame.kind.case)
      }
      this._pumpEnded = true // from here a new request would never be answered: request()/chatSubscribe() fail fast
      for (const [, h] of this.handlers) { try { h.onEnd && h.onEnd() } catch {} }
    })()
  }
  // Remember a finished stream so its late frames are ignored quietly — an ack we stopped waiting for (reset: false) still
  // answers later. Drop the OLDEST past 20k: clearing the whole set at 1k (busy minutes) logged those as "unhandled frame".
  _settle(key) {
    this._settled.add(key)
    if (this._settled.size > 20000) this._settled.delete(this._settled.values().next().value)
  }
  // The connection can still carry a request: open socket and a live frame pump. After a drop the pump has ended, so a
  // request sent then got no onEnd and hung to its timeout (every `request timeout POST /fs/write` came ~60 s after a drop).
  _live() { return !!(this.transport && this.ws && this.ws.readyState === 1 && this._pumping && !this._pumpEnded) }
  // Reset a stream we no longer read (best effort: a dead connection already freed it).
  _reset(streamId) {
    const t = this.transport
    if (!t || !t.ws || t.ws.readyState !== 1) return
    t.resetStream(streamId).catch((e) => this.log('reset error:', e.message))
  }
  // Allocate a stream, send the request frame (fire-and-forget), return the stream id.
  _send(method, path, bodyObj, { service = 0, headers = [] } = {}) {
    const streamId = this.transport.allocStream()
    const hasBody = !(bodyObj === undefined || bodyObj === null)
    const bodyBytes = hasBody ? (typeof bodyObj === 'string' ? utf8(bodyObj) : Buffer.from(JSON.stringify(bodyObj))) : new Uint8Array(0)
    // The gateway requires Content-Type on body-bearing requests (else 415).
    const hdrs = [...headers]
    if (hasBody && !hdrs.some((h) => Buffer.from(h.key).toString('utf8').toLowerCase() === 'content-type'))
      hdrs.push({ key: 'content-type', value: 'application/json' })
    const appReq = { verb: method, path, headers: hdrs, body: bodyBytes, end_body: true }
    this.transport.sendRequest(streamId, service, appReq).catch((e) => this.log('send error:', e.message))
    return streamId
  }
  // Unary request: resolve {status, headers, body} once end_body arrives.
  // `reset: false` keeps the stream open on the server when we stop waiting (the ack of a turn: resetting it can stop
  // Muse from starting the turn we are about to follow)
  request(method, path, { body, service = 0, headers = [], timeoutMs = 60000, reset = true } = {}) {
    if (!this.transport) return Promise.reject(new Error('not connected'))
    if (!this._live()) return Promise.reject(new Error('stream closed before response'))
    const streamId = this._send(method, path, body, { service, headers })
    const key = String(streamId)
    return new Promise((resolve, reject) => {
      const EMPTY_BODY_GRACE_MS = Number(process.env.MUSE_EMPTY_BODY_GRACE_MS ?? 1200)
      let status = null, respHeaders = [], settled = false
      const bodyParts = []
      let grace = null
      const finish = (err) => {
        if (settled) return; settled = true
        clearTimeout(timer); if (grace) clearTimeout(grace)
        this.handlers.delete(key)
        this._settle(key)
        if (err) reject(err)
        else resolve({ status, headers: respHeaders, body: Buffer.from(concat(...(bodyParts.length ? bodyParts : [new Uint8Array(0)]))) })
      }
      const timer = setTimeout(() => { this.lastTimeoutAt = Date.now(); if (reset) this._reset(streamId); finish(new Error(`request timeout ${method} ${path}`)) }, timeoutMs)
      this.handlers.set(key, {
        onFrame: (frame) => {
          const kind = frame.kind
          if (!kind) return
          if (kind.case === 'reset') { const r = kind.value; finish(new Error(`reset code=${Number(r.code)} reason=${Buffer.from(r.reason || new Uint8Array(0)).toString('utf8')}`)); return }
          if (kind.case === 'response') {
            status = Number(kind.value.status); respHeaders = kind.value.headers || []
            if (kind.value.body?.length) bodyParts.push(kind.value.body)
            // Don't resolve on an empty-body `response` if the JSON may still arrive as a
            // trailing body_chunk — give it a short grace, then finish with what we have.
            if (kind.value.end_body) { if (bodyParts.length) finish(); else grace = setTimeout(finish, EMPTY_BODY_GRACE_MS) }
          }
          else if (kind.case === 'body_chunk') { if (kind.value.data?.length) bodyParts.push(kind.value.data); if (kind.value.end_body) { if (status === null) status = 200; finish() } }
        },
        onEnd: () => { if (status === null) finish(new Error('stream closed before response')); else finish() },
      })
    })
  }
  async chatHistory(max = 50) {
    const r = await this.request('GET', `/chat/history?limit=${max}`)
    let json = null
    try { json = JSON.parse(r.body.toString('utf8')) } catch {}
    return { status: r.status, json, raw: r.body.toString('utf8').slice(0, 4000) }
  }
  // Enumerate chats/sessions shown in the sidebar.
  async listSessions() {
    const r = await this.request('GET', '/api/session/list')
    let json = null
    try { json = JSON.parse(r.body.toString('utf8')) } catch {}
    return { status: r.status, json, raw: r.body.toString('utf8').slice(0, 4000) }
  }
  // Write bytes to a VM workspace path (chunked base64 for files > 512 KiB).
  async fsWrite(path, bytes, { createParent = true } = {}) {
    const CH = 524288
    const wp = wsPath(path)
    if (bytes.length <= CH) {
      return this.request('POST', '/fs/write', { body: { path: wp, data_base64: Buffer.from(bytes).toString('base64'), overwrite: true, append: false, create_parent: createParent } })
    }
    let last = null
    for (let i = 0; i < bytes.length; i += CH) {
      const slice = bytes.subarray(i, Math.min(i + CH, bytes.length))
      last = await this.request('POST', '/fs/write', { body: { path: wp, data_base64: Buffer.from(slice).toString('base64'), overwrite: i === 0, append: i !== 0, create_parent: i === 0 ? createParent : false } })
      if (last.status && last.status >= 400) return last
    }
    return last
  }
  // Fetch a raw workspace file (generated media, uploaded attachments) as bytes.
  async fsRaw(path) {
    return this.request('GET', `/fs/raw/${wsPath(path)}`, { timeoutMs: 120000 })
  }
  // Upload an attachment into the workspace; returns the sandbox:// path.
  async uploadAttachment(bytes, filename, mime = 'application/octet-stream') {
    const safe = String(filename || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'file'
    const dot = safe.lastIndexOf('.')
    const base = dot > 0 ? safe.slice(0, dot) : safe
    const ext = dot > 0 ? safe.slice(dot) : ''
    const uploadPath = `workspace/user/files/${base}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`
    const r = await this.fsWrite(uploadPath, bytes, { createParent: true })
    if (r.status && r.status >= 400) throw new Error(`fs.write ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`)
    return { path: uploadPath, uri: `sandbox://${uploadPath}`, mime }
  }
  // Open the persistent chat subscription; parsed NDJSON events are queued for nextEvent().
  chatSubscribe({ capabilities = DEFAULT_CAPS, sessionId = null } = {}) {
    const body = { capabilities }
    if (sessionId) body.session_id = sessionId
    const live = this._live()
    const streamId = live ? this._send('POST', '/chat/subscribe', body) : null
    const key = String(streamId)
    const q = []
    let notify = null
    const state = { status: null, buf: new Uint8Array(0), closed: !live, error: null } // dead connection: a closed feed
    const wake = () => { if (notify) { const n = notify; notify = null; n() } }
    const drainLines = () => {
      let nl
      while ((nl = state.buf.indexOf(0x0a)) >= 0) {
        const line = state.buf.subarray(0, nl); state.buf = state.buf.subarray(nl + 1)
        const s = Buffer.from(line).toString('utf8').trim()
        if (!s) continue
        let ev = null; try { ev = JSON.parse(s) } catch { ev = { _raw: s } }
        q.push(ev); wake()
      }
    }
    if (live) this.handlers.set(key, {
      onFrame: (frame) => {
        const kind = frame.kind; if (!kind) return
        if (kind.case === 'reset') { state.error = new Error(`subscribe reset code=${Number(kind.value.code)} reason=${Buffer.from(kind.value.reason || new Uint8Array(0)).toString('utf8')}`); state.closed = true; wake(); return }
        if (kind.case === 'response') { state.status = Number(kind.value.status); if (kind.value.body?.length) { state.buf = concat(state.buf, kind.value.body); drainLines() } }
        else if (kind.case === 'body_chunk') { if (kind.value.data?.length) { state.buf = concat(state.buf, kind.value.data); drainLines() } }
      },
      onEnd: () => { drainLines(); state.closed = true; wake() },
    })
    return {
      streamId,
      getStatus: () => state.status,
      getError: () => state.error,
      isClosed: () => state.closed,
      async nextEvent(timeoutMs = 0) {
        if (q.length) return q.shift()
        if (state.closed || state.error) return null
        return new Promise((resolve) => {
          const done = () => { notify = null; resolve(q.length ? q.shift() : null) }
          notify = done
          if (timeoutMs) setTimeout(() => { if (notify === done) done() }, timeoutMs)
        })
      },
      stop: () => {
        if (!this.handlers.has(key)) return
        this.handlers.delete(key); this._settle(key)
        if (!state.closed) this._reset(streamId)
      },
    }
  }
  // Full turn. newSession=true creates a brand-new side chat (thread): we send
  // FIRST (which materializes the session server-side), THEN subscribe — the
  // reverse order yields zero events for a not-yet-existing session.
  // Retries transient failures (ack `request timeout`, stalled stream) with a fresh
  // session per attempt. Env: MUSE_RETRY (default 2 retries), MUSE_RETRY_BACKOFF_MS (2000),
  // MUSE_STALL_FIRST_MS (180000: no event at all after the ack), MUSE_STALL_IDLE_MS (120000: gap between events).
  async chat(prompt, opts = {}) {
    const retries = Number(process.env.MUSE_RETRY ?? 2)
    const backoff = Number(process.env.MUSE_RETRY_BACKOFF_MS ?? 2000)
    for (let attempt = 0; ; attempt++) {
      try { return await this._chatOnce(prompt, opts) }
      catch (e) {
        if (e.aborted) throw e
        if (e.stalled && e.sessionId) {
          // a side session that went quiet: ask Muse (task.status snapshot on a fresh feed). Finished → its reply from the
          // history; still running → keep following it (once); otherwise cancel it so it stops running (and billing) on
          // Muse and hand the turn to another account — rerunning it on this VM fed the VM's queue (sota 23/10)
          const ts = await this.taskState(e.sessionId).catch(() => null)
          let done = null
          if (ts === 'completed') done = await this.sessionState(e.sessionId).then((st) => st.reply, () => null)
          if (done !== null) {
            this.log(`stalled session ${e.sessionId.slice(0, 8)} had finished: reply taken from its history`)
            if (isMuseSorry(done)) throw museSorryError(done, e.sessionId)
            return { ack: null, events: [], reply: done, replyReady: true, sessionId: e.sessionId, recovered: 'history' }
          }
          if (ts === 'running' && !e.fromResume && !(opts.signal && opts.signal.aborted)) {
            this.log(`stalled session ${e.sessionId.slice(0, 8)} is still running per Muse: following it`)
            let r
            try { r = await this.resumeTurn(e.sessionId, { signal: opts.signal }) }
            catch (re) {
              if (!re.aborted) { const ok = await this.cancel(e.sessionId).catch(() => false); this.log(`following ${e.sessionId.slice(0, 8)} failed (${re.message}); cancelled → ${ok}`) }
              re.noRetry = true // fail over; the connection is not to blame
              throw re
            }
            if (isMuseSorry(r.reply)) throw museSorryError(r.reply, e.sessionId)
            return { ack: null, events: [], reply: r.reply, replyReady: true, sessionId: e.sessionId, recovered: 'resume' }
          }
          if (ts && TASK_END.has(ts) && ts !== 'completed') { const se = new Error(`session ${ts}`); se.sessionStatus = ts; se.noRetry = true; throw se }
          if (ts === null && !e.fromResume) {
            // Muse could not even be asked on this connection: suspect the connection, not the session — resume it on a
            // fresh one (the caller closes this one) instead of cancelling an answer that may be done
            const ce = new Error(`${e.message}; no task.status on this connection — resuming on a fresh one`)
            ce.resumeSessionId = e.sessionId
            throw ce
          }
          const ok = await this.cancel(e.sessionId).catch(() => false)
          this.log(`stalled session ${e.sessionId.slice(0, 8)} cancelled → ${ok}`)
          e.noRetry = true
          throw e
        }
        const retryable = e.stalled || /^request timeout POST \/chat\/stream/.test(e.message || '')
        if (!retryable) throw e
        // an ack timeout on a reused session may have been delivered: only auto-retry fresh sessions or stalls before any event
        if (attempt >= retries || !(opts.newSession || e.stalled || !sessionIdReused(opts))) { e.noRetry = true; e.attempts = attempt + 1; throw e }
        await new Promise(r => setTimeout(r, backoff * (attempt + 1) + Math.random() * 500))
        if (opts.onRetry) try { opts.onRetry(attempt + 1, e) } catch {}
      }
    }
  }
  // Stop the turn running on Muse (the composer's stop button). Body = {session_id} for a side thread,
  // {} for the primary session; the reply is {cancelled: bool}.
  // Muse can refuse the turn at the ack (23/10: `500 failed to resolve session_id` — no session is ever created); taking that
  // as accepted waited 180 s for a first event and 180 s more resuming a session that does not exist before failing over.
  _ackOk(ack, sid) {
    if (!ack || ack.status < 300) return
    const e = new Error(`chat.stream ${ack.status}: ${Buffer.from(ack.body || '').toString('utf8').slice(0, 200)}`)
    e.noRetry = true // another account takes the turn; this connection is fine
    e.ackRejected = true
    if (sid) e.sessionId = sid
    throw e
  }
  async cancel(sessionId = null) {
    const r = await this.request('POST', '/chat/cancel', { body: sessionId ? { session_id: sessionId } : {}, timeoutMs: 15000 })
    let json = null
    try { json = JSON.parse(r.body.toString('utf8')) } catch {}
    if (r.status !== 200) throw new Error(`chat.cancel ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`)
    return !!(json && (json.cancelled ?? (json.result && json.result.cancelled)))
  }
  // Cancel every turn still running on this connection (shim shutdown/restart): Muse keeps running a turn whose
  // connection closed and bills it to the end, while nobody can collect the reply any more.
  async cancelAll(timeoutMs = 15000) {
    this.closing = true
    const sids = [...this.sessions]
    const res = await Promise.all(sids.map((sid) => Promise.race([
      this.cancel(sid || null).then((ok) => (ok ? 'cancelled' : 'not running'), (e) => 'error: ' + e.message),
      new Promise((r) => setTimeout(() => r('timeout'), timeoutMs).unref()),
    ])))
    return sids.map((sid, i) => ({ sessionId: sid || null, result: res[i] }))
  }
  async _chatOnce(prompt, opts = {}) {
    if (this.closing) throw abortedError() // shutting down: do not start a turn cancelAll() would miss
    const sid = opts.newSession ? crypto.randomUUID() : (opts.sessionId || null)
    const key = sid || ''
    this.sessions.add(key)
    try { return await this._chatTurn(prompt, { ...opts, sid }) } finally { this.sessions.delete(key) }
  }
  async _chatTurn(prompt, { nodeId = crypto.randomUUID(), timeoutMs = 120000, onEvent, attachments = [], sid = null, newSession = false, signal = null } = {}) {
    if (signal && signal.aborted) throw abortedError()
    let text = prompt
    for (const a of attachments) { const alt = String(a.name || '').replace(/[\]\[]/g, ''); text += `\n![${alt}](${a.uri})` }
    const body = { items: [{ type: 'text', text }], node_id: nodeId, capabilities: DEFAULT_CAPS }
    if (sid) body.session_id = sid
    let ack, sub
    const ackMs = Number(process.env.MUSE_ACK_TIMEOUT_MS ?? 30000)
    if (newSession) {
      try { ack = await this.request('POST', '/chat/stream', { body, timeoutMs: ackMs, reset: false }); this._ackOk(ack, sid) }
      catch (e) {
        // no ack in time: on a busy VM the turn is queued, not lost — follow its session (the stall window below still
        // bounds the wait) instead of starting a second session while the first one runs and bills anyway
        if (!/^request timeout/.test(e.message || '')) throw e
        this.log(`no ack for session ${sid.slice(0, 8)} in ${Math.round(ackMs / 1000)} s — following it instead of resending`)
        const stallFirstMs = Number(process.env.MUSE_STALL_FIRST_MS ?? 180000)
        const r = await this.resumeTurn(sid, { signal, stallMs: stallFirstMs })
        if (isMuseSorry(r.reply)) throw museSorryError(r.reply, sid)
        return { ack: null, events: [], reply: r.reply, replyReady: true, assistantMessageId: null, sessionId: sid }
      }
      sub = this.chatSubscribe({ sessionId: sid })
    } else {
      sub = this.chatSubscribe({ sessionId: sid })
      try { ack = await this.request('POST', '/chat/stream', { body, timeoutMs: ackMs }); this._ackOk(ack, sid) } catch (e) { sub.stop(); throw e }
    }
    const events = []
    const backstop = Date.now() + Number(process.env.MUSE_MAX_TURN_MS ?? 1800000) // absolute ceiling (max total turn)
    const stallFirst = Number(process.env.MUSE_STALL_FIRST_MS ?? 180000), stallIdle = Number(process.env.MUSE_STALL_IDLE_MS ?? 120000)
    const idleAfterFirst = timeoutMs && timeoutMs > 0 ? timeoutMs : stallIdle // timeoutMs now = idle gap between events
    let lastEv = Date.now()
    let idleWindow = stallFirst // sliding: tolerated silence; extends as long as events keep arriving
    const tr = turnTracker()
    let replyReady = false, ownCount = 0, lastQuiet = 0
    const quietMemo = {}
    const stalled = () => {
      sub.stop()
      const e = new Error(`stalled: no event for ${Math.round((Date.now() - lastEv) / 1000)}s (${ownCount} events so far)`)
      e.stalled = true
      if (sid) e.sessionId = sid
      return e
    }
    while (Date.now() < backstop) {
      if (signal && signal.aborted) {
        // caller is gone: stop Muse generating instead of letting it burn quota to the end
        sub.stop()
        const cancelled = await this.cancel(sid).catch((e) => { this.log('chat.cancel failed:', e.message); return false })
        this.log('turn aborted by caller; chat.cancel', sid || 'primary', '→', cancelled)
        throw abortedError()
      }
      const ev = await sub.nextEvent(Math.max(50, Math.min(idleWindow - (Date.now() - lastEv), backstop - Date.now(), 5000)))
      if (ev === null && (sub.isClosed() || sub.getError())) break
      if (ev) {
        events.push(ev)
        if (ownEvent(ev, sid)) {
          if (onEvent) onEvent(ev)
          if (DEBUG_TURN) { const n = ev.event || ev.event_name; if (n !== 'delta.text_append') this.log(`turn ${String(sid).slice(0, 8)} ev ${n} ${n === 'task.status' ? ev.payload?.status : ''}`) }
          idleWindow = ownCount ? idleAfterFirst : stallFirst // slide the idle window on the session's own events only
          lastEv = Date.now()
          ownCount++
          if (tr.feed(ev) === 'end') {
            // task.status can overtake the last message's deltas (a 3.7k-char JSON came back cut mid-string): read on until
            // that message closes, then ask the history, and only then decide
            const until = Date.now() + 30000
            while (!tr.messageDone && Date.now() < until) {
              const more = await sub.nextEvent(Math.max(50, until - Date.now()))
              if (!more) break
              events.push(more)
              if (!ownEvent(more, sid)) continue
              if (onEvent) onEvent(more)
              tr.feed(more)
            }
            if (!tr.messageDone && sid) {
              const st = await this.sessionState(sid).catch((e) => (e.sessionStatus ? { err: e } : null))
              if (st?.err) throw st.err // Muse errored / interrupted the session: noRetry, the turn fails over
              if (st && st.reply !== null) tr.final = st.reply
            }
            if (!tr.messageDone) {
              // Muse closed the task with no reply at all (a session `errored` at birth): an error, not an empty answer
              this.log(`turn ${String(sid || 'primary').slice(0, 8)} ended (${tr.taskEnded}) without a reply after ${events.length} events`)
              const e = new Error(`Muse ended the turn (${tr.taskEnded}) without a reply`)
              e.noRetry = true
              e.museError = true
              throw e
            }
            replyReady = true
            break
          }
          continue
        }
      }
      // nothing from this session lately (null, or another session's / a job's broadcast): the quiet checks run either way
      if (tr.messageDone && !tr.sawTask && Date.now() - lastEv > DONE_GRACE_MS) {
        // no task.status on this feed: Muse says whether that message was the answer or a commentary
        let done = null, unknown = !sid
        if (sid) { try { done = await this.finishedReply(sid) } catch (e) { if (e.sessionStatus) throw e; unknown = true } }
        if (unknown) { replyReady = true; break } // primary session / Muse unreadable: take what the feed gave
        if (done !== null) { tr.final = done; replyReady = true; break }
        lastEv = Date.now() // the turn still runs: wait another grace
        continue
      }
      if (sid && ownCount && Date.now() - lastEv >= 30000 && Date.now() - lastQuiet >= 30000) {
        lastQuiet = Date.now()
        const done = await this.quietCheck(sid, quietMemo)
        if (done !== null) { this.log(`turn ${sid.slice(0, 8)}: feed quiet, Muse says done — reply from its history`); tr.final = done; replyReady = true; break }
      }
      if (Date.now() - lastEv > idleWindow) throw stalled()
    }
    const reply = tr.reply, assistantMessageId = tr.messageId
    sub.stop()
    if (!replyReady && (sub.isClosed() || sub.getError())) {
      // the connection dropped mid-turn: Muse keeps running the session, so the caller picks it up on a fresh connection
      // (resumeTurn) instead of taking the cut-off text as the reply — that failed the schema check and re-ran the turn
      // while the first run went on, billed, for nobody (~100 such per 40 min on 23/10)
      const why = sub.getError() ? ` (${sub.getError().message})` : ''
      const e = new Error(`stream closed mid-turn after ${events.length} events${why}`)
      if (sid) e.resumeSessionId = sid
      throw e
    }
    if (isMuseSorry(reply)) throw museSorryError(reply, sid)
    return { ack, events, reply, replyReady, assistantMessageId, sessionId: sid }
  }
  // Final reply of a side session from its history, or null while it is still running. Mid-stream the history already
  // holds a partial `message.assistant` (payload.metadata.streaming) — only payload.status "completed" marks it done.
  // Muse's own word on whether a turn is over: a fresh feed opens with a task.status snapshot (running / completed), and
  // shows nothing while the session does not exist. The history alone cannot tell: the finished FIRST message of a
  // two-message answer ("Mình sẽ xem ảnh…" then the JSON) reads like a complete reply.
  async taskState(sid, waitMs = 5000) {
    const sub = this.chatSubscribe({ sessionId: sid })
    try {
      const until = Date.now() + waitMs
      while (Date.now() < until) {
        const ev = await sub.nextEvent(Math.max(50, until - Date.now()))
        if (!ev) break
        const pl = ev.payload || {}
        if ((ev.event || ev.event_name) === 'task.status' && ownEvent(ev, sid) && (!pl.root_agent_id || !pl.agent_id || pl.root_agent_id === pl.agent_id)) return pl.status || null
      }
      return null
    } finally {
      sub.stop()
    }
  }
  // A turn whose feed went quiet: ask Muse directly instead of trusting the feed (23/10: a feed showed `running`, then lost
  // the session's events — 7 sessions completed with their replies while their resumes waited 180 s). A fresh task.status
  // snapshot decides; when even that is unreadable, a history reply that reads the same twice (memo.prev) is taken.
  // → reply (done) | null (running / unknown); throws (noRetry) when Muse ended the session otherwise.
  async quietCheck(sid, memo) {
    const ts = await this.taskState(sid).catch(() => null)
    if (ts === 'completed') {
      const st = await this.sessionState(sid).catch((e) => { if (e.sessionStatus) throw e; return null })
      if (st && st.reply !== null) return st.reply
    } else if (ts && TASK_END.has(ts)) {
      const e = new Error(`session ${ts}`); e.sessionStatus = ts; e.noRetry = true; throw e
    } else if (ts === null) {
      let st = null
      try { st = await this.sessionState(sid); memo.fails = 0 } catch (e) { if (e.sessionStatus) throw e; memo.fails = (memo.fails || 0) + 1 }
      if (st && st.reply !== null && st.reply === memo.prev) return st.reply
      memo.prev = st ? st.reply : undefined
    }
    return null
  }
  // Reply of a turn Muse has closed, from its history; null while it still runs (or does not exist). Throws (noRetry)
  // when Muse ended it otherwise.
  async finishedReply(sid) {
    const ts = await this.taskState(sid)
    if (!ts || !TASK_END.has(ts)) return null
    if (ts !== 'completed') { const e = new Error(`session ${ts}`); e.sessionStatus = ts; e.noRetry = true; throw e }
    return (await this.sessionState(sid)).reply
  }
  // {exists: Muse has the session (its user message), reply: final text or null while running}; throws (noRetry) when
  // Muse ended it otherwise (errored / interrupted)
  async sessionState(sid) {
    const r = await this.request('GET', `/chat/history?limit=10&session_id=${encodeURIComponent(sid)}`, { timeoutMs: 30000 })
    if (r.status === 404) return { exists: false, reply: null } // Muse has not created the session (yet)
    if (r.status !== 200) throw new Error(`chat.history ${r.status}`)
    const evs = JSON.parse(r.body.toString('utf8')).result?.chat_events || []
    const kind = (e) => e.event_name || e.event
    const last = evs.filter((e) => kind(e) === 'message.assistant').pop()
    const st = last?.payload?.status
    if (st && st !== 'completed') { const e = new Error(`session ${st}`); e.sessionStatus = st; e.noRetry = true; throw e }
    // a closing commentary ("I'll open the attached image…") means the answer is still to come
    const answered = st && last.payload?.metadata?.message_kind !== 'commentary'
    return { exists: evs.some((e) => kind(e) === 'message.user'), reply: answered ? String(last.payload.content ?? last.display_text ?? '') : null }
  }
  // Pick up a turn whose connection dropped: subscribe to its session on this (fresh) connection and wait for
  // message_done — its transcript carries the whole reply even though the deltas sent while we were away are gone —
  // and read the history every 30 s, which has the reply if the session finished before we resubscribed.
  async resumeTurn(sid, { signal = null, stallMs = Number(process.env.MUSE_STALL_FIRST_MS ?? 180000), maxMs = Number(process.env.MUSE_MAX_TURN_MS ?? 1800000) } = {}) {
    if (this.closing) throw abortedError()
    this.sessions.add(sid)
    let sub = this.chatSubscribe({ sessionId: sid })
    const tr = turnTracker()
    try {
      const t0 = Date.now()
      let lastEv = Date.now(), lastProbe = Date.now(), lastHist = Date.now(), own = 0
      const memo = {}
      while (Date.now() - t0 < maxMs) {
        if (signal && signal.aborted) {
          await this.cancel(sid).catch(() => false)
          throw abortedError()
        }
        const ev = await sub.nextEvent(5000)
        if (ev === null && (sub.isClosed() || sub.getError())) { const e = new Error('stream closed while resuming'); e.resumeSessionId = sid; throw e }
        if (ev && ownEvent(ev, sid)) {
          lastEv = Date.now()
          own++
          if (tr.feed(ev) === 'end') {
            if (tr.messageDone) return { reply: tr.reply, replyReady: true, sessionId: sid, via: 'stream' }
            // we joined after the answer (the snapshot already says the task is over): its last message is in the history
            if (tr.taskEnded !== 'completed') { const e = new Error(`session ${tr.taskEnded}`); e.sessionStatus = tr.taskEnded; e.noRetry = true; throw e }
            let st = null
            for (let k = 0; k < 3 && !st; k++) {
              try { st = await this.sessionState(sid) } catch (e) { if (e.sessionStatus) throw e; this.log(`resume ${sid.slice(0, 8)}: history read failed (${e.message})`); await new Promise((r) => setTimeout(r, 2000 * (k + 1))) }
            }
            if (st && st.reply !== null) return { reply: st.reply, replyReady: true, sessionId: sid, via: 'history' }
            const e = new Error(st ? 'Muse ended the turn without a reply' : 'resume: history unreadable after the turn ended')
            e.noRetry = !!st
            throw e
          }
          continue
        }
        // nothing from this session lately (null, or a broadcast about other sessions / jobs): the quiet checks run either way.
        // The stall check comes FIRST: each pass (5 s wait + quietCheck) outlasts the 10-s reopen, and a reopen that
        // `continue`d before it skipped the stall check for good — resumes on sessions Muse never had looped to the 30-min cap
        if (Date.now() - lastEv > stallMs) { const e = new Error(`resume stalled: no event for ${Math.round(stallMs / 1000)}s`); e.stalled = true; e.sessionId = sid; e.fromResume = true; throw e }
        // the feed has said nothing about this session for 20 s (23/10: a feed on a session Muse had interrupted stayed
        // silent 180 s while the connection served other turns): ask the history every 10 s — an interrupted / errored
        // session fails over now, and an answer that reads the same twice is taken (both messages of a two-message
        // answer land within seconds)
        if (Date.now() - lastEv >= 20000 && Date.now() - lastHist >= 10000) {
          lastHist = Date.now()
          const done = await this.quietCheck(sid, memo)
          if (done !== null) return { reply: done, replyReady: true, sessionId: sid, via: 'history' }
          // feed silent AND reads unanswered: the connection is the problem (23/10 pedropereira: 3 sessions completed
          // with their replies while the resume waited 180 s on it) — have the caller resume on a fresh connection
          if (memo.fails >= 2 && !own) { const ce = new Error('connection unresponsive while resuming'); ce.resumeSessionId = sid; throw ce }
        }
        // no task.status yet: the feed was opened before Muse created the session — reopen it every 10 s, a feed on an
        // existing session starts with the task.status snapshot (running / completed)
        if (!tr.sawTask && Date.now() - lastProbe >= 10000) { lastProbe = Date.now(); sub.stop(); sub = this.chatSubscribe({ sessionId: sid }) }
        if (tr.messageDone && !tr.sawTask && Date.now() - lastEv > DONE_GRACE_MS) return { reply: tr.reply, replyReady: true, sessionId: sid, via: 'stream' } // Muse sends no task.status here
      }
      const e = new Error('resume: turn ran past MUSE_MAX_TURN_MS'); e.stalled = true; e.sessionId = sid; e.fromResume = true; throw e
    } finally {
      sub.stop()
      this.sessions.delete(sid)
    }
  }
  close() {
    this._pumping = false; try { this.ws?.close() } catch {} this.ws = null; this.transport = null
    this._pool?.then((t) => t.close()).catch(() => {}); this._pool = null
  }
}

// Reads binary WS frames as they arrive; next() returns the next complete frame.
function _frameReader(ws, log = () => {}) {
  const q = []
  let resolveNext = null, closed = false
  const debugFrames = process.env.MUSE_DEBUG_WS === '1' // per-frame trace: ~100 lines/s while a reply streams
  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? new Uint8Array(data) : new Uint8Array(data)
    if (debugFrames) log('WS msg len', buf.length)
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(buf) }
    else q.push(buf)
  })
  ws.on('close', (code, reason) => { closed = true; log('WS close', code, String(reason || '')); if (resolveNext) { const r = resolveNext; resolveNext = null; r(null) } })
  ws.on('error', (e) => { closed = true; log('WS error', e.message) })
  return {
    next(timeoutMs = 0) {
      if (q.length) return Promise.resolve(q.shift())
      if (closed) return Promise.resolve(null)
      return new Promise((resolve) => {
        resolveNext = resolve
        if (timeoutMs) setTimeout(() => { if (resolveNext === resolve) { resolveNext = null; resolve(null) } }, timeoutMs)
      })
    },
  }
}

// ------------------------------------------------------------------ standalone
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
  // Quick smoke: needs cookies from a logged-in profile (see tools/noise-chat.mjs).
  const cookies = process.env.MUSE_COOKIES || ''
  const prompt = process.argv[2] || 'Say hello in exactly three words.'
  const client = new MuseNoiseClient({ cookies, log: (...a) => console.error('[noise]', ...a) })
  client.connect().then(async () => {
    const h = await client.chatHistory()
    console.error('[noise] chat.history status', h.status)
    const r = await client.chat(prompt, { timeoutMs: 120000 })
    console.error('[noise] events:', r.events.length, 'replyReady:', r.replyReady)
    console.log(r.reply)
    client.close()
    process.exit(0)
  }).catch((e) => { console.error('[noise] fatal', e.message); process.exit(1) })
}

// Muse answers with this canned text when its backend fails; surface it as an error.
const SORRY_RE = /^\s*Sorry, I ran into a problem while responding\.?\s*Please try again\.?\s*$/i
export function isMuseSorry(text) { return SORRY_RE.test(String(text || '')) }
export function museSorryError(text, sessionId) {
  const e = new Error(String(text).trim())
  e.noRetry = true
  e.museError = true
  if (sessionId) e.sessionId = sessionId
  return e
}
export function abortedError() {
  const e = new Error('aborted: client disconnected')
  e.aborted = true
  e.noRetry = true
  return e
}
export function vmDisabledError(vmId, detail) {
  const e = new Error(`Muse disconnected by Meta (VM ${String(vmId).slice(0, 8)} DISABLED${detail ? `; ${String(detail).slice(0, 120)}` : ''}) — muse.ai asks for a feedback ticket to reconnect`)
  e.vmDisabled = true
  return e
}
function sessionIdReused(opts) { return !!opts.sessionId }
