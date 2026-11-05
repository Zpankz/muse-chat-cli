//! `mc` — Muse Chat CLI built on the incurs Rust framework.
//!
//! One typed command graph over the local Muse shim (see [`shim`]) is
//! exposed, from a single definition, as:
//!
//! - a terminal CLI        `mc ask "..."`, `mc chats list`, `mc usage`
//! - an MCP server         `mc --mcp` (stdio) / `/mcp` on the HTTP surface
//! - HTTP + OpenAPI        `mc http --addr 127.0.0.1:8788`
//! - agent discovery       `mc --llms`, `mc --llms-full`, `mc <cmd> --schema`
//! - shell completions     `mc completions bash|zsh|fish`
//! - Agent Skills/plugins  `mc skills add`, `mc plugin build`
//!
//! The Node server (`muse-server.mjs`) still owns the Muse transports
//! (browser + Noise), accounts and quota; `mc` is the state-of-the-art
//! front-end the old hand-rolled `muse-cli.mjs` flag parser used to be.

pub mod config;
pub mod shim;

use std::pin::Pin;

use incurs::cli::{Cli, ConfigOptions};
use incurs::command::{
    CommandContext, CommandDef, CommandHandler, Example, TypedContext, TypedResult,
};
use incurs::output::{CommandResult, Format, StreamRecord};
use serde::Deserialize;
use serde_json::{json, Value};

use config::Settings;
use shim::{ChatRequest, ShimClient, ShimError};

// ---------------------------------------------------------------- settings

fn settings_from(globals: &Value) -> Settings {
    let mut s = Settings::default();
    if let Some(b) = globals.get("base").and_then(Value::as_str) {
        if !b.is_empty() {
            s.base = config::normalize_base(b);
        }
    }
    s
}

async fn connect(globals: &Value) -> Result<ShimClient, ShimError> {
    let settings = settings_from(globals);
    config::ensure_shim(&settings).await?;
    ShimClient::new(&settings.base)
}

fn terr<T>(e: ShimError) -> TypedResult<T> {
    TypedResult::Error {
        code: e.code.to_string(),
        message: e.message,
        retryable: e.retryable,
        exit_code: Some(1),
        cta: None,
    }
}

// ---------------------------------------------------------------- globals

#[derive(Deserialize, incurs::Options)]
struct Globals {
    /// Shim base URL (default: env MUSE_SHIM_URL or http://127.0.0.1:8787).
    #[incurs(alias = "b")]
    base: Option<String>,
}

// ---------------------------------------------------------------- ask

/// Hand-written schema for the free-text args (`prompt`, `target`).
///
/// These are `FieldType::Value` — deliberately, because incurs 0.14
/// validates each surface differently and no single derived type fits
/// all three: the CLI parser fills the field from argv, HTTP Split hands
/// the handler the bare path segment (a string), and MCP Flat hands
/// whatever the caller sent. `Value` is the only field type
/// `field_errors` accepts for all of those, so the handler (the one place
/// that knows the join rule) normalizes string | array itself. The
/// published MCP schema says exactly what is accepted (`free_text_schema`).
macro_rules! free_text_args {
    ($ty:ident, $name:expr, $desc:expr) => {
        #[derive(Deserialize)]
        struct $ty {
            #[allow(dead_code)]
            value: Option<Value>,
        }
        impl incurs::schema::IncurSchema for $ty {
            fn fields() -> Vec<incurs::schema::FieldMeta> {
                vec![incurs::schema::FieldMeta {
                    name: $name,
                    cli_name: $name.to_string(),
                    description: Some($desc),
                    field_type: incurs::schema::FieldType::Value,
                    required: false,
                    default: None,
                    alias: None,
                    deprecated: false,
                    env_name: None,
                }]
            }
            fn from_raw(
                _raw: &std::collections::BTreeMap<String, Value>,
            ) -> Result<Self, incurs::errors::ValidationError> {
                Ok(Self { value: None })
            }
        }
    };
}
free_text_args!(AskArgs, "prompt", "The prompt. CLI: all words joined; HTTP /ask/<text>; MCP: string or array of words. Empty = read stdin (terminal only).");
free_text_args!(
    TargetArgs,
    "target",
    "Chat title, index or URL (words joined). Empty = current chat."
);

