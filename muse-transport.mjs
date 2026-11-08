#!/usr/bin/env node
/**
 * muse-transport.mjs — Phase 2 transport switch.
 *
 * Picks the backend for the MCP server / OpenAI shim based on MUSE_TRANSPORT:
 *   MUSE_TRANSPORT=browser (default) -> drive the real logged-in Chrome (muse-driver.mjs)
 *   MUSE_TRANSPORT=noise             -> headless Noise_XX client (muse-noise.mjs), no browser
 *
 * Both expose the same facade methods the server/shim call (status, login,
 * chat, chatStream, readLast, readChat, listChats, chatMedia, close, ...).
 * Over the noise transport attachments upload via /fs/write, media is read from
 * the workspace via /fs/raw, and chats are listed via /api/session/list. Only
 * openChat (single active session) and dump_dom (no DOM) remain browser-only.
 *
 * The noise transport still needs the login cookies; they are read once from
 * the same persistent Chrome profile the browser driver uses (headless, then
 * closed) and cached for the session.
 */
import './muse-env.mjs' // .env must land in process.env before any MUSE_* is read below
import path from 'node:path'
import fs, { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { accountCreds, loadDotEnv } from './muse-env.mjs'
import { driver, MuseDriver, clearStaleSingleton, browserIdentity } from './muse-driver.mjs'
import { MuseNoiseClient, abortedError, isMuseSorry, museSorryError, useBrowserIdentity } from './muse-noise.mjs'
import { flattenTransparent } from './muse-image.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROFILE_DIR = process.env.MUSE_PROFILE_DIR || path.join(__dirname, 'accounts', 'acc1')
const APP_URL = process.env.MUSE_URL || 'https://muse.ai/'
const CHANNEL = process.env.MUSE_CHANNEL || 'chrome'
// MUSE_CHROME_PATH: launch this browser binary instead of the installed Chrome channel (e.g. Playwright's cached Chromium).
const CHROME_PATH = process.env.MUSE_CHROME_PATH || ''
const TRANSPORT = (process.env.MUSE_TRANSPORT || 'browser').toLowerCase()
// transparent PNG / GIF / WebP attachments composited onto a plain background before upload (muse-image.mjs: Muse's
// viewer draws transparency black). MUSE_FLATTEN_TRANSPARENT=0 turns it off for every request; `opts.flatten === false` for one.
const FLATTEN = !['0', 'off', 'false', 'no'].includes(String(process.env.MUSE_FLATTEN_TRANSPARENT ?? '').trim().toLowerCase())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error('[muse-transport]', ...a)

// Read login cookies from a persistent profile without keeping a browser open.
async function grabCookies(profileDir = PROFILE_DIR) {
  const { chromium } = await import('playwright-core')
  const identity = await browserIdentity()
  useBrowserIdentity(identity) // the noise client then shows Muse the browser these cookies were read with
  clearStaleSingleton(profileDir) // a killed server leaves Chrome's singleton files behind
  const ctx = await chromium.launchPersistentContext(profileDir, {
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : { channel: CHANNEL }), headless: true, viewport: { width: 1366, height: 900 },
    userAgent: identity['user-agent'],
    args: ['--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled', '--disk-cache-size=67108864'],
  })
  try {
    const p = ctx.pages()[0] || await ctx.newPage()
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    return await ctx.cookies()
  } finally {
    await ctx.close().catch(() => {})
  }
}

// Pull assistant/user display texts out of a /chat/history payload.
function historyMessages(json) {
  const evs = (json && json.result && json.result.chat_events) || (json && json.chat_events) || []
  const msgs = []
  for (const e of evs) {
    const name = e.event_name || e.event
    if (name !== 'message.user' && name !== 'message.assistant') continue
    const text = typeof e.display_text === 'string' ? e.display_text.trim() : ''
    if (text) msgs.push({ role: name === 'message.assistant' ? 'assistant' : 'user', text })
  }
  return msgs
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
const mimeFor = (name) => MIME[String(name).toLowerCase().split('.').pop()] || 'application/octet-stream'

// extension of a data: URL's media type — case and parameters ignored, the common non-standard image/jpg read as jpeg (a
// KG question image of type image/svg+xml, image/jpg or IMAGE/PNG went up as attachment-<n>.bin, not as an image)
const extFor = (mime) => {
  const m = String(mime || '').split(';')[0].trim().toLowerCase()
  return Object.keys(MIME).find((k) => MIME[k] === (m === 'image/jpg' ? 'image/jpeg' : m)) || 'bin'
}

// Read a local path, http(s)/data: URL, or the shim's { url } / { buffer, name, mimeType } file refs into bytes.
// `n` (1-based position in the files list) names data: URLs `attachment-<n>.<ext>` so the numbering stays visible.
async function readRef(ref, n = 1) {
  if (ref && typeof ref === 'object') {
    if (ref.buffer) {
      const buf = Buffer.isBuffer(ref.buffer) ? ref.buffer : Buffer.from(ref.buffer, 'base64')
      return { bytes: new Uint8Array(buf), name: ref.name || `attachment-${n}`, mime: ref.mimeType }
    }
    ref = ref.url || ref.path || ''
  }
  const data = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(ref)
  if (data) {
    const mime = data[1] || 'application/octet-stream'
    return { bytes: new Uint8Array(Buffer.from(data[3], data[2] ? 'base64' : 'utf8')), name: `attachment-${n}.${extFor(mime)}`, mime }
  }
  if (/^file:\/\//i.test(ref)) ref = fileURLToPath(ref)
  if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref)
    if (!res.ok) throw new Error(`fetch ${ref} -> ${res.status}`)
    return { bytes: new Uint8Array(await res.arrayBuffer()), name: ref.split('/').pop().split('?')[0] || 'file' }
  }
  const buf = await fsp.readFile(ref)
  return { bytes: new Uint8Array(buf), name: ref.split('/').pop().split('\\').pop() || 'file' }
}

