# AGENTS.md — Muse-Chat-MCP

Guidance for AI coding agents working in this repository.

## What this is

MCP server + OpenAI-compatible HTTP shim that expose Meta Muse (`muse.ai`, "Hatch").
Two interchangeable backends selected by `MUSE_TRANSPORT`:

- `browser` (default) — drive a real, logged-in Chrome with Playwright.
- `noise` — headless pure-Node client (no browser) over the encrypted Noise WebSocket.

See `README.md` for usage.

## Map

- `muse-env.mjs` — dependency-free `.env` loader (real env wins over the file) plus
  `accountCreds(id)` for `MUSE_ACCOUNT_<ID>_*` keys. It is the only reader of credentials;
  import it **first** in any entry point that reads `MUSE_*` at load time.
- `muse-transport.mjs` — `MUSE_TRANSPORT` switch; facade both backends expose the same
  methods the server/shim call (`status`/`login`/`chat`/`chatStream`/`readLast`/`readChat`/`usage`/`close`),
  each taking an optional trailing `opts`/`opts.account` (browser ignores it). `NoiseTransport` is an
  account pool (`MUSE_ACCOUNTS` = bare ids → `./accounts/<id>`, or `id=path`, or `*` = every profile folder of
  `MUSE_ACCOUNTS_DIR`, re-scanned at most every `MUSE_ACCOUNTS_RESCAN_SEC` by `_rescan`; base `MUSE_ACCOUNTS_DIR`):
  one `MuseNoiseClient` per account, `grabCookies(profileDir)`.
- `muse-driver.mjs` — browser driver (selectors, `_run`/`chat`/`chatStream`, `_serial`, `usage`,
  `login` = unattended Meta sign-in via `muse-mailtemp.mjs` (or `muse-genmail.mjs` / `muse-luuvan.mjs` / `muse-tuan89.mjs` when `OTP_URL` is generator.email / luuvan.site / tuan89.site) when creds present, else manual wait);
  `clearStaleSingleton()` unlinks Chrome's `Singleton{Lock,Socket,Cookie}` when the owning PID is
  gone or was recycled by a non-Chrome process, so a hard-killed server does not wedge the profile.
- `muse-mailtemp.mjs` — mailtemp.vn client for OTP-based auto-login; public API (`x-api-key`,
  `GET /api/code/{email}`) preferred, mailbox-password flow (`/api/site/unlock` → `/api/site/inbox`)
  as fallback (a web-made box has no password: its open token goes in `MAIL_TOKEN` and unlock is skipped). Normalizes messages to `{id, code, from, subject}` and exposes `waitForCode(seen)`.
- `muse-genmail.mjs` — generator.email reader (`GeneratorEmail extends MailTemp`): no API, so it opens the inbox
  page in its own Chromium with a desktop UA (HeadlessChrome gets rate-limited) and parses `#email-table` rows;
  the OTP is in the subject. `close()` after login.
- `muse-luuvan.mjs` — luuvan.site reader (`LuuVan extends MailTemp`) over its public JSON API
  (`/api/public/inbox?address=`); code from the subject, else the body (6–8 digits: the footer has "© 2026", zip 94025).
- `muse-tuan89.mjs` — tuan89.site reader (`Tuan89 extends MailTemp`) over its public JSON API
  (`/api/temp-mail/inbox?email=`, the site fills `otp_code`); code from the subject, else `otp_code`.
- `muse-addmail.mjs` — adds a fresh mailtemp box as a Meta contact email (Accounts Center → Add email → code) and
  points the account's `.env` lines at it; called by `transport.login` after a seed sign-in on a non-mailtemp address,
  CLI for pool accounts. `muse-seed.mjs` — seed CLI: sign in to `accounts/.<id>` → mailtemp step → rename into the pool.
- `muse-noise.mjs` — headless Noise_XX client: `Noise_XX_25519_AESGCM_SHA256` handshake,
  protobuf HTTP/2-mux framing, REST bootstrap, `chatHistory`/`chatSubscribe`/`chat`/`usage`.
- `muse-server.mjs` — MCP stdio server (12 tools incl. `muse_usage`) + shim bootstrap;
  `--self-test`, `--dump-dom`, `--serve-only`.
- `muse-openai-shim.mjs` — OpenAI shim (`/v1/models`, `/v1/chat/completions`, `response_format`
  structured output, `/v1/muse/chats|chat|media|usage`).