/// The JSON Schema published for a free-text arg: a string, or an array
/// of words that are joined with spaces. Kept next to `FreeText` so the
/// advertised contract and the handler's normalization cannot drift.
fn free_text_schema() -> Value {
    json!({ "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }] })
}

/// Normalize a free-text arg value from any surface to one string.
fn free_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn absolutize_files(files: Vec<String>, cwd: &std::path::Path) -> Vec<String> {
    files
        .into_iter()
        .map(|f| {
            // Only local paths are rewritten; URLs/data URIs pass through.
            if f.contains("://") || f.starts_with("data:") {
                return f;
            }
            let p = std::path::Path::new(&f);
            if p.is_absolute() {
                f
            } else {
                cwd.join(p).to_string_lossy().into_owned()
            }
        })
        .collect()
}

#[derive(Deserialize, incurs::Options)]
struct AskOptions {
    /// System prompt.
    #[incurs(alias = "s")]
    system: Option<String>,
    /// Model id (default muse-spark-1.3).
    #[incurs(alias = "m")]
    model: Option<String>,
    /// Per-turn timeout in milliseconds.
    #[incurs(alias = "t")]
    timeout_ms: Option<u64>,
    /// Attach a file/image/video (repeatable).
    #[incurs(alias = "f")]
    file: Vec<String>,
    /// Target chat by title, index or URL.
    chat: Option<String>,
    /// Pin a pooled account (noise transport).
    account: Option<String>,
    /// Start a fresh side thread for this turn.
    new_thread: bool,
    /// Wait for the full reply instead of streaming deltas.
    no_stream: bool,
    /// Force schema-valid JSON: inline JSON Schema or a path to one.
    /// (Named --json-schema, not --schema: the latter is incurs' built-in
    /// "show this command's schema" flag on every surface.)
    json_schema: Option<String>,
}

fn load_schema(raw: &str) -> Result<Value, String> {
    let t = raw.trim();
    if t.starts_with('{') {
        return serde_json::from_str(t).map_err(|e| format!("--schema: invalid inline JSON: {e}"));
    }
    let text =
        std::fs::read_to_string(raw).map_err(|e| format!("--schema: cannot read {raw}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("--schema: invalid JSON in {raw}: {e}"))
}

fn ask_request(ctx: &CommandContext, prompt: String) -> Result<ChatRequest, String> {
    let o = &ctx.options;
    let settings = settings_from(&ctx.globals);
    let schema = match o.get("json_schema").and_then(Value::as_str) {
        Some(raw) => Some(load_schema(raw)?),
        None => None,
    };
    Ok(ChatRequest {
        prompt,
        system: o.get("system").and_then(Value::as_str).map(str::to_string),
        model: o
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(settings.model),
        timeout_ms: o
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(settings.timeout_ms),
        new_thread: o
            .get("new_thread")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        // The shim resolves relative paths in ITS cwd, not the
        // caller's — absolutize against the caller's cwd first.
        files: absolutize_files(
            o.get("file")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            &std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
        ),
        chat: o.get("chat").and_then(Value::as_str).map(str::to_string),
        account: o.get("account").and_then(Value::as_str).map(str::to_string),
        json_schema: schema,
    })
}

/// Resolve the prompt for `ask`: positional text, `-` (explicit stdin),
/// or piped stdin. The stdin rule is deliberately NOT `ctx.agent`:
/// incurs sets `agent = !human` (stdout not a TTY), which is exactly
/// when a pipe is attached — `cat f | mc ask` must work. Only CLI
/// invocations (no transport `request` metadata; MCP/HTTP always set
/// it) with a non-TTY stdin may read it. Pure + injectable for tests.
fn resolve_prompt(positional: String, stdin: Option<String>) -> Result<String, CommandResult> {
    let prompt = if positional.trim() == "-" {
        stdin.unwrap_or_default()
    } else if positional.trim().is_empty() {
        stdin.unwrap_or_default()
    } else {
        positional
    };
    if prompt.trim().is_empty() {
        return Err(CommandResult::Error {
            code: "missing_prompt".into(),
            message: "ask needs a prompt argument or stdin input (e.g. `mc ask \"hi\"` or `echo hi | mc ask`)".into(),
            retryable: false,
            exit_code: Some(2),
            cta: None,
        });
    }
    Ok(prompt.trim().to_string())
}

/// A RecordStream that aborts its pump task when dropped: dropping
/// the stream (consumer gone) aborts chat_stream, whose HTTP request
/// drop makes the shim cancel the Muse turn instead of burning
/// quota for nobody.
struct AbortOnDrop {
    inner: futures::channel::mpsc::UnboundedReceiver<StreamRecord>,
    pump: Option<tokio::task::JoinHandle<()>>,
}
impl futures::Stream for AbortOnDrop {
    type Item = StreamRecord;
    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        Pin::new(&mut self.inner).poll_next(cx)
    }
}
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(p) = self.pump.take() {
            p.abort();
        }
    }
}

/// Streaming `ask`: a manual handler (not `CommandDef::typed`) because the
/// reply is a `RecordStream` — text deltas as they arrive, then exactly one
/// terminal `Ok`/`Error` record. Non-stream and schema turns collapse to
/// a single chunk so `--format json` still yields the reply text / object.
///
/// Orchestration contract: with `--format json` the (single) output value
/// is an envelope `{content, session_id, account, model}` so an agent
/// can continue a thread by id; human formats keep the bare text.
struct AskHandler;

#[async_trait::async_trait]
impl CommandHandler for AskHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        // `prompt` is FieldType::Value (see FreeText): CLI argv, the HTTP
        // path segment and an MCP argument all land here in different
        // shapes; normalize once, here.
        // HTTP Split mode takes args only from URL path segments; a
        // POSTed JSON body lands in options. Accept `prompt` there as a
        // fallback so `POST /ask {"prompt": "…"}` works like the CLI.
        let mut positional = free_text(ctx.args.get("prompt"));
        if positional.trim().is_empty() {
            positional = free_text(ctx.options.get("prompt"));
        }
        let stdin = if ctx.request.is_none()
            && !std::io::IsTerminal::is_terminal(&std::io::stdin())
            && (positional.trim().is_empty() || positional.trim() == "-")
        {
            use tokio::io::AsyncReadExt;
            let mut buf = String::new();
            match tokio::io::stdin().read_to_string(&mut buf).await {
                Ok(_) => Some(buf),
                Err(_) => None,
            }
        } else {
            None
        };
        let prompt = match resolve_prompt(positional, stdin) {
            Ok(p) => p,
            Err(r) => return r,
        };
        let req = match ask_request(&ctx, prompt.trim().to_string()) {
            Ok(r) => r,
            Err(m) => {
                return CommandResult::Error {
                    code: "bad_schema".into(),
                    message: m,
                    retryable: false,
                    exit_code: Some(2),
                    cta: None,
                }
            }
        };
        let client = match connect(&ctx.globals).await {
            Ok(c) => c,
            Err(e) => {
                return CommandResult::Error {
                    code: e.code.into(),
                    message: e.message,
                    retryable: e.retryable,
                    exit_code: Some(1),
                    cta: None,
                }
            }
        };
        let streaming = !ctx
            .options
            .get("no_stream")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && req.json_schema.is_none();
        if !streaming {
            return match client.chat(&req).await {
                Ok(reply) => {
                    // Agent/JSON callers get the orchestration envelope
                    // (continue-by-id); human formats keep bare text. The
                    // shim populates session_id for new-thread turns.
                    let data = if req.json_schema.is_some() {
                        serde_json::from_str(&reply.content)
                            .unwrap_or(Value::String(reply.content.clone()))
                    } else if ctx.format == Format::Json || ctx.agent {
                        json!({
                            "content": reply.content,
                            "session_id": reply.session_id,
                            "account": reply.account,
                            "model": req.model,
                        })
                    } else {
                        Value::String(reply.content)
                    };
                    CommandResult::Ok {
                        data,
                        cta: None,
                        exit_code: None,
                    }
                }
                Err(e) => CommandResult::Error {
                    code: e.code.into(),
                    message: e.message,
                    retryable: e.retryable,
                    exit_code: Some(1),
                    cta: None,
                },
            };
        }
        let (tx, rx) = futures::channel::mpsc::unbounded::<StreamRecord>();
        // Consumer-lifetime: the pump runs chat_stream to completion;
        // if the RecordStream is dropped, every unbounded_send fails,
        // and incurs stops polling — but this task must not outlive
        // its receiver. Guarded below by checking send results and
        // ending the task (dropping the HTTP request cancels the turn
        // server-side) as soon as the channel closes.
        let pump = tokio::spawn(async move {
            let tx2 = tx.clone();
            // The receiver is owned by the returned stream; a send
            // failure means the consumer has gone. Tag the result so a
            // wrapper can stop early if chat_stream ever gains deltas
            // after closure — today the request is dropped when this
            // task's future is dropped by the select in the caller.
            let result = client
                .chat_stream(&req, move |delta| {
                    let _ = tx2.unbounded_send(StreamRecord::Chunk(Value::String(delta)));
                })
                .await;
            // On a new-thread turn, surface the created thread id as a
            // final chunk so streamed callers can continue by id (in
            // --format jsonl it arrives as a typed chunk).
            if req.new_thread {
                if let Ok(reply) = &result {
                    if let Some(sid) = &reply.session_id {
                        let _ = tx.unbounded_send(StreamRecord::Chunk(json!({
                            "session_id": sid,
                            "account": reply.account,
                        })));
                    }
                }
            }
            let terminal = match result {
                Ok(_) => StreamRecord::Ok { cta: None },
                Err(e) => StreamRecord::Error {
                    code: e.code.into(),
                    message: e.message,
                    retryable: e.retryable,
                    exit_code: Some(1),
                    cta: None,
                },
            };
            let _ = tx.unbounded_send(terminal);
        });
        // (stream wiring is below, after the pump's terminal send)
        let stream: Pin<Box<dyn futures::Stream<Item = StreamRecord> + Send>> =
            Box::pin(AbortOnDrop {
                inner: rx,
                pump: Some(pump),
            });
        CommandResult::RecordStream(stream)
    }
}

