/**
 * muse-driver.mjs
 * ------------------------------------------------------------------
 * Browser driver for Meta Muse (https://muse.ai) — the "Hatch" agent VM.
 *
 * WHY THIS EXISTS
 *   Muse chat is NOT a REST/SSE API. It is an RPC gateway over an
 *   *encrypted* WebSocket ("noise" transport: X25519 + HKDF + AES-GCM),
 *   with Ed25519-signed auth_token/notary_token in the WS URL. See
 *   https://hatch.metaaivm.com/v1/noise and methods like chat.stream.
 *
 *   Rather than reimplementing the Noise handshake (phase 2), this driver
 *   drives the REAL client in a real Chrome so the app performs all crypto
 *   itself. It then reads the rendered assistant reply from the DOM.
 *
 * SELECTORS (harvested from the captured client JS / HAR)
 *   composer root : [data-hatch-composer-root]
 *   editor        : [data-lexical-editor="true"]   (Lexical contenteditable)
 *   send          : Enter key (analytics event "composer_enter_key")
 *   streaming     : [data-testid="hatch-composer-stop-button"]
 *   messages      : [data-message-item] (data-message-role = user|assistant)
 *   error         : [data-testid="assistant-response-error-notice"]
 *   auth check    : POST /api/auth/check  -> { ok, viewer_id, access_token }
 * ------------------------------------------------------------------
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { subscriptionAction, parseFlightResult, isMuseSorry, museSorryError } from './muse-noise.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const SELECTORS = {
  composerRoot: '[data-hatch-composer-root]',
  editor: '[data-lexical-editor="true"], [data-hatch-composer-root] textarea, [data-hatch-composer-prehydration-input], [data-hatch-composer-root] [contenteditable="true"]',
  stopButton: '[data-testid="hatch-composer-stop-button"]',
  actionSlot: '[data-hatch-composer-action-slot]',
  fileInput: '[data-hatch-composer-root] input[type="file"]',
  attachButton: '[data-hatch-composer-root] button[aria-label="Attach file"]',
  message: '[data-message-item]',
  threadRow: '[data-testid="hatch-thread-row"]',
  assistant: '[data-message-item][data-message-role="assistant"]',
  user: '[data-message-item][data-message-role="user"]',
  errorNotice: '[data-testid="assistant-response-error-notice"]',
  approvalStack: '[data-hatch-composer-approval-stack]',
}

const APP_URL = process.env.MUSE_URL || 'https://muse.ai/'
const PROFILE_DIR =
  process.env.MUSE_PROFILE_DIR || path.join(__dirname, 'accounts', 'acc1')
const HEADLESS = process.env.MUSE_HEADLESS === '1'
const CHANNEL = process.env.MUSE_CHANNEL || 'chrome'
// MUSE_CHROME_PATH: launch this browser binary instead of the installed Chrome channel (e.g. Playwright's cached Chromium).
const CHROME_PATH = process.env.MUSE_CHROME_PATH || ''
const LAUNCH_TIMEOUT = Number(process.env.MUSE_LAUNCH_TIMEOUT_MS || 60000)
// Streaming: only surface text that has been stable this long, so we never emit
// a mid-generation "skeleton" that Muse later rewrites (which would duplicate in
// an append-only SSE stream).
const STREAM_QUIET_MS = Number(process.env.MUSE_STREAM_QUIET_MS || 600)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error('[muse-driver]', ...a)

/**
 * Drop Chrome's singleton files when the process that made them is gone.
 *
 * Chrome deletes SingletonLock/Socket/Cookie only on a clean exit, so a server
 * that was killed (pkill, SIGKILL, a closed terminal) leaves them behind and the
 * next launch fails with "Failed to create a ProcessSingleton". The lock is a
 * symlink named after its owner ("<host>-<pid>"), so:
 *   - PID alive and still a Chrome  -> a real instance owns the profile: leave it
 *     (the CDP fallback in launch() handles that case).
 *   - PID gone, or the PID was recycled by a non-Chrome process -> stale: unlink.
 * Anything unreadable or ambiguous is left alone, so this never steals a live
 * profile. Windows uses a different scheme, so it is skipped there.
 */
export function clearStaleSingleton(profileDir, logger = log) {
  if (process.platform === 'win32') return false
  let owner
  try { owner = fs.readlinkSync(path.join(profileDir, 'SingletonLock')) } catch { return false } // no lock
  const pid = Number(String(owner).split('-').pop())
  if (!Number.isInteger(pid) || pid <= 0) return false
  let alive = true
  try { process.kill(pid, 0) } catch (e) {
    if (e.code === 'ESRCH') alive = false
    else if (e.code === 'EPERM') return false // alive, owned by someone else
  }
  if (alive) {
    // A recycled PID looks alive but is not Chrome: the lock is stale. If the
    // cmdline really is Chrome, that instance owns the profile — leave it alone.
    let cmd = ''
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { return false }
    if (/chrome|chromium/i.test(cmd)) return false
    logger(`stale singleton in ${profileDir}: pid ${pid} is alive but not Chrome ("${cmd.slice(0, 40).trim()}")`)
  } else {
    logger(`stale singleton in ${profileDir}: pid ${pid} is gone`)
  }
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(profileDir, name)) } catch {}
  }
  return true
}