- `muse-cli.mjs` — CLI over the shim (`--json-schema` forces schema-valid JSON, `--usage` prints the meter).
- `tools/capture-noise.mjs` — Playwright capture harness (login + WS frames + JS bundles).
- `tools/noise-chat.mjs` — end-to-end test of the headless client (`--history`, `MUSE_DUMP_EVENTS=1`).
- `tools/discover-usage.mjs` / `tools/capture-subaction.mjs` — recon: open Settings→Usage, read the
  rendered meter, and capture the `fetchSubscriptionAction` RSC request/response (re-run after a
  redeploy to refresh `MUSE_SUBSCRIPTION_ACTION_ID`).
- `docs/index.html` — GitHub Pages landing page.

## Invariants (do not break)

- CDP-attached sessions **disconnect only** on close — never kill the user's browser.
- All browser work is serialized through `driver._serial`.
- Multi-account is **noise-only**: `MUSE_ACCOUNTS` pools one client per account (own connection +
  quota); route via `x-muse-account`/`account`/`?account=` (default = first); serialize **per account**
  (`NoiseTransport._serial(a, …)`), different accounts run in parallel. Browser stays single-account.
- Load balancing (noise): requests that do NOT name an account are spread by `MUSE_ACCOUNT_LB`
  (`round_robin` default when >1 | `least_conn` | `first`/`none`); an explicit `x-muse-account`/`account`
  always pins its account, and a failed candidate fails over to the next (`_turnWithFailover`). An account out of
  quota (`_depleted`: usage meter read every `MUSE_QUOTA_CHECK_SEC` by `_checkQuotas`, on first connect, and on
  every `usage()` call) is not an LB candidate; all out → `quotaExhausted` → shim `503 insufficient_quota`.
  An account Muse signed out (`sessionExpired`: `hatchAdmissionInvalidated`, "session has expired", `401 Authentication
  required`, "web checkpoint" — from a turn, a meter read or `usage()`) leaves the pool too (`_expire`) and is signed in
  again (`_relogin`, `MUSE_AUTO_RELOGIN=0` off): headless `MuseDriver.login` with its `.env` creds into a FRESH hidden
  profile `.<id>.relogin` (the old profile stalls on "Authentication is unavailable"), swapped in by two back-to-back
  `renameSync` (old kept as `.<id>.expired`); one sign-in at a time, failures back off `MUSE_RELOGIN_BACKOFF_MIN` (5)
  doubling to `MUSE_RELOGIN_BACKOFF_MAX_MIN` (60). `/health` shows it as `signedOut`. An account whose VM Meta disabled
  (`/api/session` `vm_state: DISABLED`, wake 409, WS 502; muse.ai shows "Muse is disconnected … submit a feedback ticket")
  fails `connect()` with `vmDisabled` and leaves the pool too (`_disable`, `/health` `vmDisabled`); its `/api/session` is
  read again every `MUSE_VM_RECHECK_MIN` (30) and it comes back once the VM is not DISABLED. Every cookie read is a Chromium
  launch (logged `cookies: <id> read from its profile`), so only `_expire` drops an account's cookies: an LB failover
  just sets the cooldown, and `usage()` on a signed-out account fails at once instead of opening its profile. Reads
  (`list_chats`/`usage`/…) stay pinned to the default for determinism — LB applies to `chat`/`chatStream`.
- Streaming emits only **monotonic, stability-quieted** text; exactly one `finish_reason`.
- Tool calling is **decision-only** (Muse must not actually execute the tool).
- Prompts are sent **verbatim** — never add `### USER/### ASSISTANT` roleplay markers or a
  "continue the conversation" wrapper; Muse flags those as prompt-injection and refuses.
- Structured output (`response_format` `json_object`/`json_schema`) is prompt-injected, Ajv-validated,
  and retried up to `MUSE_SCHEMA_RETRY` (default 2); the schema directive is appended, but the verbatim
  rule (no roleplay markers) still applies to the user's own text.
- Usage/credits (`muse_usage` / `--usage` / `transport.usage()`) comes from the Next.js RSC server
  action `fetchSubscriptionAction`, NOT a noise route (it is absent from the route table). POST the
  action id to the app origin with `accept: text/x-component` + `content-type: text/plain` +
  `next-action` and full browser client-hint headers (`sec-ch-ua*`, `accept-encoding`, `accept-language`)
  or Cloudflare returns `403 Forbidden`; parse the flight result from the `1:` line. The action id is a
  build-specific hash: on `404 Server action not found` (a Muse redeploy) `usage()` walks the app's public JS
  chunks for `createServerReference("<id>", …, "fetchSubscriptionAction")` (one walk for all accounts, ≤1 per
  10 min) and reads again; `MUSE_SUBSCRIPTION_ACTION_ID` sets the starting id, `tools/capture-subaction.mjs` is the
  manual fallback.