fn ask_command(root: bool) -> incurs::command::CommandDef {
    // `CommandDef::build` (manual handler, needed for RecordStream) leaves
    // `output_schema: None`; publish the streamed-reply contract explicitly
    // so MCP / `--llms-full` consumers see it like every typed command.
    // The MCP inputSchema likewise needs the free-text union, which the
    // FieldType::Value arg cannot express on its own.
    // Examples are rendered as `<display-name> <example>`, so they are
    // written relative to the command: bare under `mc ask`, `ask …`
    // under the root (whose display name is `mc`). The root variant
    // also carries the command index, since root help is mc's front
    // door and incurs shows no sibling list there.
    let (description, examples) = if root {
        (
            "Ask Muse a question (streams the reply)\nCommands: ask, batch, doctor, chats list|read|media, status, login, new, last, models, usage, pause, resume, pause-all, resume-all, keys list|create|update|remove, http — full manifest: `mc --llms`",
            vec![
                Example { command: "ask \"Explain a B-tree in two sentences\"".into(), description: Some("Stream a reply".into()) },
                Example { command: "ask --new-thread -f ./frame.png \"Caption this\"".into(), description: Some("Fresh thread with an attachment".into()) },
                Example { command: "ask --json-schema ./schema.json \"Extract name and age\" ".into(), description: Some("Schema-valid JSON out".into()) },
            ],
        )
    } else {
        (
            "Ask Muse a question (streams the reply)",
            vec![
                Example {
                    command: "\"Explain a B-tree in two sentences\"".into(),
                    description: Some("Stream a reply".into()),
                },
                Example {
                    command: "--new-thread -f ./frame.png \"Caption this\"".into(),
                    description: Some("Fresh thread with an attachment".into()),
                },
                Example {
                    command: "--json-schema ./schema.json \"Extract name and age\"".into(),
                    description: Some("Schema-valid JSON out".into()),
                },
            ],
        )
    };
    let mut cmd = CommandDef::build("ask", AskHandler)
        .description(description)
        .args::<AskArgs>()
        .options::<AskOptions>()
        .mcp_input_schema(json!({
            "type": "object",
            "properties": {
                "prompt": free_text_schema(),
                "system": { "type": "string" },
                "model": { "type": "string" },
                "timeout_ms": { "type": "number" },
                "file": { "type": "array", "items": { "type": "string" } },
                "chat": { "type": "string" },
                "account": { "type": "string" },
                "new_thread": { "type": "boolean" },
                "no_stream": { "type": "boolean" },
                "json_schema": { "type": "string" }
            }
        }))
        .examples(examples)
        .done();
    cmd.output_schema = Some(json!({
        "type": "string",
        "description": "The assistant reply text, streamed as deltas. With --schema, the schema-valid JSON value instead."
    }));
    cmd
}

// ---------------------------------------------------------------- typed helpers

#[derive(Deserialize, incurs::Options)]
struct AccountOptions {
    /// Pin a pooled account (noise transport).
    account: Option<String>,
}

#[derive(Deserialize, incurs::Options)]
struct ChatsListOptions {
    /// Case-insensitive title/snippet filter.
    query: Option<String>,
    /// Pin a pooled account.
    account: Option<String>,
}

#[derive(Deserialize, incurs::Options)]
struct ReadOptions {
    /// Max messages from the end.
    #[incurs(default = 100)]
    max: u32,
    /// Pin a pooled account.
    account: Option<String>,
}

#[derive(Deserialize, incurs::Options)]
struct MediaOptions {
    /// Download the media to disk.
    download: bool,
    /// Directory for downloads.
    dir: Option<String>,
    /// Pin a pooled account.
    account: Option<String>,
}

#[derive(Deserialize, incurs::Args)]
struct AccountArgs {
    /// Account id (see `mc status`).
    account: String,
}

#[derive(Deserialize, incurs::Options)]
struct HttpOptions {
    /// Address for the incurs HTTP+MCP surface.
    #[incurs(default = "127.0.0.1:8788")]
    addr: String,
    /// Bearer token required on every route (or env MC_HTTP_TOKEN).
    /// Mandatory when binding a non-loopback address.
    token: Option<String>,
}