// Extract generated/attached media from a list of chat events (history or live).
function extractMedia(events) {
  const out = []
  const seen = new Set()
  const add = (path, mime, label, kind) => {
    if (!path) return
    const key = String(path)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ path, uri: path.startsWith('sandbox://') ? path : `sandbox://${path}`, mime: mime || mimeFor(path), label: label || '', kind: kind || 'file' })
  }
  for (const e of events) {
    const pl = e.payload || e
    const name = e.event_name || e.event
    // presentation events (live + history): payload.data.{images,videos,files,audio}
    const data = pl.data || {}
    for (const bucket of ['images', 'videos', 'files', 'audio']) {
      const arr = data[bucket]
      if (Array.isArray(arr)) for (const it of arr) add(it.path || it.uri, it.mime || it.mimeType, it.label || it.name, bucket)
    }
    // message.assistant presentations[] (history) may nest the same shape
    if (Array.isArray(pl.presentations)) for (const pr of pl.presentations) {
      const d = pr.data || pr
      for (const bucket of ['images', 'videos', 'files', 'audio']) {
        const arr = d[bucket]
        if (Array.isArray(arr)) for (const it of arr) add(it.path || it.uri, it.mime || it.mimeType, it.label || it.name, bucket)
      }
    }
    // media_paths (some payloads)
    if (Array.isArray(pl.media_paths)) for (const p of pl.media_paths) add(p, pl.media_type, '', pl.media_type || 'file')
    // markdown sandbox:// images in text
    const text = typeof pl.display_text === 'string' ? pl.display_text : typeof pl.text === 'string' ? pl.text : ''
    const re = /!\[[^\]]*\]\((sandbox:\/\/[^)]+)\)/g
    let m
    while ((m = re.exec(text))) add(m[1], '', '', 'image')
  }
  return out
}

const clientLive = (c) => !!(c && c.transport && c.ws && c.ws.readyState === 1)

// Every account the LB could use is out of quota: fail the turn (the shim answers 503) instead of sending it anyway.
function quotaExhausted(accts) {
  const resets = accts.map((a) => a.quota?.resetsAt).filter(Boolean).sort((x, y) => x - y)
  const next = resets.length ? `; next weekly reset ${new Date(resets[0] * 1000).toISOString()}` : ''
  const e = new Error(`every Muse account is out of quota (weekly limit and bought tokens used up: ${accts.map((a) => a.id).join(', ')})${next}`)
  e.quotaExhausted = true
  return e
}

