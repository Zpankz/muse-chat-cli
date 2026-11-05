#!/usr/bin/env node
/**
 * muse-openai-shim.mjs
 * ------------------------------------------------------------------
 * OpenAI-compatible HTTP shim over the Muse browser transport.
 *
 *   GET  /v1/models              -> model list
 *   POST /v1/chat/completions    -> OpenAI chat completions (stream + non-stream)
 *   GET  /health                 -> browser/login state
 *   GET|POST /v1/muse/keys[/<id>], DELETE /v1/muse/keys/<id> -> API keys (this machine only)
 *
 * Who may call: a request from this machine (127.0.0.1 / ::1) needs no key unless MUSE_SHIM_AUTH_LOCAL=1. One from
 * any other machine (MUSE_SHIM_HOST=0.0.0.0) needs a key (`Authorization: Bearer <key>` or `x-api-key`) from
 * muse-shim-keys.mjs, and may only use /v1/models + /v1/chat/completions: the /v1/muse/* routes (accounts' chats,
 * usage, pausing, keys) answer this machine only. No key made = no other machine gets in.
 *
 * Why a shim: Muse has no OpenAI-compatible API (encrypted Noise WebSocket),
 * so we translate OpenAI requests into a prompt sent via muse-driver, then
 * translate the reply back into OpenAI JSON / SSE.
 *
 * Patterns (SSE chunk shape, /v1 error objects, stream headers) mirror
 * Chat2API's deepseek-stream.ts + routes/chat.ts.
 *
 * Streaming is real: chatStream() reports incremental DOM text, which we
 * re-emit as OpenAI deltas (first token appears when Muse starts answering).
 *
 * Prompt-injected tool calling (experimental): if `tools` are supplied, their
 * schemas are embedded in the prompt and Muse is asked to answer with either
 * normal text or {"tool_calls":[{"name","arguments"}]}; the latter is parsed
 * into OpenAI tool_calls.
 *
 * Structured output: `response_format` (OpenAI `json_object` / `json_schema`)
 * constrains the reply to schema-valid JSON — the schema is injected into the
 * prompt, the reply is extracted, validated with Ajv, and retried on failure.
 * ------------------------------------------------------------------
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { transport } from './muse-transport.mjs'
import { KeyStore } from './muse-shim-keys.mjs'

const PORT = Number(process.env.MUSE_SHIM_PORT || 8787)
const HOST = process.env.MUSE_SHIM_HOST || '127.0.0.1'
const DEFAULT_TIMEOUT_MS = Number(process.env.MUSE_SHIM_TIMEOUT_MS || 240000)
const MODEL_IDS = (process.env.MUSE_SHIM_MODELS || 'muse-spark-1.3,muse-spark-1.3-contributor,muse')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const keys = new KeyStore({
  file: process.env.MUSE_SHIM_KEYS_FILE || path.join(path.resolve(__dirname, process.env.MUSE_ACCOUNTS_DIR || 'accounts'), '.api-keys.json'),
  envKey: process.env.MUSE_SHIM_API_KEY || '',
})
const AUTH_LOCAL = process.env.MUSE_SHIM_AUTH_LOCAL === '1'
const LOCAL_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const log = (...a) => console.error('[muse-shim]', ...a)
const rid = () => `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const now = () => Math.floor(Date.now() / 1000)
const approxTokens = (s) => Math.max(1, Math.ceil((s || '').length / 4))

// ---------------------------------------------------------------- prompt build

function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && (p.text ?? p.content ?? '')))
      .filter(Boolean)
      .join('\n')
  }
  return String(content)
}

// Where each attached file sits in the prompt (28/10/2026). Over noise an attachment is a FILE uploaded to Muse's sandbox
// and linked at the END of the message (`![](sandbox://…/attachment-<n>_….png)`): the model sees an image only once it
// opens that file with its own tools. textOf() dropped the image parts, so a caller that interleaves images with text (moon
// KG: question 1 text, its image, question 2 text…) lost which image belongs where, and nothing asked Muse to open the
// files — it answered without them ("no image attached", made-up readings). An attached part now leaves the marker
// [attachment-<n>] in the text (n = its place in collectFiles order, which also names the uploaded file) and a closing
// note asks Muse to open every file. Header `x-muse-image-markers: off` (body `muse_image_markers: false`, or
// MUSE_SHIM_IMAGE_MARKERS=0 for every request) sends the prompt as before. On by default over noise only: the browser
// transport attaches files through the composer, not as links at the end of the message, so the note would be wrong there.
const isOff = (v) => ['0', 'off', 'false', 'no'].includes(String(v).split(',')[0].trim().toLowerCase())
const IMAGE_MARKERS = process.env.MUSE_SHIM_IMAGE_MARKERS
  ? !isOff(process.env.MUSE_SHIM_IMAGE_MARKERS)
  : (process.env.MUSE_TRANSPORT || 'browser').toLowerCase() === 'noise'

function imageMarkersFor(req, body) {
  const h = req.headers['x-muse-image-markers'] // a repeated header arrives joined: "off, off"
  const v = String(h || (body.muse_image_markers ?? '')).trim()
  return v ? !isOff(v) : IMAGE_MARKERS
}

// Text of a message with each attached part replaced by [attachment-<n>]; `first` = files before this message in
// collectFiles order.
function textWithMarkers(content, first) {
  if (!Array.isArray(content)) return textOf(content)
  let n = first
  return content
    .map((p) => (typeof p === 'string' ? p : fileRef(p) ? `[attachment-${++n}]` : p && (p.text ?? p.content ?? '')))
    .filter(Boolean)
    .join('\n')
}

// `marked`: some [attachment-k] shows in the prompt (not so for files of body.files only, or images of earlier turns when
// the prompt shows the last message only). `tools`: the caller's tool list is in the prompt — "your file viewing tool"
// must not read as one of THOSE (a read(path: "attachment-1") call the client cannot run), and an agent loop resends every
// image each turn, so only the files the request needs are to be opened.
function attachmentNote(n, { marked = true, tools = false } = {}) {
  const open = tools
    ? 'Open the attached files the request needs with your own built-in file / image viewer (not one of the tools listed ' +
      'above) and look at them before answering; never guess what an image shows.'
    : n === 1
      ? 'Open it with your file / image viewing tool and look at it before answering; never guess what it shows.'
      : 'Open EVERY attached file with your file / image viewing tool and look at it before answering; never guess what an ' +
        'image shows.'
  if (n === 1) {
    return 'One file is attached to this message: it is linked at the end of the message (attachment-1)' +
      (marked ? ', and [attachment-1] in the text marks where it belongs. ' : '. ') + open
  }
  return `${n} files are attached to this message: they are linked at the end of the message in order, attachment-1 … ` +
    `attachment-${n}` + (marked ? ', and a marker [attachment-k] in the text marks where file k belongs. ' : '. ') + open
}

export function buildPrompt(body, { markers = IMAGE_MARKERS } = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  // files of body.files come first in collectFiles, then the parts of every message in order; first[i] = files before
  // message i. A message's text is built only where the prompt shows it, as before (a part never shown cannot fail it).
  let fileNo = Array.isArray(body.files) ? body.files.filter(Boolean).length : 0
  const first = messages.map((m) => {
    const before = fileNo
    if (m && Array.isArray(m.content)) for (const p of m.content) if (fileRef(p)) fileNo++
    return before
  })
  const textAt = (i) => (markers ? textWithMarkers(messages[i].content, first[i]) : textOf(messages[i].content))
  const system = messages.map((m, i) => (m.role === 'system' ? textAt(i) : '')).filter(Boolean).join('\n\n')

  // Send the latest user message as a plain message. Roleplay-style role markers
  // ("### USER"/"### ASSISTANT") make Muse push back with "that's a fake transcript".
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUser = i; break }
  }
  const userText = lastUser >= 0 ? textAt(lastUser) : ''
  // Tool rounds after that message (assistant tool_calls + role:"tool" results). Each turn may land on a
  // fresh thread or another pool account, so Muse cannot be relied on to remember the request or the
  // calls: the prompt restates the request and every call with its result.
  const steps = toolSteps(messages.slice(lastUser + 1), (j) => textAt(lastUser + 1 + j))

  const forced = forcedTool(body)
  const tools = Array.isArray(body.tools) ? body.tools : []
  // A tool-using caller (an agent) sends the whole conversation each turn; for the same reason, earlier turns go
  // along as context (the user's name, city, … live there). Without tools the prompt stays the last message only.
  const history = tools.length && body.tool_choice !== 'none'
    ? historyLines(messages.slice(0, Math.max(0, lastUser)), textAt)
    : []
  const parts = []
  if (system) parts.push(system)

  if (forced) {
    parts.push([
      'Decide the tool call(s) for the user\'s request below. You are only DECIDING the call — do NOT perform the action,',
      'do NOT browse, do NOT invent results.',
      schemaDirective({ mode: 'json_schema', schema: forcedToolSchema(body, forced) }),
    ].join('\n'))
  } else if (tools.length && body.tool_choice !== 'none') {
    const schemas = tools.map((t) => t.function || t).map((f) => ({
      name: f.name,
      description: f.description,
      parameters: f.parameters,
    }))
    parts.push(
      [
        'If the request needs a tool, reply with ONLY this JSON and nothing else:',
        '{"tool_calls":[{"name":"<tool name>","arguments":{ ... }}]}',
        'Several independent calls can go in the one array.',
        'You are only DECIDING whether a tool call should be made — do NOT perform the action,',
        'do NOT browse, do NOT invent results. Otherwise reply normally. Tool schemas:',
        JSON.stringify(schemas),
      ].join('\n'),
    )
  }

  const rfInfo = normalizeResponseFormat(body.response_format)
  if (rfInfo) parts.push(schemaDirective(rfInfo))

  if (history.length) {
    parts.push(['Earlier in this conversation (context only, already handled):', ...history].join('\n'))
  }
  if (steps.length) {
    parts.push(`The user's request:\n${userText}`)
    parts.push([
      'Tool calls already made for this request and the results the tools returned (real results, use them as they are):',
      ...steps.map((s, i) => `${i + 1}. ${s}`),
    ].join('\n'))
    parts.push(forced
      ? 'Decide the next tool call from these results; do not repeat a call that already has a result.'
      : 'Now answer the user\'s request from these results, in the language the user wrote in. ' +
        'If you still need another tool, reply with the tool_calls JSON instead; do not repeat a call that already has a result.')
  } else if (userText) parts.push(history.length ? `The user's latest message:\n${userText}` : userText)
  if (markers && fileNo) {
    const marked = parts.some((t) => /\[attachment-\d+\]/.test(t))
    parts.push(attachmentNote(fileNo, { marked, tools: tools.length > 0 && body.tool_choice !== 'none' }))
  }
  return parts.join('\n\n').trim()
}

const HISTORY_MAX_CHARS = Number(process.env.MUSE_SHIM_HISTORY_CHARS || 24000)
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)} …` : s)

// Earlier turns as plain lines ("User: …", "You: …", calls and results), newest kept when over HISTORY_MAX_CHARS.
// `textAt(j)` = msgs[j] as buildPrompt renders it: an image of an earlier turn keeps its [attachment-<n>] marker here.
function historyLines(msgs, textAt = (j) => textOf(msgs[j].content)) {
  const lines = []
  for (const [j, m] of msgs.entries()) {
    if (m.role === 'user') lines.push(`User: ${clip(textAt(j), 2000)}`)
    else if (m.role === 'assistant') {
      const text = textAt(j).trim()
      if (text) lines.push(`You: ${clip(text, 2000)}`)
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const f = c.function || c
        lines.push(`You called ${f.name}(${typeof f.arguments === 'string' ? f.arguments : JSON.stringify(f.arguments ?? {})})`)
      }
    } else if (m.role === 'tool') lines.push(`  -> ${clip(textAt(j), 2000)}`)
  }
  let total = 0
  let i = lines.length
  while (i > 0 && total + lines[i - 1].length <= HISTORY_MAX_CHARS) total += lines[--i].length + 1
  return lines.slice(i)
}

// tool_choice "required" -> '*', {type:'function',function:{name}} -> that name, else null.
function forcedTool(body) {
  if (!Array.isArray(body.tools) || !body.tools.length) return null
  const tc = body.tool_choice
  if (tc === 'required') return '*'
  if (tc && typeof tc === 'object') return (tc.function && tc.function.name) || tc.name || '*'
  return null
}

// JSON Schema of {"tool_calls":[{name, arguments}]} limited to the tools tool_choice allows (an unknown name -> all).
function forcedToolSchema(body, forced) {
  const all = body.tools.map((t) => t.function || t)
  const fns = forced === '*' ? all : all.filter((f) => f.name === forced)
  const item = (f) => ({
    type: 'object',
    ...(f.description ? { description: f.description } : {}),
    required: ['name', 'arguments'],
    properties: { name: { const: f.name }, arguments: f.parameters || { type: 'object' } },
  })
  const list = fns.length ? fns : all
  return {
    type: 'object',
    required: ['tool_calls'],
    properties: { tool_calls: { type: 'array', minItems: 1, items: list.length === 1 ? item(list[0]) : { anyOf: list.map(item) } } },
  }
}

// One Muse turn for a request with tools -> { r, calls }. When tool_choice forces a call, plain instructions are not
// enough (Muse just answers a request that needs no tool), so the reply goes through the structured-output path:
// Ajv against forcedToolSchema, corrective retries.
async function chatForTools(prompt, body, opts) {
  const forced = forcedTool(body)
  if (forced) {
    const schema = forcedToolSchema(body, forced)
    const out = await runStructured(prompt, { mode: 'json_schema', schema, name: 'tool_calls' }, compileValidator(schema), opts)
    const reply = JSON.stringify(out.obj)
    return { r: { reply, account: out.account, sessionId: out.sessionId }, calls: parseToolCalls(reply) }
  }
  const r = await transport.chat(prompt, opts)
  return { r, calls: r.error && !r.reply ? null : parseToolCalls(r.reply) }
}

// Lines for the tool rounds after the user's message: each call with its result (matched by tool_call_id,
// else by order), plus any text the assistant wrote alongside its calls. `textAt` as in historyLines (a tool result
// that carries an image keeps its [attachment-<n>] marker).
function toolSteps(msgs, textAt = (j) => textOf(msgs[j].content)) {
  const calls = []
  const byId = new Map()
  const notes = []
  for (const [j, m] of msgs.entries()) {
    if (m.role === 'assistant') {
      const text = textAt(j).trim()
      if (text) notes.push({ at: calls.length, text })
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const f = c.function || c
        let args = f.arguments ?? {}
        if (typeof args !== 'string') args = JSON.stringify(args)
        const call = { name: f.name || '?', args, result: null }
        calls.push(call)
        if (c.id) byId.set(c.id, call)
      }
    } else if (m.role === 'tool') {
      const call = byId.get(m.tool_call_id) || calls.find((c) => c.result == null && (!m.name || c.name === m.name))
      const result = textAt(j)
      if (call) call.result = result
      else calls.push({ name: m.name || 'tool', args: null, result })
    }
  }
  const lines = []
  calls.forEach((c, i) => {
    for (const n of notes) if (n.at === i) lines.push(`(you wrote) ${n.text}`)
    lines.push(`${c.name}(${c.args ?? ''}) -> ${c.result == null ? '(no result yet)' : c.result}`)
  })
  for (const n of notes) if (n.at >= calls.length) lines.push(`(you wrote) ${n.text}`)
  return calls.length ? lines : []
}

function parseToolCalls(text) {
  if (!text) return null
  const trimmed = text.trim()
  // Accept a bare JSON object or one inside a ```json fence. The bare object goes first: a call that writes a
  // Markdown file carries ``` fences inside its "content" string, and a fence match would cut the JSON there.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i) || trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const at = trimmed.indexOf('{"tool_calls"')
  const candidates = [trimmed, fenced && fenced[1].trim(), at >= 0 && balancedJson(trimmed, at)].filter(Boolean)
  let obj
  for (const c of candidates) {
    if (!c.startsWith('{') || !c.endsWith('}')) continue
    try { obj = JSON.parse(c); break } catch {}
  }
  const calls = (obj && (obj.tool_calls || obj.toolCalls)) || (at >= 0 ? salvageCalls(trimmed, at) : null)
  if (!Array.isArray(calls) || !calls.length) return null
  return calls
    .map((c, i) => {
      const name = c.name || c?.function?.name
      if (!name) return null
      const args = c.arguments ?? c?.function?.arguments ?? {}
      return {
        id: `call_${Date.now().toString(36)}${i}`,
        type: 'function',
        function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      }
    })
    .filter(Boolean)
}

// ---------------------------------------------------------------- structured output

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const _validatorCache = new Map()

function compileValidator(schema) {
  const key = JSON.stringify(schema)
  let v = _validatorCache.get(key)
  if (!v) {
    const validate = ajv.compile(schema)
    v = (data) => { const ok = validate(data); v.errors = validate.errors; return ok }
    _validatorCache.set(key, v)
  }
  return v
}

// Accept OpenAI `response_format` shapes: {type:"json_object"}, {type:"json_schema",
// json_schema:{name,schema,strict}}, or a bare schema object. Returns null when no
// constraint applies.
function normalizeResponseFormat(rf) {
  if (!rf || typeof rf !== 'object') return null
  if (rf.type === 'text') return null
  if (rf.type === 'json_object') return { mode: 'json_object', schema: null, name: 'response' }
  if (rf.type === 'json_schema' || rf.type === 'jsonSchema') {
    const js = rf.json_schema || rf.jsonSchema || rf.schema
    if (js && typeof js === 'object') {
      if (js.schema && typeof js.schema === 'object') return { mode: 'json_schema', schema: js.schema, name: js.name || 'response' }
      if (js.type || js.properties || js.$schema) return { mode: 'json_schema', schema: js, name: js.name || 'response' }
    }
    return { mode: 'json_object', schema: null, name: 'response' }
  }
  if (rf.type || rf.properties || rf.$schema) return { mode: 'json_schema', schema: rf, name: 'response' }
  return null
}

function schemaDirective(rfInfo) {
  if (rfInfo.mode === 'json_object') {
    return 'Respond with ONLY a single valid JSON object. No prose, no commentary, no markdown code fences.'
  }
  return [
    'Respond with ONLY a single JSON object that validates against the JSON Schema below.',
    'Output raw JSON — no prose, no commentary, no markdown code fences.',
    'Include every required key; do not add keys the schema does not allow.',
    'JSON Schema:',
    JSON.stringify(rfInfo.schema),
  ].join('\n')
}

// Pull the first balanced JSON value out of a reply that may have prose or ``` fences.
function extractJson(text) {
  if (!text) return { ok: false }
  let t = String(text).trim()
  try { return { ok: true, value: JSON.parse(t) } } catch {} // before fences: a string value may hold ``` itself
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  try { return { ok: true, value: JSON.parse(t) } } catch {}
  const start = t.search(/[{[]/)
  if (start < 0) return { ok: false }
  const open = t[start], close = open === '{' ? '}' : ']'
  let depth = 0, inStr = false, esc = false, end = -1
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if (c === open) depth++
    else if (c === close) { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return { ok: false }
  try { return { ok: true, value: JSON.parse(t.slice(start, end + 1)) } } catch { return { ok: false } }
}

// Calls out of a tool_calls reply that is not valid JSON as a whole: Muse sometimes drops the brace that closes
// one call before the next ('..."content":"..."}, {"name":…' when it writes two long files in one reply). Each
// {"name": "…", "arguments": {…}} outside a string is read on its own; the arguments object must parse.
function salvageCalls(t, start) {
  const out = []
  const head = /\{\s*"name"\s*:\s*"([^"\\]+)"\s*,\s*"arguments"\s*:\s*\{/y
  let inStr = false, esc = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if (c !== '{') continue
    head.lastIndex = i
    const m = head.exec(t)
    if (!m) continue
    const argsAt = head.lastIndex - 1
    const raw = balancedJson(t, argsAt)
    if (!raw) break
    try { out.push({ name: m[1], arguments: JSON.parse(raw) }) } catch { return null }
    i = argsAt + raw.length - 1
  }
  return out.length ? out : null
}

// The balanced {...} starting at `start` (strings and escapes respected), or null when it never closes.
function balancedJson(t, start) {
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return t.slice(start, i + 1) }
  }
  return null
}

function corrective(errors, rfInfo) {
  const e = (errors || []).map((x) => (x && x.message ? x.message : String(x))).slice(0, 8).join('; ')
  const tail = rfInfo.mode === 'json_schema' ? `\nSchema:\n${JSON.stringify(rfInfo.schema)}` : ''
  return `\n\nYour previous reply was NOT valid. Return ONLY corrected JSON (raw, no fences). Errors: ${e || 'invalid'}.${tail}`
}

// Ask Muse until the reply parses and (if a schema) validates, or attempts run out.
async function runStructured(basePrompt, rfInfo, validate, opts) {
  const maxAttempts = Math.max(1, (Number(process.env.MUSE_SCHEMA_RETRY) || 2) + 1)
  let prompt = basePrompt
  let last = null
  const accounts = [] // account of each attempt (LB may route retries elsewhere), reported on failure too
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await transport.chat(prompt, opts)
    if (r.account) accounts.push(r.account)
    if (r.error && !r.reply) { const e = new Error(r.error); e.account = r.account; throw e }
    const ex = extractJson(r.reply || '')
    if (!ex.ok) {
      last = { raw: r.reply, errors: ['reply is not valid JSON'] }
      prompt = basePrompt + corrective(last.errors, rfInfo)
      // what the unparseable reply looked like (cut off? prose around the JSON?) — 4,9% of first attempts on 23/10
      const raw = String(r.reply || '')
      log(`schema attempt ${attempt}: parse-fail (${raw.length} chars${r.timedOut ? ', timed out' : ''}${r.account ? `, ${r.account}` : ''}: ${JSON.stringify(raw.slice(0, 80))} … ${JSON.stringify(raw.slice(-80))})`)
      continue
    }
    if (validate) {
      if (validate(ex.value)) { log(`schema attempt ${attempt}: valid${r.account ? ` (${r.account})` : ''}`); return { obj: ex.value, attempts: attempt, account: r.account, sessionId: r.sessionId } }
      const errs = (validate.errors || []).map((v) => `${v.instancePath || '/'} ${v.message}`)
      last = { obj: ex.value, errors: errs }
      prompt = basePrompt + corrective(errs, rfInfo)
      log(`schema attempt ${attempt}: invalid (${errs.length} errors)`)
      continue
    }
    if (ex.value && typeof ex.value === 'object') return { obj: ex.value, attempts: attempt, account: r.account, sessionId: r.sessionId }
    last = { obj: ex.value, errors: ['expected a JSON object'] }
    prompt = basePrompt + corrective(last.errors, rfInfo)
  }
  const err = new Error('Muse did not return schema-valid JSON')
  err.detail = last
  err.account = accounts[accounts.length - 1]
  if (new Set(accounts).size > 1) err.accounts = accounts
  throw err
}

// Collect attachments from an OpenAI-style request:
//   - body.files: ["C:\\img.png", "https://.../v.mp4", { url } | { path } | { buffer, name, mimeType }]
//   - message.content parts: { type: "image_url", image_url: { url } } | { type: "input_image", image_url }
//   - message.content parts: { type: "file", file: { file_url | file_data, filename, mime_type } }
export function collectFiles(body) {
  const out = []
  if (Array.isArray(body.files)) for (const f of body.files) if (f) out.push(f)
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const part of m.content) {
      const ref = fileRef(part)
      if (ref) out.push(ref)
    }
  }
  return out
}

// The file ref of a message part that carries an attachment, else null (buildPrompt numbers the same parts).
function fileRef(part) {
  if (!part || typeof part !== 'object') return null
  const t = part.type
  if ((t === 'image_url' || t === 'input_image') && part.image_url) {
    return { url: typeof part.image_url === 'string' ? part.image_url : part.image_url.url }
  }
  if (t === 'file' && part.file) {
    const f = part.file
    if (f.file_url) return { url: f.file_url }
    if (f.file_data) {
      const d = String(f.file_data)
      if (/^data:/i.test(d)) return { url: d }
      return { buffer: d, name: f.filename || 'file', mimeType: f.mime_type || 'application/octet-stream' }
    }
  }
  return null
}

// ---------------------------------------------------------------- responses

const sseHeaders = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  })
}
const chunk = (id, model, created, delta, finish = null, extra = null) =>
  `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(extra || {}),
  })}` + '\n\n'

function sendError(res, status, message, type = 'invalid_request_error', code = null, param = null, extra = {}) {
  const body = JSON.stringify({ ...extra, error: { message, type, param, code } })
  if (res.headersSent) { try { res.end() } catch {} return }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}

const isLocal = (req) => LOCAL_ADDRS.has(req.socket.remoteAddress)

// The key entry of `Authorization: Bearer <key>` / `x-api-key`, or null. Local callers often send a dummy key
// ("muse-local"): that is fine, it is only checked when the caller has to have one.
function keyOf(req) {
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim()
  return keys.check(bearer || String(req.headers['x-api-key'] || '').trim())
}

// Start an SSE response and return a writer that stops writing once the client
// disconnects, so a mid-stream failure never throws into a dead socket.
function beginStream(res) {
  sseHeaders(res)
  let closed = false
  res.on('close', () => { closed = true })
  return { write: (s) => { if (!closed) { try { res.write(s) } catch { closed = true } } } }
}

// ---------------------------------------------------------------- handler

// Chat requests in progress (their AbortControllers) and the shutdown latch: on SIGTERM the server aborts them all, which
// runs the same path as a caller hanging up — the transport cancels each Muse turn instead of leaving it running unpaid-for.
const openChats = new Set()
let draining = false
export function abortAllChats() {
  draining = true
  const n = openChats.size // each abort removes its own entry
  for (const ac of [...openChats]) ac.abort()
  return n
}

async function handleChat(req, res, body) {
  if (draining) return sendError(res, 503, 'Muse shim is restarting — retry shortly', 'server_error')
  if (!body || typeof body !== 'object') return sendError(res, 400, 'Invalid request body')
  if (!body.model) return sendError(res, 400, 'Missing required field: model', 'invalid_request_error', null, 'model')
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return sendError(res, 400, 'Missing required field: messages', 'invalid_request_error', null, 'messages')
  }

  const model = String(body.model)
  const id = rid()
  const created = now()
  const timeoutMs = Number(req.headers['x-muse-timeout-ms']) || DEFAULT_TIMEOUT_MS
  // Default: continue the current Muse thread and rely on the full transcript we send.
  // Send header `x-muse-thread: new` to start a fresh thread instead.
  const newThread = req.headers['x-muse-thread'] === 'new'
  const account = req.headers['x-muse-account'] || body.account || undefined
  const markers = imageMarkersFor(req, body)
  // transparent images flattened before upload (muse-transport.mjs, muse-image.mjs); `x-muse-flatten: off` keeps the original
  const fv = String(req.headers['x-muse-flatten'] || (body.muse_flatten ?? '')).trim()
  const flatten = fv ? !isOff(fv) : undefined
  const prompt = buildPrompt(body, { markers })
  const wantTools = Array.isArray(body.tools) && body.tools.length > 0 && body.tool_choice !== 'none'
  const stream = body.stream === true
  const rfInfo = normalizeResponseFormat(body.response_format)
  const files = collectFiles(body)
  let chat = req.headers['x-muse-chat'] !== undefined ? req.headers['x-muse-chat'] : body.chat
  if (typeof chat === 'string') {
    const s = chat.trim()
    if (!s) chat = undefined
    else if (/^\d+$/.test(s)) chat = Number(s)
  }

  let streamWriter = null
  // The caller hung up before we answered (client timeout, cancelled job, restarted app):
  // abort so the transport stops the Muse turn instead of running it — and its retries — for nobody.
  const ac = new AbortController()
  res.on('close', () => { if (!res.writableFinished) ac.abort() })
  const signal = ac.signal
  openChats.add(ac)
  signal.addEventListener('abort', () => openChats.delete(ac), { once: true })
  res.on('close', () => openChats.delete(ac))

  log(`chat model=${model} stream=${stream} tools=${wantTools} files=${files.length}${files.length && !markers ? ' (no markers)' : ''} target=${chat !== undefined ? chat : 'current'} account=${account || 'auto'} promptChars=${prompt.length}`)

  try {
    if (rfInfo) {
      let validate = null
      if (rfInfo.mode === 'json_schema') {
        try { validate = compileValidator(rfInfo.schema) }
        catch (e) { return sendError(res, 400, `Invalid JSON Schema: ${e.message}`, 'invalid_request_error', null, 'response_format') }
      }
      // stream: Muse's reply of each attempt goes out while it is written, as `muse_partial` {offset, text} next to an empty
      // delta (OpenAI clients skip the field; the caller keeps text = text.slice(0, offset) + piece, offset < its length =
      // a retry or failover started over), then the validated JSON as content. SSE starts with the first piece, so a turn
      // that fails before Muse writes anything still gets its HTTP status.
      let shown = ''
      const onDelta = stream ? (full) => {
        let at = 0
        const max = Math.min(shown.length, full.length)
        while (at < max && shown.charCodeAt(at) === full.charCodeAt(at)) at++
        if (at === full.length && at === shown.length) return
        if (!streamWriter) {
          streamWriter = beginStream(res)
          streamWriter.write(chunk(id, model, created, { role: 'assistant', content: '' }))
        }
        streamWriter.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          muse_partial: { offset: at, text: full.slice(at) },
        })}\n\n`)
        shown = full
      } : undefined
      const out = await runStructured(prompt, rfInfo, validate, { timeoutMs, newThread, files, chat, account, signal, flatten, onDelta })
      const jsonStr = JSON.stringify(out.obj)
      if (stream) {
        const w = streamWriter || beginStream(res); const first = !streamWriter; streamWriter = w; const write = w.write
        if (first) write(chunk(id, model, created, { role: 'assistant', content: '' }))
        for (let i = 0; i < jsonStr.length; i += 60) write(chunk(id, model, created, { content: jsonStr.slice(i, i + 60) }))
        write(chunk(id, model, created, {}, 'stop', out.sessionId ? { session_id: out.sessionId } : null))
        if (body.stream_options && body.stream_options.include_usage) {
          write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], ...(out.account ? { account: out.account } : {}), ...(out.sessionId ? { session_id: out.sessionId } : {}), usage: { prompt_tokens: approxTokens(prompt), completion_tokens: approxTokens(jsonStr), total_tokens: approxTokens(prompt) + approxTokens(jsonStr) } })}` + '\n\n')
        }
        write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        id, object: 'chat.completion', created, model,
        ...(out.account ? { account: out.account } : {}),
        ...(out.sessionId ? { session_id: out.sessionId } : {}),
        choices: [{ index: 0, message: { role: 'assistant', content: jsonStr }, finish_reason: 'stop' }],
        usage: { prompt_tokens: approxTokens(prompt), completion_tokens: approxTokens(jsonStr), total_tokens: approxTokens(prompt) + approxTokens(jsonStr) },
      }))
      return
    }

    let finishReason = 'stop'
    if (stream) {
      const w = beginStream(res); streamWriter = w; const write = w.write
      write(chunk(id, model, created, { role: 'assistant', content: '' }))
      let emitted = ''
      let r
      if (wantTools) {
        // Buffer so we can decide tool_calls vs content before emitting.
        let calls
        ({ r, calls } = await chatForTools(prompt, body, { timeoutMs, newThread, files, chat, account, signal, flatten }))
        if (r.error) throw new Error(r.error)
        if (calls && calls.length) {
          const deltas = calls.map((c, i) => ({
            index: i, id: c.id, type: 'function',
            function: { name: c.function.name, arguments: c.function.arguments },
          }))
          write(chunk(id, model, created, { tool_calls: deltas }))
          finishReason = 'tool_calls'
        } else {
          const s = r.reply || ''
          for (let i = 0; i < s.length; i += 60) write(chunk(id, model, created, { content: s.slice(i, i + 60) }))
        }
      } else {
        r = await transport.chatStream(prompt, {
          timeoutMs, newThread, files, chat, account, signal, flatten,
          onDelta: (full) => {
            const next = full.startsWith(emitted) ? full.slice(emitted.length) : full
            emitted = full
            if (next) write(chunk(id, model, created, { content: next }))
          },
        })
        if (r.error && !emitted) throw new Error(r.error)
      }

      write(chunk(id, model, created, {}, finishReason, r.sessionId ? { session_id: r.sessionId } : null))
      if (body.stream_options && body.stream_options.include_usage) {
        write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model, choices: [],
          ...(r.account ? { account: r.account } : {}),
          ...(r.sessionId ? { session_id: r.sessionId } : {}),
          usage: { prompt_tokens: approxTokens(prompt), completion_tokens: approxTokens(emitted), total_tokens: approxTokens(prompt) + approxTokens(emitted) },
        })}\n\n`)
      }
      write('data: [DONE]\n\n')
      res.end()
      return
    }

    // Non-streaming
    const { r, calls } = wantTools
      ? await chatForTools(prompt, body, { timeoutMs, newThread, files, chat, account, signal, flatten })
      : { r: await transport.chat(prompt, { timeoutMs, newThread, files, chat, account, signal, flatten }), calls: null }
    if (r.error && !r.reply) throw new Error(r.error)

    const message = calls && calls.length
      ? { role: 'assistant', content: null, tool_calls: calls }
      : { role: 'assistant', content: r.reply || '' }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({
      id, object: 'chat.completion', created, model,
      ...(r.account ? { account: r.account } : {}),
      ...(r.sessionId ? { session_id: r.sessionId } : {}),
      choices: [{ index: 0, message, finish_reason: calls && calls.length ? 'tool_calls' : 'stop' }],
      usage: {
        prompt_tokens: approxTokens(prompt),
        completion_tokens: approxTokens(r.reply),
        total_tokens: approxTokens(prompt) + approxTokens(r.reply),
      },
    }))
  } catch (err) {
    if (signal.aborted) { log('client disconnected after', Math.round((Date.now() - created * 1000) / 1000), 's — turn cancelled'); return }
    // account that ran the failed turn (top-level `account`, as on a success); `accounts` when schema retries moved around
    const who = {
      ...(err && err.account ? { account: err.account } : {}),
      ...(err && err.accounts ? { accounts: err.accounts } : {}),
    }
    log('error:', err && err.message, who.account ? `(${(who.accounts || [who.account]).join(' → ')})` : '')
    // every account is out of quota: 503 (not 502 "Muse error", which callers treat as this turn's failure)
    const quota = !!(err && err.quotaExhausted)
    const bad = !!(err && err.badInput) // a file the caller sent could not be read: 400, not Muse's fault
    let msg = quota ? `Muse quota: ${err.message}` : bad ? `Invalid attachment: ${err.message}` : `Muse error: ${err && err.message ? err.message : String(err)}`
    if (err && err.detail && Array.isArray(err.detail.errors)) msg += ` (last attempt: ${err.detail.errors.slice(0, 6).join('; ')})`
    if (streamWriter) {
      // SSE headers already sent — a JSON error body is impossible. Emit an SSE
      // `event: error` (OpenAI-style error object) then [DONE] so the client
      // terminates cleanly instead of hanging on a silently truncated stream.
      streamWriter.write(`event: error\ndata: ${JSON.stringify({ ...who, error: { message: msg, type: quota ? 'insufficient_quota' : 'api_error', param: null, code: quota ? 'muse_quota_exhausted' : null } })}\n\n`)
      streamWriter.write('data: [DONE]\n\n')
      try { res.end() } catch {}
    } else if (quota) {
      sendError(res, 503, msg, 'insufficient_quota', 'muse_quota_exhausted', null, who)
    } else if (bad) {
      sendError(res, 400, msg, 'invalid_request_error', 'attachment_unreadable', 'messages', who)
    } else {
      sendError(res, 502, msg, 'api_error', null, null, who)
    }
  }
}

// ---------------------------------------------------------------- server

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > limit) { reject(new Error('request body too large')); req.destroy() }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function startShim({ port = PORT, host = HOST, exitOnError = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0]
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': '*',
      })
      return res.end()
    }

    // /v1/*: a caller on this machine passes (unless MUSE_SHIM_AUTH_LOCAL=1), any other needs a key and may not use the
    // /v1/muse/* routes. /health stays open for liveness probes, but tells another machine only `ok` without a key.
    const local = isLocal(req) && !AUTH_LOCAL
    const key = keyOf(req)
    if ((url === '/v1' || url.startsWith('/v1/')) && !local) {
      if (!key) return sendError(res, 401, 'Invalid or missing API key (send Authorization: Bearer <key>)', 'authentication_error', 'invalid_api_key')
      if (url.startsWith('/v1/muse/') && !isLocal(req)) return sendError(res, 403, `${url} answers only the machine the shim runs on`, 'permission_error')
    }

    try {
      if (req.method === 'GET' && (url === '/health' || url === '/') && !local && !key) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify({ ok: true }))
      }

      if (req.method === 'GET' && (url === '/health' || url === '/')) {
        let st = { browserRunning: false, loggedIn: false }
        try { st = await transport.status() } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify({ ok: true, ...st, models: MODEL_IDS }))
      }

      if (req.method === 'GET' && url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify({
          object: 'list',
          data: MODEL_IDS.map((m) => ({ id: m, object: 'model', created: 0, owned_by: 'muse' })),
        }))
      }

      // Session reading (Muse chats): list chats, or read one chat (optionally opening it first).
      if (req.method === 'GET' && url === '/v1/muse/chats') {
        const params = new URL(req.url, 'http://localhost').searchParams
        const data = await transport.listChats(params.get('query') || undefined, { account: params.get('account') || undefined })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      if (req.method === 'GET' && url === '/v1/muse/chat') {
        const params = new URL(req.url, 'http://localhost').searchParams
        const target = params.get('target')
        const acct = params.get('account') || undefined
        if (target) await transport.openChat(/^\d+$/.test(target) ? Number(target) : target, { account: acct })
        const data = await transport.readChat(Number(params.get('max')) || 100, { account: acct })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      if (req.method === 'GET' && url === '/v1/muse/media') {
        const params = new URL(req.url, 'http://localhost').searchParams
        const target = params.get('target')
        const download = params.get('download') === '1' || params.get('download') === 'true'
        const data = await transport.chatMedia(target || undefined, { download, dir: params.get('dir') || undefined, account: params.get('account') || undefined })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      if (req.method === 'GET' && url === '/v1/muse/usage') {
        const params = new URL(req.url, 'http://localhost').searchParams
        const data = await transport.usage({ account: params.get('account') || undefined })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      // Session lifecycle for orchestrators (`mc login|new|last`): same local-only
      // /v1/muse/* guard as the reads above. Login is a POST because it may drive
      // a sign-in; credentials come from the request body or the server's .env.
      if (req.method === 'POST' && url === '/v1/muse/login') {
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { return sendError(res, 400, 'Invalid JSON body') }
        const data = await transport.login({
          timeoutMs: (Number(body.timeout_sec) || 300) * 1000,
          email: body.email || undefined, metaPassword: body.meta_password || undefined,
          mailPassword: body.mail_password || undefined, apiKey: body.mail_api_key || undefined,
          auto: body.auto, account: body.account || undefined,
        })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      if (req.method === 'POST' && url === '/v1/muse/new') {
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { return sendError(res, 400, 'Invalid JSON body') }
        const data = await transport.newChat({ account: body.account || undefined })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      if (req.method === 'GET' && url === '/v1/muse/last') {
        const params = new URL(req.url, 'http://localhost').searchParams
        const data = await transport.readLast({ account: params.get('account') || undefined })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      // Pause / resume an account: no new auto-routed turns while paused; running turns finish. Body {account, paused}.
      if (req.method === 'POST' && url === '/v1/muse/pause') {
        if (typeof transport.setPaused !== 'function') return sendError(res, 400, 'pausing accounts needs the noise transport')
        let body
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { return sendError(res, 400, 'Invalid JSON body') }
        if (!body.account) return sendError(res, 400, 'account is required', 'invalid_request_error', null, 'account')
        let data
        try { data = transport.setPaused(String(body.account), body.paused !== false) } catch (e) { return sendError(res, 404, e.message, 'invalid_request_error', null, 'account') }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      // API keys for other machines: list (no secrets), make (secret returned once), change {name, enabled, maxInflight},
      // delete. Body of make: {name, maxInflight?, createdBy?}.
      if (url === '/v1/muse/keys' || url.startsWith('/v1/muse/keys/')) {
        const id = decodeURIComponent(url.slice('/v1/muse/keys/'.length))
        let body = {}
        if (req.method === 'POST') {
          try { body = JSON.parse((await readBody(req)) || '{}') } catch { return sendError(res, 400, 'Invalid JSON body') }
        }
        let data
        try {
          if (req.method === 'GET' && url === '/v1/muse/keys') data = { keys: keys.list(), host: HOST, port: PORT, authLocal: AUTH_LOCAL }
          else if (req.method === 'POST' && url === '/v1/muse/keys') data = keys.create(body)
          else if (req.method === 'POST' && id) data = keys.update(id, body)
          else if (req.method === 'DELETE' && id) data = keys.remove(id)
          else return sendError(res, 404, `Unknown route: ${req.method} ${url}`, 'invalid_request_error')
        } catch (e) { return sendError(res, 404, e.message, 'invalid_request_error', null, 'id') }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      if (req.method === 'POST' && url === '/v1/chat/completions') {
        if (key) {
          const end = keys.begin(key, req.socket.remoteAddress)
          if (!end) return sendError(res, 429, `key "${key.name}" already has ${key.maxInflight} turns running (its limit)`, 'rate_limit_error', 'key_inflight_limit')
          res.on('close', () => end(res.statusCode))
        }
        const raw = await readBody(req)
        let body
        try { body = JSON.parse(raw || '{}') } catch { return sendError(res, 400, 'Invalid JSON body') }
        // awaited: a body that breaks the prompt build (`messages: [null]`) must end in the 500 below, not in an unhandled
        // rejection that takes the whole shim — and every turn in flight — down
        return await handleChat(req, res, body)
      }

      sendError(res, 404, `Unknown route: ${req.method} ${url}`, 'invalid_request_error')
    } catch (err) {
      log('unhandled:', err && err.message)
      sendError(res, 500, String(err && err.message || err), 'internal_error')
    }
  })

  server.on('error', (err) => {
    // Without this, EADDRINUSE (or any listen failure) emits an unhandled
    // 'error' event and crashes the whole process.
    log(`listen error on ${host}:${port}: ${err && err.message}`)
    if (exitOnError) { console.error(`[muse-shim] cannot start on ${host}:${port}: ${err && err.message}`); process.exit(1) }
  })
  server.listen(port, host, () => {
    log(`OpenAI shim listening on http://${host}:${port}/v1  (models: ${MODEL_IDS.join(', ')})  [keys: ${keys.list().length}${AUTH_LOCAL ? ', local too' : ', this machine needs none'}]`)
  })
  return server
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain || process.argv.includes('--standalone')) {
  startShim({ exitOnError: true })
}