#[derive(Deserialize, incurs::Options)]
struct LoginOptions {
    /// How long to wait for sign-in, in seconds.
    #[incurs(default = 300)]
    timeout_sec: u64,
    /// Pin a pooled account (noise transport).
    account: Option<String>,
    /// Force interactive sign-in even when credentials are present.
    manual: bool,
}

#[derive(Deserialize, incurs::Args)]
struct KeyIdArgs {
    /// Key id (see `mc keys list`).
    id: String,
}

#[derive(Deserialize, incurs::Options)]
struct KeysCreateOptions {
    /// Display name for the new key.
    #[incurs(default = "mc")]
    name: String,
    /// Max simultaneous turns for this key (unset = unlimited).
    max_inflight: Option<u64>,
}

#[derive(Deserialize, incurs::Options)]
struct BatchOptions {
    /// One prompt per line from this file (`-` = stdin). Blank lines and
    /// `#` comments are skipped.
    #[incurs(alias = "f")]
    file: Option<String>,
    /// Max turns in flight (clamped 1..=32).
    #[incurs(default = 4)]
    concurrency: u32,
    /// System prompt applied to every item.
    #[incurs(alias = "s")]
    system: Option<String>,
    /// Model id (default muse-spark-1.3).
    #[incurs(alias = "m")]
    model: Option<String>,
    /// Per-turn timeout in milliseconds.
    #[incurs(alias = "t")]
    timeout_ms: Option<u64>,
    /// Pin every item to this pooled account (noise transport).
    account: Option<String>,
}

#[derive(Deserialize, incurs::Options)]
struct KeysUpdateOptions {
    /// New display name.
    name: Option<String>,
    /// Enable the key.
    enable: bool,
    /// Disable the key.
    disable: bool,
    /// Max simultaneous turns (0 = unlimited).
    max_inflight: Option<u64>,
}

/// CLI argv normalization — the one place multi-word free text is joined.
///
/// incurs (by design) rejects positional tokens no arg claims, so a
/// `String` prompt only ever takes one shell word. Humans type
/// `mc Say exactly ok` anyway. Before `serve()`, this rewrites argv so:
///
/// - `mc hello world`            -> `mc ask "hello world"`
/// - `mc ask Say exactly ok`     -> `mc ask "Say exactly ok"`
/// - `mc chats read My Thread`   -> `mc chats read "My Thread"`
/// - flags keep their values (`-s X`, `--schema F`, `--format json`, …)
/// - quoted / single-word / machine invocations pass through untouched
///
/// MCP, HTTP and `tool_catalog()` never see this: they call commands by
/// name with structured arguments, where `prompt` is already one string.
/// mc's boolean flags (incurs derives `bool` as a value-taking option).
/// A bare following `true`/`false` is that flag's value, never prompt
/// text; `normalize_argv` rewrites a flag with no value to `--flag true`.
/// Insert an explicit `true` after any bool flag that lacks a value.
/// A following bare `true`/`false` is kept as the value.
fn expand_bool_flags(argv: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(argv.len() + 4);
    let mut k = 0;
    while k < argv.len() {
        let t = argv[k].clone();
        if t == "--" {
            out.extend_from_slice(&argv[k..]);
            break;
        }
        out.push(t.clone());
        if is_bool_flag(&t) {
            match argv.get(k + 1).map(String::as_str) {
                Some("true") | Some("false") => {}
                _ => out.push("true".to_string()),
            }
        }
        k += 1;
    }
    out
}

fn is_bool_flag(token: &str) -> bool {
    matches!(
        token,
        "--new-thread" | "--no-stream" | "--download" | "--manual" | "--enable" | "--disable"
    )
}

pub fn normalize_argv(argv: Vec<String>) -> Vec<String> {
    const COMMANDS: &[&str] = &[
        "ask",
        "batch",
        "doctor",
        "chats",
        "keys",
        "status",
        "login",
        "new",
        "last",
        "models",
        "usage",
        "pause",
        "resume",
        "pause-all",
        "resume-all",
        "http",
        "completions",
        "mcp",
        "skills",
        "plugin",
        "help",
    ];
    const VALUE_FLAGS: &[&str] = &[
        "-s",
        "--system",
        "-m",
        "--model",
        "-t",
        "--timeout-ms",
        "-f",
        "--file",
        "--chat",
        "--account",
        "--schema",
        "--json-schema",
        "-b",
        "--base",
        "--format",
        "--config",
        "--dir",
        "--max",
        "--addr",
        "--token-limit",
        "--token-offset",
        "--filter-output",
    ];
    // Skip leading machine/global flags to find the command position.
    let mut i = 0;
    while i < argv.len() {
        let t = &argv[i];
        if t == "--" {
            break;
        }
        if VALUE_FLAGS.contains(&t.as_str()) {
            i += 2;
            continue;
        }
        if t.starts_with('-') {
            i += 1;
            continue;
        }
        break;
    }
    // Boolean-flag expansion must run BEFORE the command position is
    // computed: inserting `true` shifts every later index, and a stale
    // cmd_at would merge the command name into the prompt.
    let argv = expand_bool_flags(argv);
    let mut out = argv.clone();
    // Recompute the command position on the expanded argv.
    let mut i = 0;
    while i < argv.len() {
        let t = &argv[i];
        if t == "--" {
            break;
        }
        if VALUE_FLAGS.contains(&t.as_str()) || is_bool_flag(t) {
            i += 2;
            continue;
        }
        if t.starts_with('-') {
            i += 1;
            continue;
        }
        break;
    }
    // Bare prompt: first real token is no command — route the line to ask.
    if i >= argv.len() || !COMMANDS.contains(&argv[i].as_str()) {
        out.insert(i, "ask".to_string());
    }
    // Join positionals of ask / chats read / chats media into one token.
    let cmd_at = i;
    let join_from = if out[cmd_at] == "ask" {
        Some(cmd_at + 1)
    } else if out[cmd_at] == "chats"
        && matches!(
            out.get(cmd_at + 1).map(String::as_str),
            Some("read") | Some("media")
        )
    {
        Some(cmd_at + 2)
    } else {
        None
    };
    if let Some(start) = join_from {
        let mut pos: Vec<usize> = Vec::new();
        let mut j = start;
        let mut after_dd = false;
        while j < out.len() {
            let t = out[j].clone();
            if !after_dd && t == "--" {
                after_dd = true;
                j += 1;
                continue;
            }
            if !after_dd && t.starts_with('-') && t.len() > 1 {
                // Bool flags now always carry a value token (inserted
                // above), as does a VALUE_FLAG; both step over 2.
                j += if VALUE_FLAGS.contains(&t.as_str()) || is_bool_flag(&t) {
                    2
                } else {
                    1
                };
                continue;
            }
            // A `true`/`false` immediately after a bool flag is its
            // value, already stepped over — positional collection only
            // sees it if it starts the scan, which cannot happen since
            // flags are stepped in pairs. Keep as positional otherwise.
            pos.push(j);
            j += 1;
        }
        if pos.len() > 1 {
            let joined = pos
                .iter()
                .map(|&k| out[k].clone())
                .collect::<Vec<_>>()
                .join(" ");
            out[pos[0]] = joined;
            for &k in pos[1..].iter().rev() {
                out.remove(k);
            }
        }
    }
    out
}