// Muse dropped the account's login: `/api/auth/check -> 401 hatchAdmissionInvalidated reason=session`, the usage action
// "session has expired" / `401 Authentication required`, "Account requires a web checkpoint" (26/10/2026: 7 accounts at once,
// ~2,000 failovers/hour onto them). The profile's cookies are dead; only a new sign-in brings the account back.
const SESSION_EXPIRED_RE = /hatchAdmissionInvalidated|session has expired|Authentication required|requires a web checkpoint|not logged in \(auth\/check/i
const sessionExpired = (e) => SESSION_EXPIRED_RE.test((e && e.message) || String(e || ''))
const hasLoginCreds = (c) => !!(c.email && (c.metaPassword || c.mailPassword || c.apiKey || c.mailToken || /generator\.email|luuvan\.site|tuan89\.site/i.test(c.otpUrl || '')))

class NoiseTransport {
  transportKind = 'noise'
  constructor() {
    this.accounts = new Map() // id -> { id, profileDir, cookies, client, viewerId, connecting, q, inflight, downUntil }
    this.order = []
    this._rr = 0 // round-robin cursor for load balancing
    this.base = path.resolve(__dirname, process.env.MUSE_ACCOUNTS_DIR || 'accounts')
    const entries = (process.env.MUSE_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean)
    // `*` = every profile folder under MUSE_ACCOUNTS_DIR, re-scanned while running: drop a new logged-in
    // profile into accounts/<id> (creds in .env) and it joins the pool without a restart
    this.scan = entries.includes('*')
    this.scanEveryMs = Math.max(0, Number(process.env.MUSE_ACCOUNTS_RESCAN_SEC ?? 30)) * 1000
    this.scannedAt = 0
    // Quota guard: every MUSE_QUOTA_CHECK_SEC (0 = off) read each connected account's usage meter; an account whose
    // weekly limit AND bought tokens are used up leaves the auto pool until a later read says otherwise
    // Paused accounts (an operator's call, e.g. keep fresh accounts' bought tokens in reserve): no new auto-routed
    // turns, turns already running finish. Kept in <accounts>/.paused.json (hidden: the `*` scan skips it) so a
    // restart keeps them; re-read whenever the file changes, so editing it by hand works too.
    this.pausedFile = process.env.MUSE_PAUSED_FILE || path.join(this.base, '.paused.json')
    this.paused = new Set()
    this.pausedMtime = -1
    this._loadPaused()
    this.quotaEveryMs = Math.max(0, Number(process.env.MUSE_QUOTA_CHECK_SEC ?? 120)) * 1000
    // zombie-connection watchdog: an open WebSocket that stopped delivering anything while turns wait on it (23/10: turns
    // sat 12 min on a connection that had gone silent while fresh connections served the same sessions)
    this.zombieMs = Math.max(0, Number(process.env.MUSE_ZOMBIE_SEC ?? 45)) * 1000
    // Auto re-login (MUSE_AUTO_RELOGIN=0 turns it off): an account Muse signed out leaves the auto pool and is signed in
    // again with its .env creds into a fresh hidden profile, swapped in on success; a failed try waits
    // MUSE_RELOGIN_BACKOFF_MIN (5), doubling up to MUSE_RELOGIN_BACKOFF_MAX_MIN (60). One sign-in at a time for the pool.
    this.autoRelogin = process.env.MUSE_AUTO_RELOGIN !== '0'
    this.reloginBaseMs = Math.max(1, Number(process.env.MUSE_RELOGIN_BACKOFF_MIN ?? 5)) * 60000
    this.reloginMaxMs = Math.max(1, Number(process.env.MUSE_RELOGIN_BACKOFF_MAX_MIN ?? 60)) * 60000
    this._reloginQ = Promise.resolve()
    // Meta-disconnected accounts (VM DISABLED, every connect 502s: 5,670 failovers in a week from one account, 28–31/10)
    // leave the auto pool; their /api/session is read again every MUSE_VM_RECHECK_MIN (30) until the VM is back
    this.vmRecheckMs = Math.max(1, Number(process.env.MUSE_VM_RECHECK_MIN ?? 30)) * 60000
    if (this.zombieMs) setInterval(() => { this._checkZombies().catch(() => {}) }, 15000).unref()
    if (this.quotaEveryMs) setInterval(() => { this._checkQuotas().catch(() => {}) }, this.quotaEveryMs).unref()
    entries.filter((e) => e !== '*').forEach((e, i) => {
      const eq = e.indexOf('=')
      let id, dir
      if (eq > 0) { id = e.slice(0, eq).trim(); dir = path.resolve(__dirname, e.slice(eq + 1).trim()) }
      else { id = e; dir = path.join(this.base, e) } // bare id -> <MUSE_ACCOUNTS_DIR>/<id> (default ./accounts)
      this._add(id || `acc${i + 1}`, dir)
    })
    if (this.scan) this._rescan(true)
    if (!this.order.length) this._add('default', PROFILE_DIR)
    this.defaultId = this.order[0]
  }
  _add(id, profileDir) {
    if (this.accounts.has(id)) return
    // creds come from .env (MUSE_ACCOUNT_<ID>_*), never from literals in this file
    this.accounts.set(id, { id, profileDir, creds: accountCreds(id), cookies: null, client: null, viewerId: null, connecting: null, inflight: 0, downUntil: 0, quota: null, quotaError: null, q: Promise.resolve() })
    this.order.push(id)
  }
  // Pick up profile folders added under MUSE_ACCOUNTS_DIR since the last scan (only with `*` in MUSE_ACCOUNTS).
  // A folder counts once it is a Chrome profile (has Default/); hidden folders are skipped. Folders that vanish
  // leave the pool (not the default account, not while a turn runs on it). Throttled to MUSE_ACCOUNTS_RESCAN_SEC (default 30).
  _rescan(force = false) {
    if (!this.scan) return
    const now = Date.now()
    if (!force && now - this.scannedAt < this.scanEveryMs) return
    this.scannedAt = now
    let names
    try { names = fs.readdirSync(this.base, { withFileTypes: true }) } catch { return }
    const dirs = new Map(names
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
      .map((d) => [d.name, path.join(this.base, d.name)])
      .filter(([, dir]) => fs.existsSync(path.join(dir, 'Default'))))
    const real = (dir) => { try { return fs.realpathSync(dir) } catch { return dir } }
    const known = new Set([...this.accounts.values()].map((a) => real(a.profileDir))) // same folder under two names = one account
    const added = []
    for (const [id, dir] of [...dirs].sort(([x], [y]) => x.localeCompare(y))) {
      if (this.accounts.has(id) || known.has(real(dir))) continue
      if (!added.length && this.defaultId) { // after start: re-read .env for creds added since
        loadDotEnv(undefined, { refresh: true })
        for (const a of this.accounts.values()) a.creds = accountCreds(a.id)
      }
      this._add(id, dir)
      added.push(id)
    }
    const gone = this.order.filter((id) => {
      const a = this.accounts.get(id)
      return id !== this.defaultId && !(a.inflight > 0) && path.dirname(a.profileDir) === this.base && !dirs.has(path.basename(a.profileDir))
    })
    for (const id of gone) {
      const a = this.accounts.get(id)
      try { a.client?.close() } catch {}
      this.accounts.delete(id)
    }
    if (gone.length) this.order = this.order.filter((id) => this.accounts.has(id))
    if (this.defaultId && (added.length || gone.length)) log('accounts rescan: +', added.join(',') || '-', ' -', gone.join(',') || '-', '→', this.order.length)
  }
  _loadPaused() {
    let mtime
    try { mtime = fs.statSync(this.pausedFile).mtimeMs } catch { mtime = 0 }
    if (mtime === this.pausedMtime) return
    this.pausedMtime = mtime
    let ids = []
    try { const j = JSON.parse(fs.readFileSync(this.pausedFile, 'utf8')); ids = Array.isArray(j) ? j : Object.keys(j || {}) } catch {}
    this.paused = new Set(ids.map(String))
  }
  setPaused(id, on = true) {
    const a = this._acct(id)
    this._loadPaused()
    if (on) this.paused.add(a.id)
    else this.paused.delete(a.id)
    const tmp = `${this.pausedFile}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify([...this.paused].sort(), null, 1) + '\n')
    fs.renameSync(tmp, this.pausedFile)
    this.pausedMtime = fs.statSync(this.pausedFile).mtimeMs
    log(`pause: ${a.id} ${on ? 'paused — no new turns' : 'resumed'} (paused: ${[...this.paused].join(', ') || '-'})`)
    return { account: a.id, paused: on, inflight: a.inflight || 0 }
  }
  // A failure that says Muse signed the account out: take it out of the auto pool and start signing it in again.
  _expire(a, e) {
    if (!sessionExpired(e)) return false
    if (!a.expired) {
      a.expired = { since: Date.now(), reason: String((e && e.message) || e).slice(0, 200), attempts: 0, nextAt: null, lastError: null }
      log(`session: ${a.id} signed out by Muse (${a.expired.reason}) — out of the auto pool${this.autoRelogin ? ', signing in again' : ''}`)
    }
    try { a.client?.close() } catch {}
    a.client = null; a.cookies = null
    this._scheduleRelogin(a, 0)
    return true
  }
  // A connect that found the account's VM DISABLED (Meta disconnected Muse for it): out of the auto pool until a re-read
  // of /api/session says otherwise. A new sign-in does not help, the cookies stay.
  _disable(a, e) {
    if (!(e && e.vmDisabled)) return false
    if (!a.vmDisabled) {
      a.vmDisabled = { since: Date.now(), reason: String(e.message).slice(0, 200), checkedAt: Date.now(), nextAt: null }
      log(`vm: ${a.id}: ${a.vmDisabled.reason} — out of the auto pool, re-checked every ${Math.round(this.vmRecheckMs / 60000)} min`)
    }
    this._scheduleVmCheck(a)
    return true
  }
  _scheduleVmCheck(a) {
    if (this.closing || !a.vmDisabled || a.vmTimer) return
    a.vmDisabled.nextAt = Date.now() + this.vmRecheckMs
    a.vmTimer = setTimeout(() => {
      a.vmTimer = null
      this._checkVm(a).catch((err) => log(`vm: ${a.id} re-check crashed: ${err.message}`))
    }, this.vmRecheckMs)
    a.vmTimer.unref()
  }
  async _checkVm(a) {
    if (!a.vmDisabled || !this.accounts.has(a.id)) return
    if (!a.expired) { // a signed-out account is read again once its sign-in brings new cookies
      try {
        const cookies = a.cookies || await this._grabCookies(a)
        const c = new MuseNoiseClient({ cookies, log })
        const { state } = await c.vmState().finally(() => c.close())
        a.vmDisabled.checkedAt = Date.now()
        if (state !== 'DISABLED') {
          log(`vm: ${a.id} VM is ${state || 'not reported'} again — back in the auto pool`)
          a.vmDisabled = null
          return
        }
      } catch (e) {
        a.vmDisabled.lastError = String(e.message).slice(0, 200)
        this._expire(a, e)
      }
    }
    this._scheduleVmCheck(a)
  }
  _scheduleRelogin(a, delayMs) {
    if (!this.autoRelogin || this.closing || !a.expired || a.reloginTimer || a.relogging) return
    if (!hasLoginCreds(a.creds)) {
      if (!a.expired.noCreds) log(`session: ${a.id} has no sign-in creds in .env (MUSE_ACCOUNT_${a.id.toUpperCase()}_*) — stays out until signed in by hand`)
      a.expired.noCreds = true
      return
    }
    a.expired.nextAt = Date.now() + delayMs
    a.reloginTimer = setTimeout(() => {
      a.reloginTimer = null
      this._relogin(a).catch((err) => log(`session: ${a.id} re-login crashed: ${err.message}`))
    }, delayMs)
    a.reloginTimer.unref()
  }
  // Sign in into <dir>/.<name>.relogin (hidden: the `*` scan skips it), then swap it for the dead profile, which is kept as
  // .<name>.expired until the next swap. A fresh profile, not the old one: there Meta shows the remembered account with
  // "Authentication is unavailable" and the sign-in never gets past the email screen.
  async _relogin(a) {
    a.relogging = true
    const job = this._reloginQ.then(async () => {
      if (this.closing || !a.expired || !this.accounts.has(a.id)) return
      const dir = path.dirname(a.profileDir), name = path.basename(a.profileDir)
      const fresh = path.join(dir, `.${name}.relogin`), old = path.join(dir, `.${name}.expired`)
      await fsp.rm(fresh, { recursive: true, force: true })
      const n = ++a.expired.attempts
      const t0 = Date.now()
      let r
      const d = new MuseDriver(fresh, { headless: true })
      try { r = await d.login({ ...a.creds, timeoutMs: 180000 }) } catch (e) { r = { loggedIn: false, hint: e.message } }
      finally { await d.close().catch(() => {}) }
      if (!(r && r.loggedIn)) {
        await fsp.rm(fresh, { recursive: true, force: true }).catch(() => {})
        a.expired.lastError = String((r && (r.hint || r.mode)) || 'sign-in failed').slice(0, 200)
        return Math.min(this.reloginMaxMs, this.reloginBaseMs * 2 ** (n - 1))
      }
      if (a.grabbing) await a.grabbing.catch(() => {}) // no Chromium may hold the old profile while it moves
      await fsp.rm(old, { recursive: true, force: true })
      // both renames back to back, no await between: a rescan must never find the account folder missing
      fs.renameSync(a.profileDir, old)
      fs.renameSync(fresh, a.profileDir)
      try { a.client?.close() } catch {}
      Object.assign(a, { expired: null, client: null, cookies: null, quota: null, quotaError: null, downUntil: 0 })
      log(`session: ${a.id} signed in again (attempt ${n}, ${Math.round((Date.now() - t0) / 1000)} s) — back in the pool once its meter reads`)
      this._grabCookies(a).then(() => this._checkQuota(a)).catch(() => {})
      return 0
    })
    this._reloginQ = job.then(() => {}, () => {})
    let wait = 0
    try { wait = await job } finally { a.relogging = false }
    if (a.expired && wait > 0) {
      log(`session: ${a.id} sign-in attempt ${a.expired.attempts} failed (${a.expired.lastError}) — next try in ${Math.round(wait / 60000)} min`)
      this._scheduleRelogin(a, wait)
    }
  }
  _acct(id) {
    id = id || this.defaultId
    if (!this.accounts.has(id)) this._rescan(true) // a just-added profile named explicitly
    const a = this.accounts.get(id)
    if (!a) throw new Error(`unknown account "${id}" (known: ${this.order.join(', ')})`)
    return a
  }
  // One cookie read per account at a time, shared by every caller: two Chromium on one profile collide (ProcessSingleton),
  // and a console usage read racing a reconnect failed the whole batch of turns waiting on that connect (693 failovers/24 h).
  // Every read is one Chromium launch: logged so launches can be counted.
  _grabCookies(a) {
    if (!a.grabbing) {
      const t0 = Date.now()
      a.grabbing = grabCookies(a.profileDir)
        .then((c) => { log(`cookies: ${a.id} read from its profile (Chromium, ${Date.now() - t0} ms)`); return (a.cookies = c) })
        .finally(() => { a.grabbing = null })
    }
    return a.grabbing
  }
  async _ensure(a) {
    if (this.closing) throw abortedError() // shutting down: no reconnect, no failover onto a fresh connection
    if (a.client && a.client.ws && a.client.ws.readyState === 1) return a.client
    if (a.client) { try { a.client.close() } catch {}; a.client = null } // stale/closed -> drop it
    if (a.connecting) return a.connecting // dedupe concurrent callers (one cookie-grab / connect)
    a.connecting = (async () => {
      try {
        const cookies = a.cookies || await this._grabCookies(a)
        const c = new MuseNoiseClient({ cookies, log })
        try { await c.connect() } catch (e) { c.close(); throw e }
        a.client = c
        if (this.quotaEveryMs && !a.quota) this._checkQuota(a) // first connect: learn the quota before many turns land here
        return c
      } finally {
        a.connecting = null
      }
    })()
    return a.connecting
  }
  async _reconnect(a) {
    try { a.client?.close() } catch {}
    a.client = null; a.cookies = null
    return this._ensure(a)
  }
  // Serialize chat turns PER ACCOUNT: noise has one active session per account and
  // every turn subscribes to the same feed, so concurrent chats on the same account
  // cross-contaminate. Different accounts run in parallel (separate connections).
  _serial(a, fn) {
    const run = a.q.then(() => fn())
    a.q = run.then(() => {}, () => {}) // keep the chain alive on rejection
    return run
  }
  async launch(opts = {}) { await this._ensure(this._acct(opts.account)); return { ok: true, transport: 'noise', accounts: this.order, defaultAccount: this.defaultId } }
  async status(opts = {}) {
    this._rescan() // /health lists a just-seeded profile even while no turn is being routed
    const a = this._acct(opts.account)
    this._loadPaused()
      const accounts = this.order.map((id) => { const x = this.accounts.get(id); return { id: x.id, email: x.creds.email || null, profileDir: x.profileDir, loggedIn: !!x.cookies, connected: !!(x.client && x.client.ws && x.client.ws.readyState === 1), inflight: x.inflight || 0, viewerId: x.viewerId, inPool: !this._depleted(x) && !this.paused.has(x.id) && !x.expired && !x.vmDisabled, paused: this.paused.has(x.id), signedOut: x.expired ? { ...x.expired, signingIn: !!x.relogging } : null, vmDisabled: x.vmDisabled ? { ...x.vmDisabled } : null, quota: x.quota, quotaError: x.quotaError } })
    const connected = !!(a.client && a.client.ws && a.client.ws.readyState === 1)
    return {
      browserRunning: false, url: APP_URL, transport: 'noise',
      account: a.id, defaultAccount: this.defaultId,
      loggedIn: !!a.cookies, connected, viewerId: a.viewerId,
      profileDir: a.profileDir, headless: true, accounts,
    }
  }
  async login(opts = {}) {
    // Noise has no login UI: it needs auth cookies in the account's profile. If
    // none are cached yet and unattended credentials are supplied, drive a
    // one-shot browser sign-in (mailtemp OTP) into that profile to seed it.
    const a = this._acct(opts.account)
    if (a.grabbing) await a.grabbing.catch(() => {}) // the seed browser below needs the profile to itself
    if (!a.cookies) {
      const creds = a.creds
      const email = opts.email || creds.email
      const mailPassword = opts.mailPassword || creds.mailPassword
      const metaPassword = opts.metaPassword || creds.metaPassword
      const apiKey = opts.apiKey || creds.apiKey
      const mailToken = opts.mailToken || creds.mailToken
      const otpUrl = opts.otpUrl || creds.otpUrl
      const hasCreds = !!(metaPassword || mailPassword || apiKey || mailToken || /generator\.email|luuvan\.site|tuan89\.site/i.test(otpUrl || ''))
      if (email && hasCreds && opts.auto !== false) {
        const d = new MuseDriver(a.profileDir)
        try {
          const r = await d.login({ ...opts, email, metaPassword, mailPassword, apiKey, mailToken, otpUrl })
          // an address that is not ours (reseller catch-all…) gets a mailtemp box as a second contact email, so later
          // sign-ins still get their code; MUSE_ADD_MAILTEMP=0 turns this off
          if (r && r.loggedIn && process.env.MUSE_ADD_MAILTEMP !== '0') {
            const { ensureMailtempContact } = await import('./muse-addmail.mjs')
            try {
              if (await ensureMailtempContact(await d.requirePage(), { id: a.id, email, log })) {
                loadDotEnv(undefined, { refresh: true })
                a.creds = accountCreds(a.id)
              }
            } catch (e) { log('noise: adding a mailtemp email failed:', e.message) }
          }
        } catch (e) { log('noise: browser seed sign-in failed:', e.message) }
        await d.close().catch(() => {}) // release the profile lock before grabCookies()
      }
    }
    const c = await this._ensure(a)
    const h = await c.chatHistory(1)
    a.viewerId = (h.json && h.json.result && h.json.result.viewer_id) || null
    if (h.status === 200 && a.expired) { log(`session: ${a.id} signed in by hand — back in the pool`); a.expired = null }
    return { account: a.id, loggedIn: h.status === 200, transport: 'noise', viewerId: a.viewerId }
  }
  // Noise threads are client-chosen UUIDs that materialize on first send:
  // mint the id here so the caller can continue it with --chat <session_id>
  // (a bare "started" note would leave the next ask on the shared session).
  async newChat(opts = {}) { const a = this._acct(opts.account); const sessionId = globalThis.crypto.randomUUID(); return { ok: true, transport: 'noise', account: a.id, session_id: sessionId, note: 'fresh thread id minted; it materializes on the first send — continue it with --chat <session_id>' } }
  // Upload every file of the turn or fail: a turn that went out with fewer images than asked still came back 200 and
  // schema-valid (Muse just answers about what it got), so a lost image was invisible to the caller. A failure on a
  // live connection (VM `fs.write 502`, 60 s timeout) is retried in place — the connection carries the account's other
  // turns, so it is not closed for one file; a dead connection fails the attempt (fresh connection, then LB failover).
  async _uploadAll(client, files, signal) {
    const retries = Math.max(0, Number(process.env.MUSE_UPLOAD_RETRY ?? 2))
    const backoff = Math.max(0, Number(process.env.MUSE_UPLOAD_BACKOFF_MS ?? 1500))
    const out = []
    let retried = 0
    for (const f of files) {
      for (let k = 0; ; k++) {
        if (signal && signal.aborted) throw abortedError()
        try {
          const up = await client.uploadAttachment(f.bytes, f.name, f.mime)
          // the shim's prompt calls file n "attachment-<n>": a data: URL is named so already (readRef); a URL / path / named
          // buffer keeps its own name, so its link gets that label as alt text — `![attachment-3](sandbox://…/deck.pdf)`
          if (!new RegExp(`^attachment-${f.n}(\\.|$)`).test(String(f.name))) up.name = `attachment-${f.n}`
          out.push(up)
          break
        }
        catch (e) {
          if (!clientLive(client) || k >= retries) {
            const err = new Error(`attachment ${f.n}/${files.length} upload failed: ${e.message}`)
            err.upload = true
            throw err
          }
          retried++
          await sleep(backoff * (k + 1))
        }
      }
    }
    if (retried) log(`attachments: ${out.length}/${files.length} uploaded after ${retried} retr${retried > 1 ? 'ies' : 'y'}`)
    return out
  }
  async _run(a, prompt, opts = {}) {
    const t0 = Date.now()
    const onDelta = opts.onDelta
    const signal = opts.signal || null
    // read every ref once, up front: an unreadable ref is the caller's input, not this account's fault
    const files = []
    for (const [i, ref] of (opts.files || []).entries()) {
      try {
        const { bytes, name, mime } = await readRef(ref, i + 1)
        files.push({ bytes, name, mime: mime || mimeFor(name), n: i + 1 })
      } catch (e) {
        const where = typeof ref === 'string' ? ref : ref?.url || ref?.path || ref?.name || ''
        const err = new Error(`attachment ${i + 1} unreadable (${String(where).slice(0, 80)}): ${e.message}`)
        err.badInput = true
        throw err
      }
    }
    if (FLATTEN && opts.flatten !== false) {
      const done = []
      for (const f of files) {
        const r = flattenTransparent(f.bytes, f.mime, f.name)
        if (r.flattened) { Object.assign(f, { bytes: r.bytes, mime: r.mime, name: r.name }); done.push(`${f.n}:${r.background}`) }
      }
      if (done.length) log(`attachments: ${done.length}/${files.length} transparent image(s) flattened (${done.join(', ')})`)
    }
    let resumeSid = null // session of a turn whose connection dropped mid-reply: the next attempt picks it up, not a rerun
    let attachments = [], resumes = 0
    // two runs of the turn at most, plus up to two resumes of a run whose connection dropped (or went unresponsive)
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal && signal.aborted) throw abortedError()
      let client
      for (let k = 0; ; k++) {
        try { client = await this._ensure(a); break }
        catch (e) {
          // the gateway's WS 502/429 come in short bursts: a turn that only has to pick its running session up retries
          // the connection instead of failing over and leaving that session to run for nobody
          if (!resumeSid || e.aborted || k >= 3 || (signal && signal.aborted)) throw e
          log(`resume of ${resumeSid.slice(0, 8)} on ${a.id}: connect failed (${e.message}), retrying`)
          await sleep(3000 * (k + 1))
        }
      }
      try {
        if (resumeSid) {
          let r
          resumes++
          try { r = await client.resumeTurn(resumeSid, { signal }) }
          catch (e) {
            if (!e.aborted && e.resumeSessionId && resumes < 2) {
              // this connection died / stopped answering too: resume once more on a fresh one
              log(`resume of ${resumeSid.slice(0, 8)} on ${a.id}: ${e.message} — reconnecting to resume again`)
              try { client.close() } catch {}
              if (a.client === client) a.client = null
              continue
            }
            // the session cannot be picked up (stalled, errored, connection lost again): cancel it so Muse stops billing
            // it, then fail over — without closing this connection, which carries the account's other turns
            if (!e.aborted) {
              const sid = resumeSid
              ;(clientLive(client) ? Promise.resolve(client) : this._ensure(a)).then((c) => c.cancel(sid))
                .then((ok) => log(`resume of ${sid.slice(0, 8)} on ${a.id} failed (${e.message}); cancelled → ${ok}`), () => {})
            }
            e.noRetry = true
            throw e
          }
          log(`resumed turn ${resumeSid.slice(0, 8)} on ${a.id} after a dropped connection (reply from ${r.via})`)
          if (isMuseSorry(r.reply)) throw museSorryError(r.reply, resumeSid)
          return {
            reply: r.reply, messages: r.reply ? [r.reply] : [], threadUrl: APP_URL, elapsedMs: Date.now() - t0,
            transport: 'noise', account: a.id, sessionId: resumeSid, resumed: true,
            ...(attachments.length ? { attachments } : {}),
          }
        }
        attachments = await this._uploadAll(client, files, signal) // fresh copies each attempt: the VM may have restarted
        let committed = ''
        const r = await client.chat(prompt, {
          timeoutMs: opts.timeoutMs || Number(process.env.MUSE_STALL_IDLE_MS || 120000), // idle gap between events (activity-based; see _chatOnce)
          attachments,
          newSession: !!(opts.newSession || opts.newThread),
          sessionId: opts.sessionId || opts.chat || null,
          signal,
          onEvent: (ev) => {
            if (!onDelta) return
            if ((ev.event || ev.event_name) === 'delta.text_append' && typeof ev.payload?.text === 'string') {
              committed += ev.payload.text
              try { onDelta(committed) } catch {}
            }
          },
        })
        return {
          reply: r.reply,
          messages: r.reply ? [r.reply] : [],
          threadUrl: APP_URL,
          elapsedMs: Date.now() - t0,
          transport: 'noise',
          account: a.id,
          ...(r.sessionId ? { sessionId: r.sessionId } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(r.replyReady ? {} : { timedOut: true }),
        }
      } catch (e) {
        if (e.noRetry || e.aborted) throw e // Muse itself reported an error (or the caller left): return it as-is
        log('chat attempt', attempt, 'failed:', e.message)
        const resume = !!(e.resumeSessionId && !resumeSid)
        if (resume) resumeSid = e.resumeSessionId // next pass picks the running session up instead of a rerun
        // an upload failure on a live connection leaves it to the other turns; a reset feed does not: the gateway resets
        // every feed of a connection whose VM side failed at once (`subscribe reset code=5 reason=response body error`,
        // 10 feeds in the same second on 23/10) and a resume on that connection got reset again — reconnect instead
        if (!(e.upload && clientLive(client))) {
          // close the connection THIS attempt used: after a retry backoff (chat 2–4.5 s, upload 1.5–3 s) `a.client` may
          // already be the fresh one another turn opened, and closing that one took every turn on it down too
          try { client.close() } catch {}
          if (a.client === client) a.client = null // keep cookies; force a fresh connection on retry
        }
        if (attempt >= 1 && !resume) throw e
      }
    }
  }
  // Assign a turn to an account, tracking in-flight so least_conn can balance.
  // New-session turns run in parallel (own feed); shared-session turns serialize
  // per account to avoid cross-contamination.
  _turn(a, prompt, opts = {}) {
    a.inflight = (a.inflight || 0) + 1
    const settle = (r) => { a.inflight = Math.max(0, (a.inflight || 0) - 1); return r }
    // tag the error with the account that ran the turn, so the shim can report it like it does for a success
    // (and a turn that found the account signed out takes it out of the pool, pinned turns included)
    const fail = (e) => { a.inflight = Math.max(0, (a.inflight || 0) - 1); if (e && typeof e === 'object' && !e.account) e.account = a.id; this._expire(a, e); this._disable(a, e); throw e }
    const p = (opts.newSession || opts.newThread) ? this._run(a, prompt, opts) : this._serial(a, () => this._run(a, prompt, opts))
    return p.then(settle, fail)
  }
  // Ordered candidate accounts for a request that did NOT name one.
  // MUSE_ACCOUNT_LB: round_robin (default when >1 account) | least_conn | first|none (pin default).
  _lbCandidates(opts = {}) {
    this._rescan()
    const ranked = this._lbOrder()
    this._loadPaused()
    const live = ranked.filter((a) => !this._depleted(a) && !this.paused.has(a.id) && !a.expired && !a.vmDisabled)
    if (!live.length) {
      const usable = ranked.filter((a) => !this.paused.has(a.id) && !a.expired && !a.vmDisabled)
      if (usable.length) throw quotaExhausted(usable)
      const e = new Error(`every Muse account is paused, signed out or disconnected by Meta (${ranked.map((a) => a.id).join(', ')})`)
      e.quotaExhausted = true // same 503 as out of quota: callers move the work elsewhere
      throw e
    }
    // an account that just failed (not logged in, rate-limited, mid-login) goes last until its cooldown ends,
    // so a broken profile does not cost every request a Chromium launch
    const now = Date.now()
    return [...live.filter((a) => !(a.downUntil > now)), ...live.filter((a) => a.downUntil > now)]
  }
  // Out of quota = Muse says so (usage.quotaStatus DEPLETED) or the weekly limit is at 100% with no bought tokens left.
  // Not read yet / read failed = usable.
  _depleted(a) {
    const q = a.quota
    if (!q) return false
    if (/DEPLETED|EXHAUSTED|EXCEEDED/i.test(q.status || '')) return true
    return q.percentUsed >= 100 && q.topupBalance != null && q.topupBalance <= 0
  }
  _noteQuota(a, sub) {
    const was = this._depleted(a)
    const u = (sub && sub.usage) || {}
    a.quota = {
      status: u.quotaStatus || null, percentUsed: u.percentUsed ?? null, resetsAt: u.resetsAt ?? null,
      topupBalance: sub?.topupBalance ?? null, topupTotal: sub?.topupTotal ?? null, checkedAt: Date.now(),
    }
    a.quotaError = null
    const out = this._depleted(a)
    if (out !== was) log(`quota: ${a.id} ${a.quota.status || '-'} (week ${a.quota.percentUsed ?? '?'}%, bought ${a.quota.topupBalance ?? '?'}) — ${out ? 'out of' : 'back in'} the auto pool`)
  }
  // Read one account's usage meter (plain HTTPS with its cookies, no model call); a failed read keeps the last reading.
  _checkQuota(a) {
    if (a.quotaChecking) return a.quotaChecking
    a.quotaChecking = (async () => {
      let tmp = null // a client made for this read only: closed after it (see MuseNoiseClient.close)
      try {
        const c = a.client || (tmp = new MuseNoiseClient({ cookies: a.cookies, log }))
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('usage read timed out')), 30000).unref())
        this._noteQuota(a, await Promise.race([c.usage(), timeout]))
      } catch (e) {
        if (a.quotaError !== e.message) log(`quota: ${a.id} read failed: ${e.message}`)
        a.quotaError = e.message
        this._expire(a, e)
      } finally {
        tmp?.close()
        a.quotaChecking = null
      }
    })()
    return a.quotaChecking
  }
  // Accounts that have not connected yet are skipped (no Chromium launch just to read a meter); _ensure checks them on connect.
  async _checkQuotas() {
    if (this._quotaLoop) return
    this._quotaLoop = true
    try {
      for (const id of [...this.order]) {
        const a = this.accounts.get(id)
        if (a && (a.client || a.cookies)) await this._checkQuota(a)
      }
    } finally {
      this._quotaLoop = false
    }
  }
  _lbOrder() {
    const n = this.order.length
    if (n <= 1) return [this._acct()]
    const mode = (process.env.MUSE_ACCOUNT_LB || 'round_robin').toLowerCase()
    if (mode === 'first' || mode === 'none') return [this._acct()]
    const list = this.order.map((id) => this.accounts.get(id))
    if (mode === 'least_conn') return [...list].sort((a, b) => (a.inflight || 0) - (b.inflight || 0))
    const start = ((this._rr++ % n) + n) % n
    return Array.from({ length: n }, (_, i) => list[(start + i) % n])
  }
  // Try candidate accounts in LB order; on a connection/serve failure, fail over
  // to the next so one dead or rate-limited account doesn't sink the request.
  async _turnWithFailover(cands, prompt, opts = {}) {
    let last
    let tried = 0
    for (const a of cands) {
      // meter never read (shim just started / account just joined): wait for the first read instead of piling a burst
      // of turns on an account that may be out of quota; concurrent turns share the one read
      if (this.quotaEveryMs && !a.quota && !a.quotaError) {
        // hold a place while waiting, or least_conn sends every turn arriving meanwhile to this same account (a herd of
        // ~80 turns uploading at once on one connection drops it within 2 s, then moves on to the next account)
        a.inflight = (a.inflight || 0) + 1
        // the meter is plain HTTPS with the login cookies: read it without waiting on the VM connection, which may be
        // failing (WS 502 right after a restart let turns through to DEPLETED accounts while their meter went unread)
        try {
          if (!a.cookies && !a.client && !a.expired) await this._grabCookies(a)
          // a read can fail on a burst (28 reads at start: `fetch failed`, 14 turns then ran on a DEPLETED account): retry
          for (let k = 0; k < 3 && !a.quota; k++) { if (k) await sleep(1000 * k); await this._checkQuota(a) }
        } catch (e) { a.quotaError = e.message }
        finally { a.inflight = Math.max(0, (a.inflight || 0) - 1) }
        if (opts.signal && opts.signal.aborted) throw abortedError()
      }
      // `cands` was ranked when the request came in: an account found out of quota (or paused) since then is skipped, or
      // a failover lands on it — right after a restart every meter is unread, so a 429 wave sent ~60 turns onto DEPLETED ones
      if (this._depleted(a) || this.paused.has(a.id) || a.expired || a.vmDisabled) continue
      // meter still unreadable: let another account take the turn if there is one
      if (this.quotaEveryMs && !a.quota && a !== cands[cands.length - 1]) continue
      tried++
      try { return await this._turn(a, prompt, opts) }
      catch (e) {
        if (e.aborted || e.badInput) throw e // the caller is gone / sent an unreadable file: no failover, the account did nothing wrong
        last = e
        log('LB failover from', a.id, ':', e && e.message)
        // cooldown only, the cookies stay: a WS/serve failure is not a login problem (a dropped login goes through _expire,
        // which clears them), and re-reading them cost a Chromium launch on the reconnect after every failover
        if (cands.length > 1) a.downUntil = Date.now() + Math.max(0, Number(process.env.MUSE_ACCOUNT_COOLDOWN_SEC ?? 60)) * 1000
      }
    }
    if (!tried) throw quotaExhausted(cands)
    throw last
  }
  // A new-session turn gets its own thread + event feed, so concurrent ones are
  // isolated and can run in parallel (no serialization). Turns on the shared
  // active session must be serialized to avoid cross-contamination.
  async chat(prompt, opts = {}) {
    if (opts.account) return this._turn(this._acct(opts.account), prompt, opts)
    return this._turnWithFailover(this._lbCandidates(opts), prompt, opts)
  }
  async chatStream(prompt, opts = {}) {
    if (opts.account) return this._turn(this._acct(opts.account), prompt, opts)
    return this._turnWithFailover(this._lbCandidates(opts), prompt, opts)
  }
  async readLast(opts = {}) {
    const a = this._acct(opts.account)
    const h = await (await this._ensure(a)).chatHistory(50)
    const msgs = historyMessages(h.json)
    const last = [...msgs].reverse().find((m) => m.role === 'assistant')
    return { reply: last ? last.text : '', messages: msgs.map((m) => m.text), threadUrl: APP_URL, account: a.id }
  }
  async readChat(max = 100, opts = {}) {
    const a = this._acct(opts.account)
    const sessionId = await this._sessionForTarget(opts.target, a)
    const h = await (await this._ensure(a)).chatHistory(max, sessionId || undefined)
    if (h.status === 404) throw new Error(`no chat matching "${opts.target}"`)
    const evs = (h.json && h.json.result && h.json.result.chat_events) || []
    const msgs = historyMessages(h.json)
    const media = extractMedia(evs)
    return { messages: msgs.map((m) => m.text), entries: msgs.length, media, transport: 'noise', account: a.id, ...(sessionId ? { session_id: sessionId } : {}) }
  }
  // Resolve a chat target (session uuid / list index / title substring) to a
  // session_id via the session list; no target = the primary session. Throws
  // on an unmatched target instead of silently reading the active session.
  async _sessionForTarget(target, a = this._acct()) {
    if (target === null || target === undefined || target === '') return null
    const s = String(target).trim()
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s
    const { chats } = await this.listChats(undefined, { account: a.id })
    const chat = /^(\d+)$/.test(s) ? chats[Number(s)] : chats.find((c) => c.title.toLowerCase().includes(s.toLowerCase()))
    if (!chat || !chat.session_id) throw new Error(`no chat matching "${s}"`)
    return chat.session_id
  }
  async listChats(query, opts = {}) {
    const a = this._acct(opts.account)
    const s = await (await this._ensure(a)).listSessions()
    const sessions = (s.json && s.json.result && s.json.result.sessions) || []
    let chats = sessions.map((c) => ({
      title: c.title || c.snippet || '(untitled)',
      active: !!c.is_primary,
      pinned: !!c.pinned,
      archived: !!c.archived,
      session_id: c.session_id,
      snippet: c.snippet || '',
      updated_at_ms: c.updated_at_ms,
    }))
    if (query) { const q = String(query).toLowerCase(); chats = chats.filter((c) => c.title.toLowerCase().includes(q) || c.snippet.toLowerCase().includes(q)) }
    return { chats, threadUrl: APP_URL, transport: 'noise', account: a.id }
  }
  async openChat(target, opts = {}) { return { ok: false, note: 'open_chat is not supported over the noise transport (single active session)', transport: 'noise' } }
  async chatMedia(chat, { download = false, dir, account } = {}) {
    const a = this._acct(account)
    const client = await this._ensure(a)
    const sessionId = await this._sessionForTarget(chat, a)
    const h = await client.chatHistory(100, sessionId || undefined)
    if (h.status === 404) throw new Error(`no chat matching "${chat}"`)
    const evs = (h.json && h.json.result && h.json.result.chat_events) || []
    const media = extractMedia(evs)
    const items = media.map((m, index) => ({ index, role: '', text: m.label, urls: [m.uri] }))
    const urls = media.map((m) => m.uri)
    const result = { items, urls, count: urls.length, threadUrl: APP_URL, transport: 'noise', account: a.id }
    if (download && media.length) {
      const outDir = dir || path.join(__dirname, 'downloads')
      await fsp.mkdir(outDir, { recursive: true })
      const saved = []
      for (const m of media) {
        try {
          const r = await client.fsRaw(m.path)
          if (r.status === 200 && r.body.length) {
            const file = path.join(outDir, (m.path.split('/').pop() || 'media').replace(/[^\w.\-]/g, '_'))
            await fsp.writeFile(file, r.body)
            saved.push({ path: m.path, file, bytes: r.body.length })
          } else saved.push({ path: m.path, error: `fs.raw ${r.status}` })
        } catch (e) { saved.push({ path: m.path, error: e.message }) }
      }
      result.downloads = saved
    }
    return result
  }
  // Usage needs only the login cookies (plain HTTPS RSC action), not the noise WS.
  async usage(opts = {}) {
    const a = this._acct(opts.account)
    let c = a.client
    // a profile Muse signed out has no cookies worth a Chromium launch: the console reads every account's meter every
    // 10 min, and each read relaunched Chromium on every signed-out profile (sign-in again goes through _relogin/login)
    if (!c && !a.cookies && a.expired) {
      throw new Error(`${a.id} is signed out by Muse (${a.expired.reason}) — ${a.relogging ? 'signing in again' : 'waiting to sign in again'}`)
    }
    const tmp = c ? null : new MuseNoiseClient({ cookies: a.cookies || await this._grabCookies(a), log })
    if (tmp) c = tmp
    let sub
    try { sub = await c.usage() } catch (e) { this._expire(a, e); throw e } finally { tmp?.close() }
    this._noteQuota(a, sub) // a caller's read (console, muse_usage) refreshes the quota guard too
    return { ...sub, account: a.id, transport: 'noise' }
  }
  async dumpDom(max, opts = {}) { return { note: 'dump_dom is a browser-only diagnostic (noise transport has no DOM)', transport: 'noise' } }
  async close(opts = {}) { for (const a of this.accounts.values()) { try { a.client?.close() } catch {} a.client = null } }
  // A connection with turns in flight and no frame for zombieMs gets a cheap read; no answer in 20 s → close it, which ends
  // every feed on it as "stream closed" and the turns resume their sessions on a fresh connection.
  async _checkZombies() {
    if (this.closing) return
    for (const a of this.accounts.values()) {
      const c = a.client
      if (!clientLive(c) || !(a.inflight > 0) || a.zombieProbe) continue
      // silent, or still delivering broadcasts but leaving requests unanswered (a recent request timeout)
      const silent = Date.now() - (c.lastFrameAt || 0) >= this.zombieMs
      const unanswered = c.lastTimeoutAt && Date.now() - c.lastTimeoutAt < 60000
      if (!silent && !unanswered) continue
      a.zombieProbe = true
      c.request('GET', '/chat/history?limit=1', { timeoutMs: 20000 })
        .then(() => {}, (e) => {
          if (c !== a.client || !clientLive(c)) return
          log(`zombie connection on ${a.id}: ${silent ? `no frame for ${Math.round((Date.now() - c.lastFrameAt) / 1000)} s` : 'requests timing out'} and the probe failed (${e.message}) — closing it, ${a.inflight} turn(s) will resume`)
          try { c.close() } catch {}
          if (a.client === c) a.client = null
        })
        .finally(() => { a.zombieProbe = false })
    }
  }
  // Shim shutdown/restart: the HTTP layer has aborted every turn (each cancels its own Muse session on the way out);
  // wait up to waitMs for them to finish, then cancel whatever is still running on any connection before close().
  async shutdown({ waitMs = 45000 } = {}) {
    this.closing = true
    for (const a of this.accounts.values()) if (a.reloginTimer) { clearTimeout(a.reloginTimer); a.reloginTimer = null }
    const busy = () => [...this.accounts.values()].reduce((n, a) => n + (a.inflight || 0), 0)
    const t0 = Date.now()
    while (busy() && Date.now() - t0 < waitMs) await sleep(250)
    const left = busy()
    const swept = []
    await Promise.all([...this.accounts.values()].filter((a) => a.client && a.client.sessions?.size).map(async (a) => {
      for (const r of await a.client.cancelAll()) swept.push(`${a.id}:${(r.sessionId || 'primary').slice(0, 8)}=${r.result}`)
    }))
    log(`shutdown: turns settled in ${Math.round((Date.now() - t0) / 1000)} s${left ? ` (${left} still in flight)` : ''}; ${swept.length ? `cancelled leftover sessions: ${swept.join(', ')}` : 'no session left running'}`)
    return { inflightLeft: left, swept }
  }
}

export const transport = TRANSPORT === 'noise' ? new NoiseTransport() : driver
export default transport