- One browser per account, sign-in to chat: every request to Muse/Meta shows the UA + `sec-ch-ua*` of the Chromium in
  use, read once per process by `browserIdentity()` (muse-driver; `HeadlessChrome/` read as `Chrome/`). Browser launches
  set Playwright's `userAgent` from it (keeps the client hints; `--user-agent` drops the full version list) and
  `grabCookies` hands it to the noise client (`useBrowserIdentity`), whose REST/RSC fetches send UA + `sec-ch-ua*` and
  whose WS handshake sends the UA only (Chrome sends no client hints there). Never hard-code a UA for a Muse request.
- `MUSE_TLS=wreq` (noise): every REST call goes through `MuseNoiseClient.http()` (wreq-js preset `chrome`, own pool per
  client — accounts never share a connection — `disableDefaultHeaders`, headers in Chrome's order) and the Noise WS through
  `wreq.websocket` with NO preset (a preset adds its navigation headers + a Chrome-149 `sec-ch-ua` to the upgrade) and the
  hello spelled out in `WS_TLS` (`tlsOptions` replace a preset's TLS, they do not layer). Never call the global `fetch`
  or `ws` directly in muse-noise. Check a change by capturing the ClientHello locally (JA4), never against a third-party echo.
  wreq's newest preset is Chrome 149, so `MUSE_TLS=wreq` MUST pair with `MUSE_CHROME_PATH=<Chrome-for-Testing 149>` (the
  sign-in/cookie browser, which `browserIdentity()` reads the UA from): UA and TLS both say 149, no 153-UA-over-149-TLS tell.
  `rest()` sends `content-type`/`origin` only on a non-GET and `priority: u=1, i` (Chrome's fetch headers); do not add
  `content-type` or `origin` to a GET. Residual, unfixable in wreq: the WS upgrade omits `Sec-WebSocket-Extensions:
  permessage-deflate` (wreq has no permessage-deflate — offering it would break frames if the gateway accepted it), and
  the ML-DSA sigalgs + trust-anchors extension of Chrome 153 cannot be set (why 149, not 153).
- Attachments go on the hidden composer `input[type="file"]` via `setInputFiles`.
- **Never** commit secrets: no `accounts/` (Chrome/Muse profiles), no `*.har`, no tokens.
- Credentials **never** live in code — `.env` (git-ignored) or the real environment is the
  only source, read solely through `muse-env.mjs`. Per-account sign-in uses
  `MUSE_ACCOUNT_<ID>_*` keys; adding an account means adding its `.env` entry, not editing a file.

### Noise-transport specifics (hard-won, do not regress)

- msg3 `se` DH is `DH(client_static, server_EPHEMERAL)` — the first 32 bytes of msg2, NOT
  the server static. Getting this wrong makes the server close right after msg3 (1006).
- msg1 payload (34-byte nonce protobuf) travels **in the clear** — the cipherstate is not
  keyed until the first `mixKey` (matches the real client; protocol name zero-padded to 32,
  not hashed into the initial key).
- `encodeMessage` has no oneof awareness: set the oneof member field directly
  (`{stream_id, request: appReq}`), or the server resets the stream with `PROTOCOL_ERROR`
  "empty frame kind".
- `ServiceFrame` oneof includes `reset` (field 5); handle it — a reset is a stream error.
- The reply is NOT in the `chat.stream` response body (that is just a `{message_id}` ack).
  It arrives on the persistent `chat.subscribe` stream as NDJSON events: `delta.text_append`
  (`payload.text`) accumulates the reply, `delta.message_done` (`payload.transcript`) is final.
- Subscribe body needs `capabilities` (see `DEFAULT_CAPS`); frames are chunked
  `NoiseTransportFrame` reassembled by `chunk_id` (max 256 chunks, `CHUNK_MAX` 65489).
- Body-bearing requests MUST send a `content-type: application/json` header in the
  `ApplicationRequest.headers` — without it the gateway returns `415`.
- All-or-nothing attachments: `_run` reads every ref up front (unreadable → `badInput` → 400, no failover) and
  `_uploadAll` must upload all of them before `chat` — never send a turn with fewer images (Muse still answers 200 and
  schema-valid about what it got). A failed upload on a live connection is retried in place and does NOT close the
  connection (it carries the account's other turns); a dead one fails the attempt.
- Attachments: `POST /fs/write` `{path:"workspace/user/files/<name>", data_base64,
  overwrite, create_parent}` (chunk 512 KiB, append for later parts), then reference the
  file in the message text as `![alt](sandbox://workspace/user/files/<name>)`.
- The model sees an attachment only by opening that sandbox file with its own tool, and every file is linked
  at the END of the message. `buildPrompt` therefore leaves `[attachment-<n>]` where each attached part was
  (n = collectFiles order = `readRef`'s `attachment-<n>` name for a data: URL, else the link's alt label) and
  ends with `attachmentNote` (open the files). `fileRef` is the ONE rule for both collectFiles and the markers;
  a message's text is built only where the prompt shows it. Without markers (28/10/2026) Muse mapped images to
  the wrong question when a batch lacked per-question image counts, and skipped images on feed posts.
- Muse's viewer draws transparency BLACK. `_run` passes every file it read through `flattenTransparent`
  (muse-image.mjs) before `_uploadAll`: a PNG, GIF or still WebP with transparent pixels becomes an opaque PNG
  (`<name>.png`, same attachment number), anything else is sent as it is, and a file that does not decode never
  blocks the turn. Flattening runs on the event loop of every turn: keep the guards listed in the module header
  (pixel / row caps, interlace inflate cap, single IHDR, GIF screen growth and LZW loop check) when touching it.
- Generated media lives in `delta.presentation` events (live AND in `chat.history`):
  `payload.data.{images,videos,files}[]` each `{path:"sandbox://workspace/…", mime, label}`;
  download with `GET /fs/raw/workspace/<path>` (binary).
- Cancel = `POST /chat/cancel` `{session_id}` for a side thread, `{}` for the primary session
  → `{cancelled, message_id}`; Muse then ends the turn with `delta.message_done` (the composer's stop
  button). The shim aborts a request whose client hung up (`res` closed before it finished): the
  `signal` reaches `_chatOnce`, which sends `chat.cancel`, and the abort skips `chat` retries,
  LB failover, the account cooldown and schema retries.
- `list_chats` = `GET /api/session/list` → `result.sessions[]` (`title`, `session_id`,
  `is_primary`, `snippet`, `pinned`). `open_chat`/`dump_dom` stay browser-only.
- Concurrency: reads (`list_chats`/`chat_media`/`history`/`fs`) multiplex safely on one
  connection (each gets its own `stream_id`, pump dispatches by id). Chat on the SHARED
  active session does NOT — every turn subscribes to the same feed and cross-contaminates,
  so the facade serializes those via `_serial` (like the browser driver); `ensure()`
  reconnects when the WS is no longer OPEN and `_run` retries once on a dead-connection error.
- Stream cap: the gateway allows ~256 open streams per connection (the 258th gets
  `reset code=3 too many concurrent streams` and the connection drops with 1006). A
  `chat.subscribe` never ends on its own, so the client closes it with a frame
  `{stream_id, reset:{code:8}}` (`resetStream`, like HTTP/2 RST_STREAM) — sent by the feed's
  `stop()`, on a request timeout, and when the ack fails after subscribing. Without it every turn
  leaks one stream and a busy account loses its connection every ~256 turns.
- New side chat per request (`new_thread` / `x-muse-thread: new` / `opts.newSession`):
  generate a fresh `session_id` (uuid), `chat.stream` FIRST (server materializes the thread,
  `is_thread:true`), THEN `chat.subscribe` with that `session_id` — the reverse order yields
  zero events for a not-yet-existing session. Each such turn has its own feed, so concurrent
  new-session turns run in PARALLEL on one connection, isolated. Verified 2- and 3-way
  (facade + shim `x-muse-thread: new`) → `isolated=true`, distinct `session_id`s.

## Verify changes

```bash
pnpm selftest                                   # browser transport (default)
MUSE_TRANSPORT=noise pnpm selftest              # noise transport (headless)
node muse-cli.mjs "Say hello in three words."      # CLI over the shim
MUSE_TRANSPORT=noise node tools/noise-chat.mjs     # headless client e2e
```