fn target_value(value: Option<&Value>) -> Option<String> {
    let t = free_text(value);
    let t = t.trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

fn opt_str(ctx: &CommandContext, key: &str) -> Option<String> {
    ctx.options
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}
fn opt_u32(ctx: &CommandContext, key: &str, fallback: u32) -> u32 {
    ctx.options
        .get(key)
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(fallback)
}
/// Account ids of the pool, from the health body's `accounts`.
fn pool_ids(health: &Value) -> Vec<String> {
    health
        .get("accounts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

async fn set_all_paused(client: &ShimClient, paused: bool) -> Result<Value, ShimError> {
    let health = client.health().await?;
    let ids = pool_ids(&health);
    if ids.is_empty() {
        // Browser transport has no pool to pause; say so, don't fake it.
        return Ok(json!({
            "paused": paused, "accounts": [],
            "note": "no account pool (browser transport); pause applies to the noise pool only"
        }));
    }
    let mut out = Vec::new();
    for id in &ids {
        out.push(client.pause(id, paused).await?);
    }
    Ok(json!({ "paused": paused, "accounts": out }))
}

fn opt_bool(ctx: &CommandContext, key: &str) -> bool {
    ctx.options
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// One batch input line -> a prompt, or None for blank/comment lines.
fn batch_line(line: &str) -> Option<String> {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        None
    } else {
        Some(t.to_string())
    }
}

fn batch_requests(prompts: &[String], o: &Value, settings: &Settings) -> Vec<ChatRequest> {
    prompts
        .iter()
        .map(|prompt| ChatRequest {
            prompt: prompt.clone(),
            system: o.get("system").and_then(Value::as_str).map(str::to_string),
            model: o
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| settings.model.clone()),
            timeout_ms: o
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(settings.timeout_ms),
            // Every batch item gets its own thread: shared-session
            // turns serialize and cross-contaminate (AGENTS.md).
            new_thread: true,
            files: Vec::new(),
            chat: None,
            account: o.get("account").and_then(Value::as_str).map(str::to_string),
            json_schema: None,
        })
        .collect()
}

/// `mc ask --batch`: fan out one prompt per line, stream one record per
/// item as it completes, end with a summary. Record shape (all formats):
/// `{i, prompt, content|error, session_id, account}`.
struct BatchHandler;

#[async_trait::async_trait]
impl CommandHandler for BatchHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let src = ctx
            .options
            .get("file")
            .and_then(Value::as_str)
            .unwrap_or("-");
        // stdin is only ever read for a real terminal invocation: on
        // MCP/HTTP surfaces stdin is the protocol stream / server pipe.
        if src == "-" && ctx.request.is_some() {
            return CommandResult::Error {
                code: "bad_input".into(),
                message: "batch over MCP/HTTP needs --file <path> (stdin is the terminal's)".into(),
                retryable: false,
                exit_code: Some(2),
                cta: None,
            };
        }
        let text = if src == "-" {
            use tokio::io::AsyncReadExt;
            let mut buf = String::new();
            match tokio::io::stdin().read_to_string(&mut buf).await {
                Ok(_) => buf,
                Err(e) => {
                    return CommandResult::Error {
                        code: "bad_input".into(),
                        message: format!("cannot read stdin: {e}"),
                        retryable: false,
                        exit_code: Some(2),
                        cta: None,
                    }
                }
            }
        } else {
            match std::fs::read_to_string(src) {
                Ok(t) => t,
                Err(e) => {
                    return CommandResult::Error {
                        code: "bad_input".into(),
                        message: format!("cannot read --file {src}: {e}"),
                        retryable: false,
                        exit_code: Some(2),
                        cta: None,
                    }
                }
            }
        };
        let prompts: Vec<String> = text.lines().filter_map(batch_line).collect();
        if prompts.is_empty() {
            return CommandResult::Error {
                code: "missing_prompt".into(),
                message: "batch input has no prompts (one per line, `#` = comment)".into(),
                retryable: false,
                exit_code: Some(2),
                cta: None,
            };
        }
        let client = match connect(&ctx.globals).await {
            Ok(c) => c,
            Err(e) => {
                return CommandResult::Error {
                    code: e.code.into(),
                    message: e.message,
                    retryable: e.retryable,
                    exit_code: Some(1),
                    cta: None,
                }
            }
        };
        let settings = settings_from(&ctx.globals);
        let concurrency = ctx
            .options
            .get("concurrency")
            .and_then(Value::as_u64)
            .unwrap_or(4)
            .clamp(1, 32) as usize;
        let items = batch_requests(&prompts, &ctx.options, &settings);
        let total = items.len();
        let (tx, rx) = futures::channel::mpsc::unbounded::<StreamRecord>();
        let pump = tokio::spawn(async move {
            // Stream each record as its item completes (carrying its
            // input index for reassembly), then the summary + terminal.
            let tx2 = tx.clone();
            let failed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let failed2 = failed.clone();
            client
                .chat_batch_streaming(items, concurrency, move |item| {
                    let rec = match &item.reply {
                        Ok(r) => json!({
                            "i": item.index, "prompt": item.prompt, "content": r.content,
                            "session_id": r.session_id, "account": r.account,
                        }),
                        Err(e) => {
                            failed2.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            json!({
                                "i": item.index, "prompt": item.prompt,
                                "error": { "code": e.code, "message": e.message },
                            })
                        }
                    };
                    let _ = tx2.unbounded_send(StreamRecord::Chunk(rec));
                })
                .await;
            let failed = failed.load(std::sync::atomic::Ordering::Relaxed);
            let _ = tx.unbounded_send(StreamRecord::Chunk(json!({
                "done": true, "total": total, "failed": failed,
            })));
            let terminal = if failed > 0 {
                StreamRecord::Error {
                    code: "batch_failed".into(),
                    message: format!("{failed} of {total} batch item(s) failed"),
                    retryable: true,
                    exit_code: Some(1),
                    cta: None,
                }
            } else {
                StreamRecord::Ok { cta: None }
            };
            let _ = tx.unbounded_send(terminal);
        });
        // Same consumer-lifetime rule as ask: dropping the stream
        // aborts the batch pump (its in-flight HTTP requests drop,
        // and the shim cancels those turns server-side).
        let stream: Pin<Box<dyn futures::Stream<Item = StreamRecord> + Send>> =
            Box::pin(AbortOnDrop {
                inner: rx,
                pump: Some(pump),
            });
        CommandResult::RecordStream(stream)
    }
}