/**
 * The browser every request to Muse shows, read once per process from the Chromium in use: its UA with
 * "HeadlessChrome" read as "Chrome" (headless gives itself away in the UA only, its client hints are the headed
 * ones) and the client hints Chrome sends on every fetch. Browser launches take `userAgent` from it and grabCookies
 * hands it to the noise client, so an account shows Muse one browser from sign-in to chat.
 * → { 'user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform' }
 */
let identity = null
export function browserIdentity() {
  identity ??= (async () => {
    const { chromium } = await import('playwright-core')
    const browser = await chromium.launch({
      ...(CHROME_PATH ? { executablePath: CHROME_PATH } : { channel: CHANNEL }),
      headless: true, timeout: LAUNCH_TIMEOUT, args: ['--no-sandbox', '--disable-gpu'],
    })
    try {
      const page = await browser.newPage()
      // navigator.userAgentData exists in secure contexts only (not about:blank): serve a blank localhost page
      await page.route('http://localhost/', (r) => r.fulfill({ contentType: 'text/html', body: '' }))
      await page.goto('http://localhost/')
      const { ua, brands, mobile, platform } = await page.evaluate(() => ({ ua: navigator.userAgent, ...navigator.userAgentData.toJSON() }))
      return {
        'user-agent': ua.replace('HeadlessChrome/', 'Chrome/'),
        'sec-ch-ua': brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
        'sec-ch-ua-mobile': mobile ? '?1' : '?0',
        'sec-ch-ua-platform': `"${platform}"`,
      }
    } finally {
      await browser.close().catch(() => {})
    }
  })()
  identity.catch(() => { identity = null }) // a failed launch is tried again by the next caller
  return identity
}

export class MuseDriver {
  // opts.headless overrides MUSE_HEADLESS for this instance (the noise pool re-signs accounts in on a server with no display)
  constructor(profileDir = process.env.MUSE_PROFILE_DIR || path.join(__dirname, 'accounts', 'acc1'), opts = {}) {
    this.profileDir = profileDir
    this.headless = opts.headless ?? HEADLESS
    this.ctx = null
    this.page = null
    this.browser = null
    this.lastError = null
    this._queue = Promise.resolve()
  }

  /** Serialize browser actions (one window = one action at a time). */
  _serial(fn) {
    const run = this._queue.then(fn, fn)
    this._queue = run.then(() => {}, () => {})
    return run
  }

  isRunning() {
    return !!(this.ctx && this.page && !this.page.isClosed())
  }

  async launch() {
    if (this.isRunning()) return this.page
    const { chromium } = await import('playwright-core')

    const launchPersistent = async () => {
      clearStaleSingleton(this.profileDir) // leftovers from a killed run would block this launch
      const { 'user-agent': userAgent } = await browserIdentity()
      return chromium.launchPersistentContext(this.profileDir, {
        ...(CHROME_PATH ? { executablePath: CHROME_PATH } : { channel: CHANNEL }),
        headless: this.headless,
        userAgent,
        viewport: { width: 1366, height: 900 },
        acceptDownloads: false,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=Translate,OptimizationGuideModelDownloading',
          '--disk-cache-size=67108864', // 36 profiles grew ~400 MB/day each without a cap
        ],
      })
    }
    const attachCDP = async (url) => {
      this.browser = await chromium.connectOverCDP(url)
      this.ctx = this.browser.contexts()[0] || (await this.browser.newContext())
    }

    if (process.env.MUSE_CDP) {
      // Escape hatch: attach to a Chrome you already started with
      //   chrome.exe --remote-debugging-port=9222
      // Reuses all your existing logins; the driver will not own the browser.
      try {
        await attachCDP(process.env.MUSE_CDP)
      } catch (e) {
        this.browser = null
        this.ctx = null
        this.ctx = await launchPersistent()
      }
    } else {
      try {
        this.ctx = await launchPersistent()
      } catch (e) {
        // The profile is probably locked by an already-running Chrome (e.g. one
        // started with --remote-debugging-port=9222). Attach to it instead of
        // failing; only if nothing is listening on the CDP port do we rethrow.
        const msg = String((e && e.message) || e)
        if (!/singleton|lock|profile|already running|browser is already/i.test(msg)) throw e
        try {
          await attachCDP('http://127.0.0.1:9222')
        } catch {
          throw new Error(
            `Could not open the Muse Chrome profile (${this.profileDir}): it is locked by ` +
              `another Chrome window, and no debugger is listening on 127.0.0.1:9222. ` +
              `Close the Chrome window using this profile, or restart it with ` +
              `--remote-debugging-port=9222 and set MUSE_CDP=http://127.0.0.1:9222.`,
          )
        }
      }
    }