/// `mc doctor`: interpret status (+ best-effort usage) into verdicts an
/// orchestrator can branch on, instead of dumping raw health JSON.
fn doctor_report(health: &Value, usage: Option<&Value>) -> Value {
    let get = |k: &str| health.get(k).cloned().unwrap_or(Value::Null);
    let transport = get("transport");
    let is_noise = transport.as_str() == Some("noise");
    let accounts: Vec<Value> = get("accounts")
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|a| {
            let signed_out = !a.get("signedOut").map(|v| v.is_null()).unwrap_or(true);
            let vm_disabled = !a.get("vmDisabled").map(|v| v.is_null()).unwrap_or(true);
            let paused = a.get("paused").and_then(Value::as_bool).unwrap_or(false);
            let in_pool = a.get("inPool").and_then(Value::as_bool).unwrap_or(false);
            let quota = a.get("quota").cloned().unwrap_or(Value::Null);
            // Match the transport's own predicate (muse-transport
            // `_noteQuota`): DEPLETED status, or 100% weekly with no
            // purchased tokens left. 100% with topup remaining is
            // still serviceable, not out_of_quota.
            let topup = quota.get("topupBalance").and_then(Value::as_f64);
            // Match the transport predicate exactly (muse-transport
            // _noteQuota/_depleted): status covers DEPLETED|EXHAUSTED|
            // EXCEEDED; the percentUsed arm requires a KNOWN balance
            // (topup != null && topup <= 0) — absent balance is unknown,
            // not depleted.
            let status_out = quota
                .get("status")
                .and_then(Value::as_str)
                .map(|s| {
                    s.eq_ignore_ascii_case("DEPLETED")
                        || s.eq_ignore_ascii_case("EXHAUSTED")
                        || s.eq_ignore_ascii_case("EXCEEDED")
                })
                .unwrap_or(false);
            let depleted = status_out
                || (quota
                    .get("percentUsed")
                    .and_then(Value::as_f64)
                    .map(|p| p >= 100.0)
                    .unwrap_or(false)
                    && topup.map(|b| b <= 0.0).unwrap_or(false));
            let verdict = if signed_out {
                "signed_out"
            } else if vm_disabled {
                "vm_disabled"
            } else if paused {
                "paused"
            } else if depleted {
                "out_of_quota"
            } else if in_pool {
                "ready"
            } else {
                "not_ready"
            };
            json!({
                "id": a.get("id"), "verdict": verdict,
                "logged_in": a.get("loggedIn"), "connected": a.get("connected"),
                "in_pool": in_pool, "quota": quota,
            })
        })
        .collect();
    let (verdict, next): (&str, &str) = if is_noise {
        if accounts.iter().any(|a| a["verdict"] == "ready") {
            ("ready", "mc ask \"hi\"")
        } else if accounts.iter().any(|a| a["verdict"] == "signed_out") {
            ("signed_out", "mc login (or wait for auto re-login)")
        } else if accounts.iter().any(|a| a["verdict"] == "out_of_quota") {
            (
                "out_of_quota",
                "wait for the weekly reset, top up, or `mc usage`",
            )
        } else {
            ("not_ready", "mc status, then mc login")
        }
    } else if get("loggedIn").as_bool() == Some(true)
        && get("composerReady").as_bool() == Some(true)
    {
        ("ready", "mc ask \"hi\"")
    } else if get("browserRunning").as_bool() == Some(true) {
        (
            "not_ready",
            "finish the Meta sign-in in Chrome, then retry (see `mc status`)",
        )
    } else {
        ("not_ready", "mc login (opens Chrome; sign in once)")
    };
    json!({
        "ok": verdict == "ready",
        "verdict": verdict,
        "transport": transport,
        "base": get("base"),
        "accounts": accounts,
        "usage": usage,
        "next": next,
    })
}

/// `chats read` — manual handler for the same reason as `ask`: `target`
/// is a free-text (Value) arg, so no derived Args type fits all surfaces.
struct ReadChatHandler;
#[async_trait::async_trait]
impl CommandHandler for ReadChatHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let client = match connect(&ctx.globals).await {
            Ok(c) => c,
            Err(e) => {
                return CommandResult::Error {
                    code: e.code.into(),
                    message: e.message,
                    retryable: e.retryable,
                    exit_code: Some(1),
                    cta: None,
                }
            }
        };
        match client
            .read_chat(
                target_value(ctx.args.get("target").or_else(|| ctx.options.get("target")))
                    .as_deref(),
                opt_u32(&ctx, "max", 100),
                opt_str(&ctx, "account").as_deref(),
            )
            .await
        {
            Ok(v) => CommandResult::Ok {
                data: v,
                cta: None,
                exit_code: None,
            },
            Err(e) => CommandResult::Error {
                code: e.code.into(),
                message: e.message,
                retryable: e.retryable,
                exit_code: Some(1),
                cta: None,
            },
        }
    }
}