    this.ctx.on('close', () => {
      this.ctx = null
      this.page = null
      this.browser = null
    })
    const pages = this.ctx.pages()
    this.page = pages.find((p) => p.url().includes('muse.ai')) || pages[0] || (await this.ctx.newPage())
    this.page.setDefaultTimeout(LAUNCH_TIMEOUT)
    await this.gotoApp()
    return this.page
  }

  async gotoApp() {
    const p = await this.requirePage()
    if (!p.url().startsWith('https://muse.ai')) {
      await p.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: LAUNCH_TIMEOUT })
    }
    return p
  }

  async requirePage() {
    if (!this.isRunning()) await this.launch()
    return this.page
  }

  /** Cookie-based auth probe performed from inside the page origin. */
  async checkAuth() {
    const p = await this.requirePage()
    try {
      const r = await p.evaluate(async () => {
        try {
          const res = await fetch('/api/auth/check', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            credentials: 'same-origin',
          })
          const j = await res.json().catch(() => null)
          return { status: res.status, ok: !!(j && j.ok), viewerId: (j && j.viewer_id) || null }
        } catch (e) {
          return { status: 0, ok: false, error: String(e) }
        }
      })
      return r
    } catch (e) {
      return { status: 0, ok: false, error: String(e) }
    }
  }

  /** Usage/credits meter via the fetchSubscriptionAction RSC action, run in-page. */
  async usage({ includeAgreement = true } = {}) {
    const p = await this.requirePage()
    const txt = await p.evaluate(async (args) => {
      try {
        const res = await fetch('/', {
          method: 'POST',
          headers: {
            accept: 'text/x-component',
            'content-type': 'text/plain;charset=UTF-8',
            'next-action': args.id,
          },
          body: JSON.stringify([{ includeAgreement: args.includeAgreement }]),
          credentials: 'same-origin',
        })
        const t = await res.text()
        return { status: res.status, text: t }
      } catch (e) { return { status: 0, text: String(e) } }
    }, { id: subscriptionAction(), includeAgreement })
    if (!txt || txt.status !== 200) throw new Error(`usage action -> ${txt && txt.status}: ${String(txt && txt.text).slice(0, 200)}`)
    const r = parseFlightResult(txt.text)
    if (!r || !r.success) throw new Error('usage action failed: ' + JSON.stringify((r && r.error) || r).slice(0, 200))
    return r.subscription
  }

  async hasComposer() {
    const p = await this.requirePage()
    try {
      await p.locator(SELECTORS.editor).first().waitFor({ state: 'visible', timeout: 8000 })
      return true
    } catch {
      return false
    }
  }

  async status() {
    const running = this.isRunning()
    const url = running ? this.page.url() : null
    if (!running) {
      return { browserRunning: false, url: null, loggedIn: false, composerReady: false, profileDir: this.profileDir, headless: this.headless }
    }
    const auth = await this.checkAuth()
    const composerReady = await this.hasComposer()
    return {
      browserRunning: true,
      url,
      loggedIn: auth.ok,
      viewerId: auth.viewerId || null,
      composerReady,
      profileDir: this.profileDir,
      headless: this.headless,
    }
  }

  /** Locate a login input by name, then placeholder/aria-label keyword, then type. */
  async _findInput(p, kind) {
    const names = { email: ['email'], password: ['password'], code: ['code'] }[kind] || []
    for (const n of names) {
      const byName = p.locator(`input[name="${n}"]`)
      if (await byName.count()) return byName.first()
    }
    const kw = {
      email: ['mobile number or email', 'email', 'phone'],
      password: ['password'],
      code: ['code', 'security', 'confirmation'],
    }[kind] || []
    for (const word of kw) {
      const byPh = p.locator(`input[placeholder*="${word}" i], input[aria-label*="${word}" i]`)
      if (await byPh.count()) return byPh.first()
    }
    if (kind === 'password') {
      const pw = p.locator('input[type="password"]')
      if (await pw.count()) return pw.first()
    }
    return null
  }

  async _clickButton(p, re) {
    const btn = p.getByRole('button', { name: re }).first()
    if (await btn.count()) { await btn.click({ timeout: 5000 }).catch(() => {}); return true }
    return false
  }

  /** Classify the current Meta/Muse login screen from the DOM. */
  async _detectScreen(p) {
    return p.evaluate(() => {
      const has = (sel) => !!document.querySelector(sel)
      const txt = () => document.body.innerText || ''
      if (has('[data-hatch-composer-root]')) return 'app'
      if (has('input[aria-label*="code" i]') || /enter your code|resend code|use code/i.test(txt())) return 'code'
      if (has('input[type="password"]')) return 'password'
      if (has('input[placeholder*="mobile" i]') || /log in or create an account|create account|sign up/i.test(txt())) return 'email'
      if (/remember this device|use this device|this was me|save login|not now/i.test(txt())) return 'device'
      return 'other'
    }).catch(() => 'other')
  }

  /**
   * Unattended Meta sign-in: fill email -> password -> OTP (read from
   * mailtemp.vn) -> handle the "remember this device" screen, looping until
   * /api/auth/check reports ok. Returns true on success.
   */
  async _autoLogin(p, mt, opts) {
    const metaPass = opts.metaPassword || opts.mailPassword || ''
    let seen = new Set()
    try { seen = new Set((await mt.messages()).map((m) => m.id)) } catch (e) { log('pre-inbox read failed:', e.message) }
    let unavailable = 0
    this.lastError = null
    for (let step = 0; step < 24; step++) {
      const auth = await this.checkAuth()
      if (auth.ok) { log('auto-login ok at step', step); return true }
      const screen = await this._detectScreen(p)
      log(`auto-login step ${step}: screen=${screen}`)
      // Muse's own sign-in is down for this browser (26/10/2026: POST /api/auth/native/restart -> 503 for every address,
      // fresh profile or not): retrying the email screen 24 times only burns a minute
      if (/authentication is unavailable/i.test(await p.evaluate(() => document.body.innerText).catch(() => '')) && ++unavailable >= 3) {
        this.lastError = 'Muse sign-in unavailable ("Authentication is unavailable", /api/auth/native/restart 503)'
        log('auto-login:', this.lastError)
        return false
      }
      if (screen === 'other') log('  page:', (await p.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 300))
      if (screen === 'email') {
        const el = await this._findInput(p, 'email')
        if (el) {
          const val = await el.evaluate((e) => e.value).catch(() => '')
          if (!val) await el.fill(opts.email)
          await el.evaluate((e) => { e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })) }).catch(() => {})
          await sleep(500)
          if (!(await this._clickButton(p, /continue|tiếp tục|next|get started|create account|sign up/i))) await el.press('Enter')
          await sleep(3500); continue
        }
      }
      if (screen === 'password' && !metaPass) {
        // code-only account (bought accounts come with the mailbox, not the Meta password): ask for a code instead
        if (await this._clickButton(p, /try another way|log in with (a )?code|send (me )?(a )?code|get (a )?code|use (a )?code|thử cách khác/i)) { await sleep(3000); continue }
      }
      if (screen === 'password') {
        const el = await this._findInput(p, 'password')
        if (el && metaPass) {
          await el.fill(metaPass); await sleep(300)
          if (!(await this._clickButton(p, /continue|next|log in|sign in|submit|tiếp tục|đăng nhập/i))) await el.press('Enter')
          await sleep(3000); continue
        }
      }
      if (screen === 'code') {
        const el = await this._findInput(p, 'code')
        if (el) {
          let c = await mt.waitForCode(seen, { timeoutMs: 45000 })
          // the code may have gone out before the inbox was first read (an earlier attempt left the page here): resend once
          if (!c && await this._clickButton(p, /resend code|gửi lại mã/i)) { log('no fresh OTP, resent the code'); c = await mt.waitForCode(seen, { timeoutMs: 75000 }) }
          if (!c) { log('no fresh OTP arrived'); break }
          log('filling OTP', c.code, '(', c.subject || c.from, ')')
          await el.fill(c.code); seen.add(c.id)
          await sleep(400)
          if (!(await this._clickButton(p, /next|continue|confirm|submit|verify|tiếp tục|xác nhận/i))) await el.press('Enter')
          await sleep(4000); continue
        }
      }
      if (screen === 'device') {
        if (await this._clickButton(p, /next|yes|save|this was me|use this device|tiếp tục/i)) { await sleep(2500); continue }
        if (await this._clickButton(p, /not now/i)) { await sleep(2500); continue }
      }
      await sleep(2000)
    }
    return (await this.checkAuth()).ok
  }

  /**
   * Open muse.ai and sign in. With credentials (email + a password or API key,
   * or env MUSE_META_EMAIL/...) it signs in unattended via mailtemp.vn OTP;
   * otherwise it waits for a manual sign-in in the Chrome window. Accepts
   * either a timeout in ms (legacy) or an options object.
   */
  async login(optsOrMs = {}) {
    const opts = typeof optsOrMs === 'number' ? { timeoutMs: optsOrMs } : (optsOrMs || {})
    const timeoutMs = opts.timeoutMs || 300000
    const email = opts.email || process.env.MUSE_META_EMAIL || ''
    const metaPassword = opts.metaPassword || process.env.MUSE_META_PASSWORD || ''
    const mailPassword = opts.mailPassword || process.env.MUSE_MAIL_PASSWORD || ''
    const apiKey = opts.apiKey || process.env.MUSE_MAILTEMP_API_KEY || ''
    const mailToken = opts.mailToken || process.env.MUSE_MAIL_TOKEN || ''
    const otpUrl = opts.otpUrl || process.env.MUSE_META_OTP_URL || ''
    const { isGeneratorEmailUrl } = await import('./muse-genmail.mjs')
    const { isLuuVanUrl } = await import('./muse-luuvan.mjs')
    const { isTuan89Url } = await import('./muse-tuan89.mjs')
    const genmail = isGeneratorEmailUrl(otpUrl)
    const luuvan = isLuuVanUrl(otpUrl)
    const tuan89 = isTuan89Url(otpUrl)
    const auto = opts.auto !== false && !!email && !!(metaPassword || mailPassword || apiKey || mailToken || genmail || luuvan || tuan89)

    const p = await this.gotoApp()
    let auth = await this.checkAuth()
    if (auth.ok) return { loggedIn: true, viewerId: auth.viewerId || null, mode: 'already' }

    if (auto) {
      // An OTP_URL on generator.email / luuvan.site / tuan89.site picks that inbox; otherwise mailtemp.vn.
      const mt = genmail
        ? new (await import('./muse-genmail.mjs')).GeneratorEmail({ email, url: otpUrl, log })
        : luuvan
          ? new (await import('./muse-luuvan.mjs')).LuuVan({ email, log })
          : tuan89
            ? new (await import('./muse-tuan89.mjs')).Tuan89({ email, log })
            : new (await import('./muse-mailtemp.mjs')).MailTemp({ email, apiKey, mailPassword, mailToken, log })
      let ok
      try { ok = await this._autoLogin(p, mt, { ...opts, email, metaPassword, mailPassword, timeoutMs }) }
      finally { await mt.close?.() }
      auth = await this.checkAuth()
      // the page may still be navigating right after the last screen (23/10/2026: "ok at step 2" then a failed check)
      for (let i = 0; ok && !auth.ok && i < 3; i++) { await sleep(3000); auth = await this.checkAuth() }
      if (ok && auth.ok) return { loggedIn: true, viewerId: auth.viewerId || null, mode: 'auto' }
      if (this.headless) return { loggedIn: false, mode: 'auto-failed', hint: this.lastError || 'Auto-login did not complete (captcha / unexpected screen?). Re-run headed (unset MUSE_HEADLESS) to finish manually, or check credentials.' }
      log('auto-login incomplete, falling back to manual sign-in')
    }

    // Interactive fallback: keep waiting for a manual sign-in until the deadline.
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      auth = await this.checkAuth()
      if (auth.ok) return { loggedIn: true, viewerId: auth.viewerId || null, mode: 'manual' }
      await sleep(2000)
    }
    return { loggedIn: false, hint: 'Complete the Meta sign-in in the opened Chrome window, then call muse_login again or muse_status.' }
  }

  async _newChat() {
    const p = await this.requirePage()
    await this.gotoApp()
    // Prefer the app's own "New side chat" control (reliable); fall back to the home composer.
    try {
      const btn = p.getByRole('button', { name: /new side chat/i })
      if (await btn.count()) {
        await btn.first().click({ timeout: 5000 })
        await sleep(1200)
        await this.waitForComposer()
        return { ok: true, url: p.url() }
      }
    } catch { /* fall through */ }
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: LAUNCH_TIMEOUT })
    await this.waitForComposer()
    return { ok: true, url: p.url() }
  }

  async newChat() {
    return this._serial(() => this._newChat())
  }

  /**
   * Normalize attachment entries into Playwright file payloads.
   * Accepts: "C:\\path\\img.png" | { path } | { url } (http/https/data:) |
   *          { name, mimeType, buffer } (Buffer or base64 string).
   */
  async _toFilePayloads(files) {
    const out = []
    for (const f of files || []) {
      if (!f) continue
      let e = f
      if (typeof e === 'string') e = /^(https?:|data:)/i.test(e) ? { url: e } : { path: e }

      if (e.buffer) {
        const buf = Buffer.isBuffer(e.buffer) ? e.buffer : Buffer.from(e.buffer, 'base64')
        out.push({ name: e.name || 'file', mimeType: e.mimeType || 'application/octet-stream', buffer: buf })
        continue
      }
      if (e.url && /^data:/i.test(e.url)) {
        const m = e.url.match(/^data:([^;,]*)(;base64)?,(.*)$/s)
        if (m) {
          const buf = Buffer.from(m[3], m[2] ? 'base64' : 'utf8')
          out.push({ name: e.name || `attachment`, mimeType: m[1] || e.mimeType || 'application/octet-stream', buffer: buf })
          continue
        }
      }
      if (e.url && /^file:\/\//i.test(e.url)) { out.push(fileURLToPath(e.url)); continue }
      if (e.url && /^https?:\/\//i.test(e.url)) {
        const res = await fetch(e.url)
        if (!res.ok) throw new Error(`failed to fetch attachment ${e.url}: ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        let name = e.name
        if (!name) { try { name = decodeURIComponent(new URL(e.url).pathname.split('/').pop()) || 'attachment' } catch { name = 'attachment' } }
        out.push({ name, mimeType: res.headers.get('content-type') || e.mimeType || 'application/octet-stream', buffer: buf })
        continue
      }
      if (e.url) { out.push(e.url); continue } // bare local path passed via `url`
      if (e.path) out.push(e.path)
    }
    return out
  }

  /** Attach files/images/videos to the composer (no send). */
  async attachFiles(files) {
    return this._serial(() => this._attachFiles(files))
  }

  async _attachFiles(files) {
    const payloads = await this._toFilePayloads(files)
    if (!payloads.length) return { ok: true, count: 0 }
    const p = await this.requirePage()
    await this.gotoApp()
    await this.waitForComposer()
    await p.locator(SELECTORS.fileInput).first().setInputFiles(payloads)
    await sleep(600) // let the app register the attachment(s)
    return { ok: true, count: payloads.length }
  }

  async waitForComposer(timeoutMs = 90000) {
    const p = await this.requirePage()
    await p.locator(SELECTORS.editor).first().waitFor({ state: 'visible', timeout: timeoutMs })
    // wait until not busy (aria-busy on composer root)
    const root = p.locator(SELECTORS.composerRoot).first()
    try {
      await root.waitFor({ state: 'visible', timeout: 10000 })
      const start = Date.now()
      while (Date.now() - start < 15000) {
        const busy = await root.getAttribute('aria-busy')
        if (busy !== 'true') break
        await sleep(250)
      }
    } catch {
      /* composer root optional */
    }
  }

  async composerText() {
    const p = await this.requirePage()
    try {
      const el = p.locator(SELECTORS.editor).first()
      const tag = await el.evaluate((e) => e.tagName)
      if (tag === 'TEXTAREA' || tag === 'INPUT') return await el.inputValue()
      return await el.innerText()
    } catch {
      return ''
    }
  }

  /**
   * Send a prompt and wait for the assistant reply to finish streaming.
   * @returns {Promise<{reply:string, messages:string[], threadUrl:string, elapsedMs:number, error?:string, timedOut?:boolean, needsApproval?:boolean}>}
   */
  async _run(prompt, { timeoutMs = 240000, newThread = false, onDelta, files, chat } = {}) {
    const hasFiles = Array.isArray(files) && files.length > 0
    if ((!prompt || !prompt.trim()) && !hasFiles) throw new Error('prompt is empty')
    const p = await this.requirePage()
    if (newThread) await this._newChat()
    else if (chat !== undefined && chat !== null && chat !== '') await this._openChat(chat)
    else await this.gotoApp()
    await this.waitForComposer()

    // Clear any transient error notice.
    this.lastError = null

    // Attach images/videos/files (if any) before typing the prompt.
    if (hasFiles) {
      const payloads = await this._toFilePayloads(files)
      if (payloads.length) {
        await p.locator(SELECTORS.fileInput).first().setInputFiles(payloads)
        await sleep(800) // let the app ingest + preview the attachment(s)
      }
    }

    // Anchor the turn on message order, not a pre-send assistant count: the
    // reply is the assistant message AFTER our user message. A continuing chat
    // (or a home→main-chat fallback when "New side chat" isn't clickable, as in
    // headless) must never return a stale previous-turn reply, so we wait until
    // OUR user message is in the DOM before reading the turn.
    const prevUserCount = await p.locator(SELECTORS.user).count()
    const readTurn = async () => {
      const items = await p.locator(SELECTORS.message).evaluateAll((els) =>
        els.map((e) => ({ role: e.getAttribute('data-message-role') || '', text: (e.innerText || '').trim() })),
      )
      let lastUser = -1
      for (let i = items.length - 1; i >= 0; i--) { if (items[i].role === 'user') { lastUser = i; break } }
      let txt = ''
      for (let i = items.length - 1; i > lastUser; i--) { if (items[i].role === 'assistant') { txt = items[i].text; break } }
      return { items, lastUser, txt }
    }

    // Focus + fill the composer. insertText is O(1) for big prompts;
    // fall back to per-key typing if the editor ignores it.
    const editor = p.locator(SELECTORS.editor).first()
    await editor.click()
    await p.keyboard.press('Control+A').catch(() => {})
    await p.keyboard.press('Delete').catch(() => {})
    try { if (prompt) await p.keyboard.insertText(prompt) } catch { /* fall back below */ }
    await sleep(120)
    if (prompt && !(await this.composerText()).trim()) {
      await p.keyboard.type(prompt, { delay: 1 })
    }
    await sleep(150)

    const t0 = Date.now()
    await p.keyboard.press('Enter')

    // Confirm the message actually left the composer; else click the send action.
    let sent = false
    for (let i = 0; i < 10; i++) {
      await sleep(300)
      const txt = (await this.composerText()).trim()
      const stop = await p.locator(SELECTORS.stopButton).count()
      if (txt.length === 0 || stop > 0) { sent = true; break }
    }
    if (!sent) {
      const slot = p.locator(`${SELECTORS.actionSlot} button`).last()
      if (await slot.count()) { await slot.click({ timeout: 5000 }).catch(() => {}) }
      await p.keyboard.press('Control+Enter').catch(() => {})
    }

    // Wait for the reply to complete.
    const deadline = t0 + timeoutMs
    let started = false
    let lastText = ''
    let committed = ''
    let stableSince = Date.now()
    let timedOut = false

    while (Date.now() < deadline) {
      const stop = await p.locator(SELECTORS.stopButton).count()
      if (stop > 0) started = true
      // Only read once OUR message has landed (a new user item appears), so we
      // anchor on this turn and never grab a previous-turn reply.
      if (await p.locator(SELECTORS.user).count() > prevUserCount) {
        const turn = await readTurn()
        const txt = turn.txt
        if (txt && txt !== lastText) {
          lastText = txt
          stableSince = Date.now()
        }
        const idle = Date.now() - stableSince
        // Commit only stable + monotonic growth (never a re-written draft).
        if (onDelta && txt && txt !== committed && txt.startsWith(committed) && idle >= STREAM_QUIET_MS) {
          committed = txt
          try { onDelta(committed) } catch { /* ignore */ }
        }
        if (txt && stop === 0 && ((started && idle > 1200) || (!started && idle > 2500))) break
      }
      if (await p.locator(SELECTORS.errorNotice).count()) {
        this.lastError = await p.locator(SELECTORS.errorNotice).first().innerText().catch(() => 'assistant error')
      }
      await sleep(300)
    }
    if (Date.now() >= deadline) timedOut = true

    const turn = await readTurn()
    const items = turn.items.slice(turn.lastUser + 1).filter((m) => m.role === 'assistant' && m.text).map((m) => m.text)
    const reply = (items.length ? items[items.length - 1] : lastText).trim()
    const needsApproval = (await p.locator(SELECTORS.approvalStack).count()) > 0

    // Flush any remainder that arrived after the last stable commit.
    if (onDelta && reply && reply !== committed && reply.startsWith(committed)) {
      try { onDelta(reply) } catch { /* ignore */ }
    }

    return {
      reply,
      messages: items,
      threadUrl: p.url(),
      elapsedMs: Date.now() - t0,
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      ...(needsApproval ? { needsApproval: true } : {}),
    }
  }

  /** Send a prompt and wait for the full assistant reply. */
  async chat(prompt, opts = {}) {
    return this._serial(() => this._run(prompt, opts)).then(failOnSorry)
  }

  /**
   * Same as chat(), but streams incremental text.
   * @param {(fullText:string)=>void} opts.onDelta called with the cumulative reply text
   */
  async chatStream(prompt, opts = {}) {
    return this._serial(() => this._run(prompt, opts)).then(failOnSorry)
  }

  async readLast() {
    return this._serial(() => this._readLast())
  }

  async _readLast() {
    const p = await this.requirePage()
    await this.gotoApp()
    const n = await p.locator(SELECTORS.assistant).count()
    if (!n) return { reply: '', messages: [], threadUrl: p.url() }
    const reply = await p.locator(SELECTORS.assistant).last().innerText().catch(() => '')
    return { reply: reply.trim(), messages: [reply.trim()], threadUrl: p.url() }
  }

  /** List the chats shown in the Muse sidebar (Main chat, Channels, Side chats). */
  async listChats(query) {
    return this._serial(() => this._listChats(query))
  }

  async _listChats(query) {
    const p = await this.requirePage()
    await this.gotoApp()
    await sleep(400)
    let chats = await p.locator(SELECTORS.threadRow).evaluateAll((els) =>
      els.map((el) => ({
        title: (el.innerText || '').replace(/\s+/g, ' ').replace(/\s*More thread actions\s*$/i, '').trim(),
        active: el.getAttribute('aria-current') === 'page' || el.getAttribute('aria-selected') === 'true',
      })).filter((c) => c.title),
    )
    if (query) {
      const q = String(query).toLowerCase()
      chats = chats.filter((c) => c.title.toLowerCase().includes(q))
    }
    return { chats, threadUrl: p.url() }
  }

  /**
   * Open a chat. `target` can be:
   *   - a number         -> chat index from listChats()
   *   - a title/name     -> matched (substring, case-insensitive) against the sidebar
   *   - a thread URL or bare thread id (uuid) -> navigated to directly
   *   - null/undefined   -> the home / main chat
   */
  async openChat(target) {
    return this._serial(() => this._openChat(target))
  }

  async _openChat(target) {
    const p = await this.requirePage()
    if (target === null || target === undefined || target === '') {
      await this.gotoApp()
    } else if (typeof target === 'number') {
      await this.gotoApp()
      const row = p.locator(SELECTORS.threadRow).nth(target)
      if (!(await row.count())) throw new Error(`chat index ${target} out of range`)
      await row.click()
    } else {
      const s = String(target).trim()
      if (/^https?:\/\//i.test(s)) {
        await p.goto(s, { waitUntil: 'domcontentloaded', timeout: LAUNCH_TIMEOUT })
      } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
        await p.goto(`https://muse.ai/thread/${s}`, { waitUntil: 'domcontentloaded', timeout: LAUNCH_TIMEOUT })
      } else {
        await this.gotoApp()
        const row = p.locator(SELECTORS.threadRow, { hasText: s }).first()
        if (!(await row.count())) throw new Error(`no chat matching "${s}"`)
        await row.click()
      }
    }
    await sleep(1200)
    await this.waitForComposer()
    return { ok: true, url: p.url() }
  }

  /** Read messages of the currently open chat. */
  async readChat(max = 100) {
    return this._serial(() => this._readChat(max))
  }

  async _readChat(max = 100) {
    const p = await this.requirePage()
    const all = await p.locator(SELECTORS.message).evaluateAll((els) =>
      els
        .map((el) => {
          const text = (el.innerText || '').replace(/^(You:|User message:|Assistant message:)\s*/i, '').trim()
          const media = [...new Set(
            [...el.querySelectorAll('a[href], img[src], video[src], source[src]')]
              .map((n) => n.href || n.currentSrc || n.src || (n.getAttribute && n.getAttribute('src')))
              .filter((u) => u && /^(https?:|blob:)/i.test(u)),
          )]
          return { role: el.getAttribute('data-message-role') || '', text, ...(media.length ? { media } : {}) }
        })
        .filter((m) => m.text || (m.media && m.media.length)),
    )
    return { messages: all.slice(-max), count: all.length, threadUrl: p.url() }
  }

  /** Extract media links (images/videos/attachments) from a chat's messages, optionally downloading. */
  async chatMedia(chat, opts = {}) {
    return this._serial(() => this._chatMedia(chat, opts))
  }

  async _chatMedia(chat, { download = false, dir } = {}) {
    const p = await this.requirePage()
    if (chat !== undefined && chat !== null && chat !== '') await this._openChat(chat)
    else await this.gotoApp()
    const items = await p.locator(SELECTORS.message).evaluateAll((els) =>
      els
        .map((el, index) => {
          const role = el.getAttribute('data-message-role') || ''
          const urls = [...new Set(
            [...el.querySelectorAll('a[href], img[src], video[src], source[src]')]
              .map((n) => n.href || n.currentSrc || n.src || (n.getAttribute && n.getAttribute('src')))
              .filter((u) => u && /^(https?:|blob:)/i.test(u)),
          )]
          const text = (el.innerText || '').replace(/^(You:|User message:|Assistant message:)\s*/i, '').replace(/\s+/g, ' ').trim()
          return { index, role, text: text.slice(0, 120), urls }
        })
        .filter((m) => m.urls.length),
    )
    const all = [...new Set(items.flatMap((m) => m.urls))]
    const result = { items, urls: all, count: all.length, threadUrl: p.url() }
    if (download && all.length) result.downloads = await this._downloadMedia(all, dir)
    return result
  }

  async downloadMedia(urls, dir) {
    return this._serial(() => this._downloadMedia(urls, dir))
  }

  async _downloadMedia(urls, dir) {
    const outDir = dir || path.join(__dirname, 'downloads')
    fs.mkdirSync(outDir, { recursive: true })
    const p = this.page
    const saved = []
    for (const u of urls) {
      try {
        let buf = null
        let mime = ''
        // Prefer fetching inside the page: handles blob: URLs and cookie-authed http.
        if (p && !p.isClosed()) {
          const r = await p.evaluate(async (url) => {
            try {
              const res = await fetch(url)
              const ab = await res.arrayBuffer()
              const bytes = new Uint8Array(ab)
              let s = ''
              const CH = 0x8000
              for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
              return { ok: res.ok, status: res.status, mime: res.headers.get('content-type') || '', b64: btoa(s), len: bytes.length }
            } catch (e) { return { ok: false, error: String(e) } }
          }, u)
          if (r && r.ok && r.b64) { buf = Buffer.from(r.b64, 'base64'); mime = r.mime }
          else if (r && r.error) throw new Error(r.error)
        }
        if (!buf) {
          const res = await fetch(u)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          buf = Buffer.from(await res.arrayBuffer())
          mime = res.headers.get('content-type') || ''
        }
        const ext = mime.includes('mp4') ? '.mp4' : mime.includes('webm') ? '.webm' : mime.includes('webp') ? '.webp'
          : mime.includes('png') ? '.png' : (mime.includes('jpeg') || mime.includes('jpg')) ? '.jpg' : mime.includes('gif') ? '.gif' : ''
        let name = 'media'
        try { name = decodeURIComponent(new URL(u).pathname.split('/').pop() || 'media') } catch { /* blob: -> uuid */ }
        if (!path.extname(name)) name += ext || '.bin'
        const dest = path.join(outDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${name}`)
        fs.writeFileSync(dest, buf)
        saved.push({ url: u.startsWith('blob:') ? 'blob' : u, file: dest, bytes: buf.length, mime })
      } catch (e) {
        saved.push({ url: u.startsWith('blob:') ? 'blob' : u, error: String((e && e.message) || e) })
      }
    }
    return { dir: outDir, saved }
  }

  /** Diagnostic: dump transcript HTML so selectors can be re-verified. */
  async dumpDom(maxChars = 20000) {
    return this._serial(() => this._dumpDom(maxChars))
  }

  async _dumpDom(maxChars = 20000) {
    const p = await this.requirePage()
    await this.gotoApp()
    const info = await p.evaluate((sels) => {
      const pick = (s) => document.querySelector(s)
      const log = pick('[role="log"]')
      const first = pick('[data-message-item]')
      const container = log || (first && first.parentElement) || document.body
      return {
        url: location.href,
        title: document.title,
        counts: {
          messages: document.querySelectorAll(sels.message).length,
          assistant: document.querySelectorAll(sels.assistant).length,
          user: document.querySelectorAll(sels.user).length,
          editor: document.querySelectorAll(sels.editor).length,
        },
        hasApproval: !!document.querySelector(sels.approvalStack),
        html: container.outerHTML,
      }
    }, SELECTORS)
    return { ...info, html: (info.html || '').slice(0, maxChars) }
  }

  async close() {
    if (this.browser) {
      // CDP-attached: disconnect only, never kill the user's browser.
      await this.browser.close().catch(() => {})
      this.browser = null
      this.ctx = null
      this.page = null
      return { ok: true, disconnected: true }
    }
    if (this.ctx) {
      await this.ctx.close().catch(() => {})
      this.ctx = null
      this.page = null
    }
    return { ok: true }
  }
}

export const driver = new MuseDriver()
export default driver

function failOnSorry(r) {
  if (isMuseSorry(r && r.reply)) throw museSorryError(r.reply)
  return r
}