struct MediaHandler;
#[async_trait::async_trait]
impl CommandHandler for MediaHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let client = match connect(&ctx.globals).await {
            Ok(c) => c,
            Err(e) => {
                return CommandResult::Error {
                    code: e.code.into(),
                    message: e.message,
                    retryable: e.retryable,
                    exit_code: Some(1),
                    cta: None,
                }
            }
        };
        match client
            .media(
                target_value(ctx.args.get("target").or_else(|| ctx.options.get("target")))
                    .as_deref(),
                opt_bool(&ctx, "download"),
                opt_str(&ctx, "dir").as_deref(),
                opt_str(&ctx, "account").as_deref(),
            )
            .await
        {
            Ok(v) => CommandResult::Ok {
                data: v,
                cta: None,
                exit_code: None,
            },
            Err(e) => CommandResult::Error {
                code: e.code.into(),
                message: e.message,
                retryable: e.retryable,
                exit_code: Some(1),
                cta: None,
            },
        }
    }
}

// ---------------------------------------------------------------- cli graph

/// The full `mc` command graph. Every surface (CLI, MCP, HTTP, skills)
/// derives from this one definition.
pub fn build_cli() -> Cli {
    let status = CommandDef::typed::<(), (), (), Value, _, _>(
        "status",
        |ctx: TypedContext<(), (), ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c.health().await {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Shim, transport, login and account-pool state")
    .done();

    let models = CommandDef::typed::<(), (), (), Value, _, _>(
        "models",
        |ctx: TypedContext<(), (), ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c.models().await {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Model ids the shim serves")
    .done();

    let usage = CommandDef::typed::<(), AccountOptions, (), Value, _, _>(
        "usage",
        |ctx: TypedContext<(), AccountOptions, ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c.usage(ctx.options.account.as_deref()).await {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Plan, weekly usage and additional-token meter")
    .done();

    let pause = CommandDef::typed::<AccountArgs, (), (), Value, _, _>(
        "pause",
        |ctx: TypedContext<AccountArgs, (), ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c.pause(&ctx.args.account, true).await {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Pause auto-routed turns for one account (noise pool)")
    .done();

    let resume = CommandDef::typed::<AccountArgs, (), (), Value, _, _>(
        "resume",
        |ctx: TypedContext<AccountArgs, (), ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c.pause(&ctx.args.account, false).await {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Resume auto-routed turns for one account")
    .done();

    let batch = {
        let mut c = CommandDef::build("batch", BatchHandler)
            .description("Fan out one prompt per line (`--file`/`-` stdin), each in its own thread; one record per item")
            .options::<BatchOptions>()
            .mcp_input_schema(json!({
                "type": "object",
                "properties": {
                    "file": { "type": "string" },
                    "concurrency": { "type": "number" },
                    "system": { "type": "string" },
                    "model": { "type": "string" },
                    "timeout_ms": { "type": "number" },
                    "account": { "type": "string" }
                }
            }))
            .done();
        c.output_schema = Some(json!({
            "type": "array",
            "description": "One {i, prompt, content|error, session_id, account} per input line, plus a {done,total,failed} summary"
        }));
        c
    };

    let doctor = CommandDef::typed::<(), AccountOptions, (), Value, _, _>(
        "doctor",
        |ctx: TypedContext<(), AccountOptions, ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c.health().await {
                    Ok(h) => {
                        let usage = c.usage(ctx.options.account.as_deref()).await.ok();
                        // `base` is not part of the shim body; add ours.
                        let mut health = h;
                        if let Some(o) = health.as_object_mut() {
                            o.insert(
                                "base".into(),
                                Value::String(settings_from(&ctx.globals).base),
                            );
                        }
                        TypedResult::ok(doctor_report(&health, usage.as_ref()))
                    }
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description(
        "Verdicts for orchestration: ready / not_ready / signed_out / out_of_quota, per account",
    )
    .done();

    let pause_all = CommandDef::typed::<(), (), (), Value, _, _>(
        "pause-all",
        |ctx: TypedContext<(), (), ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match set_all_paused(&c, true).await {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Pause auto-routed turns for every pool account")
    .done();

    let resume_all = CommandDef::typed::<(), (), (), Value, _, _>(
        "resume-all",
        |ctx: TypedContext<(), (), ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match set_all_paused(&c, false).await {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Resume auto-routed turns for every pool account")
    .done();

    let chats_list = CommandDef::typed::<(), ChatsListOptions, (), Value, _, _>(
        "list",
        |ctx: TypedContext<(), ChatsListOptions, ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c
                    .chats(ctx.options.query.as_deref(), ctx.options.account.as_deref())
                    .await
                {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("List Muse chats (title, active, pinned, session id)")
    .done();

    // Manual handlers publish their output schema explicitly, like `ask`
    // (a `build` handler has no typed Output for incurs to derive it from).
    let mut chats_read = CommandDef::build("read", ReadChatHandler)
        .description("Read a chat's messages without sending anything")
        .args::<TargetArgs>()
        .options::<ReadOptions>()
        .mcp_input_schema(json!({
            "type": "object",
            "properties": {
                "target": free_text_schema(),
                "max": { "type": "number" },
                "account": { "type": "string" }
            }
        }))
        .done();
    chats_read.output_schema =
        Some(json!({ "type": "object", "description": "Chat messages, count and thread URL" }));

    let mut chats_media = CommandDef::build("media", MediaHandler)
        .description("Generated-media links in a chat, optionally downloaded")
        .args::<TargetArgs>()
        .options::<MediaOptions>()
        .mcp_input_schema(json!({
            "type": "object",
            "properties": {
                "target": free_text_schema(),
                "download": { "type": "boolean" },
                "dir": { "type": "string" },
                "account": { "type": "string" }
            }
        }))
        .done();
    chats_media.output_schema = Some(
        json!({ "type": "object", "description": "Media items, urls and optional downloads" }),
    );

    let chats = Cli::create("chats")
        .description("Inspect Muse chats")
        .command("list", chats_list)
        .command("read", chats_read)
        .command("media", chats_media);

    // ---- session lifecycle (orchestration verbs) ----
    let login = CommandDef::typed::<(), LoginOptions, (), Value, _, _>(
        "login",
        |ctx: TypedContext<(), LoginOptions, ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c
                    .login(
                        Some(ctx.options.timeout_sec),
                        ctx.options.account.as_deref(),
                        if ctx.options.manual {
                            Some(false)
                        } else {
                            None
                        },
                    )
                    .await
                {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Sign in to Muse (unattended via server .env/OTP, else manual in Chrome)")
    .done();

    let new = CommandDef::typed::<(), AccountOptions, (), Value, _, _>(
        "new",
        |ctx: TypedContext<(), AccountOptions, ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c.new_chat(ctx.options.account.as_deref()).await {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Start a fresh Muse thread")
    .done();

    let last = CommandDef::typed::<(), AccountOptions, (), Value, _, _>(
        "last",
        |ctx: TypedContext<(), AccountOptions, ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c.last(ctx.options.account.as_deref()).await {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Latest assistant reply, without sending anything")
    .done();

    // ---- shim API keys (local-only server routes; secret shown once) ----
    let keys_list = CommandDef::typed::<(), (), (), Value, _, _>(
        "list",
        |ctx: TypedContext<(), (), ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c.keys_list().await {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("List shim API keys (metadata only, never secrets)")
    .done();

    let keys_create = CommandDef::typed::<(), KeysCreateOptions, (), Value, _, _>(
        "create",
        |ctx: TypedContext<(), KeysCreateOptions, ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c
                    .keys_create(&ctx.options.name, ctx.options.max_inflight)
                    .await
                {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Create a shim API key — the secret is returned exactly once")
    .done();

    let keys_update = CommandDef::typed::<KeyIdArgs, KeysUpdateOptions, (), Value, _, _>(
        "update",
        |ctx: TypedContext<KeyIdArgs, KeysUpdateOptions, ()>| async move {
            if ctx.options.enable && ctx.options.disable {
                return TypedResult::error("bad_options", "pass only one of --enable / --disable");
            }
            let enabled = if ctx.options.enable {
                Some(true)
            } else if ctx.options.disable {
                Some(false)
            } else {
                None
            };
            let max_inflight = ctx
                .options
                .max_inflight
                .map(|n| if n == 0 { None } else { Some(n) });
            match connect(&ctx.globals).await {
                Ok(c) => match c
                    .keys_update(
                        &ctx.args.id,
                        ctx.options.name.clone(),
                        enabled,
                        max_inflight,
                    )
                    .await
                {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Rename, enable/disable or re-limit a shim API key")
    .done();

    let keys_remove = CommandDef::typed::<KeyIdArgs, (), (), Value, _, _>(
        "remove",
        |ctx: TypedContext<KeyIdArgs, (), ()>| async move {
            match connect(&ctx.globals).await {
                Ok(c) => match c.keys_remove(&ctx.args.id).await {
                    Ok(v) => TypedResult::ok(v),
                    Err(e) => terr(e),
                },
                Err(e) => terr(e),
            }
        },
    )
    .description("Delete a shim API key")
    .done();

    let keys = Cli::create("keys")
        .description("Shim API keys for other machines")
        .command("list", keys_list)
        .command("create", keys_create)
        .command("update", keys_update)
        .command("remove", keys_remove);

    let http = CommandDef::typed::<(), HttpOptions, (), Value, _, _>(
        "http",
        |ctx: TypedContext<(), HttpOptions, ()>| async move {
            let addr: std::net::SocketAddr = match ctx.options.addr.parse() {
                Ok(a) => a,
                Err(e) => {
                    return TypedResult::error(
                        "bad_addr",
                        format!("--addr {}: {e}", ctx.options.addr),
                    )
                }
            };
            // Guard (same rule as the Node shim): a non-loopback bind
            // requires a bearer token; loopback stays open for local
            // agents. Every route, /mcp included, goes through it.
            let token = ctx
                .options
                .token
                .clone()
                .or_else(|| std::env::var("MC_HTTP_TOKEN").ok())
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty());
            if !addr.ip().is_loopback() && token.is_none() {
                return TypedResult::error(
                    "http_needs_token",
                    "binding a non-loopback address requires --token or MC_HTTP_TOKEN (every mc command, keys included, would otherwise be exposed)",
                );
            }
            let guard = token
                .as_ref()
                .map(|t| incurs::http::RequestGuard::bearer(t.clone()));
            let router = match incurs::http::build_cli_router_with(
                &build_cli(),
                incurs::http::RouterOptions {
                    guard,
                    ..Default::default()
                },
            ) {
                Ok(r) => r,
                Err(e) => return TypedResult::error("http_error", e.to_string()),
            };
            eprintln!(
                "[mc] HTTP + MCP surface on http://{addr} (commands at /, MCP at /mcp{guard})",
                guard = if token.is_some() { ", bearer token required" } else { "" }
            );
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => return TypedResult::error("http_error", e.to_string()),
            };
            match axum::serve(listener, router).await {
                Ok(()) => TypedResult::ok(json!({ "ok": true })),
                Err(e) => TypedResult::error("http_error", e.to_string()),
            }
        },
    )
    .description("Serve every mc command over HTTP (+ MCP at /mcp, OpenAPI from the same graph)")
    .done();

    Cli::create("mc")
        .version(env!("CARGO_PKG_VERSION"))
        .description(
            "Muse Chat CLI — one typed command graph over the Muse shim, for humans and agents",
        )
        .globals::<Globals>()
        .config(ConfigOptions {
            flag: "config".into(),
            files: vec!["mc.config.json".into(), "~/.config/mc/config.json".into()],
        })
        .format(Format::Toon)
        .command("ask", ask_command(false))
        .command("status", status)
        .command("login", login)
        .command("new", new)
        .command("last", last)
        .command("models", models)
        .command("usage", usage)
        .command("batch", batch)
        .command("doctor", doctor)
        .command("pause", pause)
        .command("resume", resume)
        .command("pause-all", pause_all)
        .command("resume-all", resume_all)
        .command("http", http)
        .group(chats)
        .group(keys)
        .root(ask_command(true))
}

#[cfg(test)]
mod argv_tests {
    // The normalize_argv matrix is exercised end-to-end (real binary and
    // the buffered test surface) in tests/cli.rs; keep one in-lib smoke
    // case so `cargo test -p mc --lib` covers it without a runtime.
    use super::normalize_argv;
    #[test]
    fn joins_bare_prompt() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            normalize_argv(v(&["hello", "world"])),
            v(&["ask", "hello world"])
        );
    }
}
