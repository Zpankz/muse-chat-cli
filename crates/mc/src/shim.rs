//! Shim client: every Muse operation is one typed call to the local
//! OpenAI-compatible shim (`muse-server.mjs --serve-only`).
//!
//! `mc` never talks to muse.ai directly and never reads credentials — the
//! Node server owns the browser / Noise transports, the account pool and
//! quota handling. This module only knows the shim's HTTP contract:
//!
//! - `POST /v1/chat/completions`  (SSE when `stream:true`, else one JSON body)
//! - `GET  /health`, `/v1/models`, `/v1/muse/chats|chat|media|usage`
//! - `POST /v1/muse/pause`
//!
//! Errors mirror the shim's own mapping: quota -> `insufficient_quota`
//! (retryable), unreadable attachment -> `attachment_unreadable`,
//! everything else -> `muse_error`. A dropped SSE connection aborts the
//! request, which is how the shim cancels the Muse turn server-side.

use std::time::Duration;

use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde_json::{json, Value};

/// One shim failure, classified for the CLI's error envelope.
#[derive(Debug)]
pub struct ShimError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl ShimError {
    pub fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
    fn unreachable(base: &str, e: reqwest::Error) -> Self {
        Self::new(
            "shim_unreachable",
            format!("cannot reach the Muse shim at {base} ({e}); start it with `node muse-server.mjs --serve-only` or set MC_NO_AUTOSTART=1 off"),
            true,
        )
    }
}

impl std::fmt::Display for ShimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for ShimError {}

/// A chat request, pre-translation. `mc` builds the OpenAI body from this.
#[derive(Debug, Clone, Default)]
pub struct ChatRequest {
    pub prompt: String,
    pub system: Option<String>,
    pub model: String,
    pub timeout_ms: u64,
    pub new_thread: bool,
    pub files: Vec<String>,
    pub chat: Option<String>,
    pub account: Option<String>,
    pub json_schema: Option<Value>,
}

/// The completed (non-streamed) reply.
#[derive(Debug, Clone)]
pub struct ChatReply {
    pub content: String,
    pub raw: Value,
    pub account: Option<String>,
    pub tool_calls: Option<Value>,
    pub session_id: Option<String>,
}

/// One completed batch slot: the input prompt plus its isolated reply.
/// `reply` is `Err` for that item only — one item's failure never cancels
/// or fails the others.
#[derive(Debug)]
pub struct BatchItemResult {
    pub prompt: String,
    pub reply: Result<ChatReply, ShimError>,
}

/// Client for one shim base URL (origin, no trailing `/v1`).
#[derive(Debug, Clone)]
pub struct ShimClient {
    base: String,
    http: reqwest::Client,
}

impl ShimClient {
    pub fn new(base: &str) -> Result<Self, ShimError> {
        let mut headers = HeaderMap::new();
        if let Ok(key) = std::env::var("MUSE_SHIM_API_KEY") {
            if !key.trim().is_empty() {
                if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", key.trim())) {
                    headers.insert(AUTHORIZATION, v);
                }
            }
        }
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| ShimError::new("client_error", e.to_string(), false))?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            http,
        })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    async fn get_json(&self, path: &str) -> Result<Value, ShimError> {
        let res = self
            .http
            .get(self.url(path))
            .send()
            .await
            .map_err(|e| ShimError::unreachable(&self.base, e))?;
        parse_json_response(res).await
    }

    /// `GET /health` — transport / login state plus model ids.
    pub async fn health(&self) -> Result<Value, ShimError> {
        self.get_json("/health").await
    }

    /// `GET /v1/models`.
    pub async fn models(&self) -> Result<Value, ShimError> {
        self.get_json("/v1/models").await
    }

    /// `GET /v1/muse/chats[?query=&account=]`.
    pub async fn chats(
        &self,
        query: Option<&str>,
        account: Option<&str>,
    ) -> Result<Value, ShimError> {
        let mut qs: Vec<String> = Vec::new();
        if let Some(q) = query {
            qs.push(format!("query={}", urlencode(q)));
        }
        if let Some(a) = account {
            qs.push(format!("account={}", urlencode(a)));
        }
        let path = if qs.is_empty() {
            "/v1/muse/chats".to_string()
        } else {
            format!("/v1/muse/chats?{}", qs.join("&"))
        };
        self.get_json(&path).await
    }

    /// `GET /v1/muse/chat?target=&max=&account=` — messages of one chat.
    pub async fn read_chat(
        &self,
        target: Option<&str>,
        max: u32,
        account: Option<&str>,
    ) -> Result<Value, ShimError> {
        let mut qs = vec![format!("max={max}")];
        if let Some(t) = target {
            qs.push(format!("target={}", urlencode(t)));
        }
        if let Some(a) = account {
            qs.push(format!("account={}", urlencode(a)));
        }
        self.get_json(&format!("/v1/muse/chat?{}", qs.join("&")))
            .await
    }

    /// `GET /v1/muse/media?target=&download=1&dir=&account=`.
    pub async fn media(
        &self,
        target: Option<&str>,
        download: bool,
        dir: Option<&str>,
        account: Option<&str>,
    ) -> Result<Value, ShimError> {
        let mut qs: Vec<String> = Vec::new();
        if let Some(t) = target {
            qs.push(format!("target={}", urlencode(t)));
        }
        if download {
            qs.push("download=1".to_string());
        }
        if let Some(d) = dir {
            qs.push(format!("dir={}", urlencode(d)));
        }
        if let Some(a) = account {
            qs.push(format!("account={}", urlencode(a)));
        }
        let path = if qs.is_empty() {
            "/v1/muse/media".to_string()
        } else {
            format!("/v1/muse/media?{}", qs.join("&"))
        };
        self.get_json(&path).await
    }

    /// `GET /v1/muse/usage[?account=]`.
    pub async fn usage(&self, account: Option<&str>) -> Result<Value, ShimError> {
        let path = match account {
            Some(a) => format!("/v1/muse/usage?account={}", urlencode(a)),
            None => "/v1/muse/usage".to_string(),
        };
        self.get_json(&path).await
    }

    /// `POST /v1/muse/pause {account, paused}` (noise transport only).
    pub async fn pause(&self, account: &str, paused: bool) -> Result<Value, ShimError> {
        self.post_json(
            "/v1/muse/pause",
            json!({ "account": account, "paused": paused }),
        )
        .await
    }

    async fn post_json(&self, path: &str, body: Value) -> Result<Value, ShimError> {
        let res = self
            .http
            .post(self.url(path))
            .json(&body)
            .send()
            .await
            .map_err(|e| ShimError::unreachable(&self.base, e))?;
        parse_json_response(res).await
    }

    /// `POST /v1/muse/login` — sign in (unattended with .env/OTP creds, else
    /// manual in the opened browser). Secrets are never CLI arguments:
    /// callers pass only non-secret routing fields; the server reads its
    /// own `.env` for credentials (see muse-server `muse_login`).
    pub async fn login(
        &self,
        timeout_sec: Option<u64>,
        account: Option<&str>,
        auto: Option<bool>,
    ) -> Result<Value, ShimError> {
        let mut body = json!({});
        if let Some(t) = timeout_sec {
            body["timeout_sec"] = json!(t);
        }
        if let Some(a) = account {
            body["account"] = json!(a);
        }
        if let Some(a) = auto {
            body["auto"] = json!(a);
        }
        self.post_json("/v1/muse/login", body).await
    }

    /// `POST /v1/muse/new` — start a fresh thread / materialize one on send.
    pub async fn new_chat(&self, account: Option<&str>) -> Result<Value, ShimError> {
        let mut body = json!({});
        if let Some(a) = account {
            body["account"] = json!(a);
        }
        self.post_json("/v1/muse/new", body).await
    }

    /// `GET /v1/muse/last[?account=]` — latest assistant reply, no send.
    pub async fn last(&self, account: Option<&str>) -> Result<Value, ShimError> {
        let path = match account {
            Some(a) => format!("/v1/muse/last?account={}", urlencode(a)),
            None => "/v1/muse/last".to_string(),
        };
        self.get_json(&path).await
    }

    /// `GET /v1/muse/keys` — key metadata only (never secrets).
    pub async fn keys_list(&self) -> Result<Value, ShimError> {
        self.get_json("/v1/muse/keys").await
    }

    /// `POST /v1/muse/keys {name, maxInflight?}` — secret returned **once**
    /// in the response; callers must treat it as a credential.
    pub async fn keys_create(
        &self,
        name: &str,
        max_inflight: Option<u64>,
    ) -> Result<Value, ShimError> {
        let mut body = json!({ "name": name });
        if let Some(n) = max_inflight {
            body["maxInflight"] = json!(n);
        }
        self.post_json("/v1/muse/keys", body).await
    }

    /// `POST /v1/muse/keys/<id> {name?, enabled?, maxInflight?}`.
    pub async fn keys_update(
        &self,
        id: &str,
        name: Option<String>,
        enabled: Option<bool>,
        max_inflight: Option<Option<u64>>,
    ) -> Result<Value, ShimError> {
        let mut body = json!({});
        if let Some(n) = name {
            body["name"] = json!(n);
        }
        if let Some(e) = enabled {
            body["enabled"] = json!(e);
        }
        if let Some(m) = max_inflight {
            body["maxInflight"] = match m {
                Some(n) => json!(n),
                None => Value::Null,
            };
        }
        self.post_json(&format!("/v1/muse/keys/{}", urlencode(id)), body)
            .await
    }

    /// `DELETE /v1/muse/keys/<id>`.
    pub async fn keys_remove(&self, id: &str) -> Result<Value, ShimError> {
        let res = self
            .http
            .delete(self.url(&format!("/v1/muse/keys/{}", urlencode(id))))
            .send()
            .await
            .map_err(|e| ShimError::unreachable(&self.base, e))?;
        parse_json_response(res).await
    }

    fn chat_body(&self, req: &ChatRequest, stream: bool) -> Value {
        let mut messages = Vec::new();
        if let Some(sys) = &req.system {
            if !sys.is_empty() {
                messages.push(json!({ "role": "system", "content": sys }));
            }
        }
        messages.push(json!({ "role": "user", "content": req.prompt }));
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": stream,
        });
        if !req.files.is_empty() {
            body["files"] = json!(req.files);
        }
        if let Some(c) = &req.chat {
            body["chat"] = json!(c);
        }
        if let Some(a) = &req.account {
            body["account"] = json!(a);
        }
        if let Some(schema) = &req.json_schema {
            body["response_format"] = json!({
                "type": "json_schema",
                "json_schema": { "name": "response", "schema": schema, "strict": false }
            });
        }
        body
    }

    fn chat_request(&self, req: &ChatRequest, stream: bool) -> reqwest::RequestBuilder {
        let mut rb = self
            .http
            .post(self.url("/v1/chat/completions"))
            .timeout(Duration::from_millis(req.timeout_ms.saturating_add(30_000)))
            .header("x-muse-timeout-ms", req.timeout_ms.to_string())
            .json(&self.chat_body(req, stream));
        if req.new_thread {
            rb = rb.header("x-muse-thread", "new");
        }
        if let Some(a) = &req.account {
            rb = rb.header("x-muse-account", a.clone());
        }
        rb
    }

    /// Non-streaming chat: one JSON completion back.
    pub async fn chat(&self, req: &ChatRequest) -> Result<ChatReply, ShimError> {
        let res = self
            .chat_request(req, false)
            .send()
            .await
            .map_err(|e| ShimError::unreachable(&self.base, e))?;
        let value = parse_json_response(res).await?;
        Ok(reply_from_completion(value))
    }

    /// Batch of non-streaming chats with bounded fan-out.
    ///
    /// Runs `chat()` for each item with at most `concurrency` requests in
    /// flight (clamped to 1..=32), preserves input order in the returned
    /// `Vec`, and isolates items: one item's failure is captured in its own
    /// slot and never cancels or fails the others. Every item is forced onto
    /// a fresh Muse thread (`new_thread = true` on the copy actually sent)
    /// so batch answers cannot cross-contaminate a shared session.
    pub async fn chat_batch(
        &self,
        items: Vec<ChatRequest>,
        concurrency: usize,
    ) -> Vec<BatchItemResult> {
        let prompts: Vec<String> = items.iter().map(|r| r.prompt.clone()).collect();
        let reqs: Vec<ChatRequest> = items
            .into_iter()
            .map(|mut r| {
                r.new_thread = true;
                r
            })
            .collect();
        let this = self.clone();
        ordered_concurrent(reqs, concurrency, move |req| {
            let client = this.clone();
            async move { client.chat(&req).await }
        })
        .await
        .into_iter()
        .zip(prompts)
        .map(|(reply, prompt)| BatchItemResult { prompt, reply })
        .collect()
    }

    /// Streaming chat over SSE. `on_delta` receives each incremental piece
    /// of assistant text (already de-duplicated against the cumulative
    /// stream and against `muse_partial` restarts). The returned reply
    /// carries the full text; dropping the future aborts the HTTP request,
    /// which makes the shim cancel the Muse turn.
    pub async fn chat_stream<F: FnMut(String)>(
        &self,
        req: &ChatRequest,
        mut on_delta: F,
    ) -> Result<ChatReply, ShimError> {
        let res = self
            .chat_request(req, true)
            .send()
            .await
            .map_err(|e| ShimError::unreachable(&self.base, e))?;
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(error_from_body(status.as_u16(), &text));
        }
        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        let mut emitted = String::new();
        let mut account: Option<String> = None;
        let mut session_id: Option<String> = None;
        let mut tool_calls: Option<Value> = None;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ShimError::new("stream_error", e.to_string(), true))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buf.find('\n') {
                let line: String = buf.drain(..=pos).collect();
                let line = line.trim();
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" || data.is_empty() {
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(data) else {
                        continue;
                    };
                    if let Some(a) = v.get("account").and_then(Value::as_str) {
                        account = Some(a.to_string());
                    }
                    if let Some(s) = session_id_from_value(&v) {
                        session_id = Some(s);
                    }
                    if let Some(err) = v.get("error") {
                        return Err(error_from_value(err));
                    }
                    // Structured-output turns stream `muse_partial {offset, text}`:
                    // keep `emitted = emitted[..offset] + text` (a retry restarts at a lower offset).
                    if let Some(p) = v.get("muse_partial") {
                        let offset = p.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                        let text = p.get("text").and_then(Value::as_str).unwrap_or("");
                        let mut next: String = emitted.chars().take(offset).collect();
                        // `offset` is a JS UTF-16 length; char-take is exact for ASCII and a safe
                        // approximation otherwise — the final non-streamed body is authoritative.
                        next.push_str(text);
                        if next.len() > emitted.len() {
                            on_delta(next[emitted.len()..].to_string());
                        }
                        emitted = next;
                        continue;
                    }
                    let delta = &v["choices"][0]["delta"];
                    if let Some(tc) = delta.get("tool_calls") {
                        tool_calls = Some(tc.clone());
                    }
                    if let Some(content) = delta.get("content").and_then(Value::as_str) {
                        if !content.is_empty() {
                            emitted.push_str(content);
                            on_delta(content.to_string());
                        }
                    }
                }
            }
        }
        Ok(ChatReply {
            content: emitted.clone(),
            raw: json!({ "content": emitted, "account": account, "tool_calls": tool_calls, "session_id": session_id }),
            account,
            tool_calls,
            session_id,
        })
    }
}

/// Health probe used by autostart: true only when `/health` looks like our
/// shim (`ok: true`, a `models` array, or a `transport` field) — a foreign
/// service answering JSON on the same port must not count as healthy.
pub fn health_ok(v: &Value) -> bool {
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if v.get("models").and_then(Value::as_array).is_some() {
        return true;
    }
    if v.get("transport").is_some() {
        return true;
    }
    false
}

pub async fn shim_healthy(base: &str) -> bool {
    let Ok(client) = ShimClient::new(base) else {
        return false;
    };
    matches!(client.health().await, Ok(v) if health_ok(&v))
}

fn session_id_from_value(v: &Value) -> Option<String> {
    for key in ["session_id", "sessionId"] {
        if let Some(s) = v.get(key).and_then(Value::as_str) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn reply_from_completion(value: Value) -> ChatReply {
    let account = value
        .get("account")
        .and_then(Value::as_str)
        .map(str::to_string);
    let msg = &value["choices"][0]["message"];
    let content = match msg.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let tool_calls = msg.get("tool_calls").cloned();
    let session_id = session_id_from_value(&value);
    ChatReply {
        content,
        raw: value,
        account,
        tool_calls,
        session_id,
    }
}

/// Bounded fan-out that preserves input order.
///
/// `concurrency` is clamped to 1..=32. Each future runs to completion and
/// its output lands at its input index, so one item's `Err` never cancels
/// or fails the others. Factored free so the ordering behaviour is
/// unit-testable without HTTP (`chat_batch` is this + `chat()`).
async fn ordered_concurrent<T, O, F, Fut>(items: Vec<T>, concurrency: usize, f: F) -> Vec<O>
where
    F: Fn(T) -> Fut + Clone,
    Fut: std::future::Future<Output = O>,
{
    let limit = concurrency.clamp(1, 32);
    let pending: Vec<_> = items
        .into_iter()
        .enumerate()
        .map(|(i, item)| {
            let f = f.clone();
            async move {
                let out = f(item).await;
                (i, out)
            }
        })
        .collect();
    let mut done: Vec<(usize, O)> = futures::stream::iter(pending)
        .buffered(limit)
        .collect()
        .await;
    done.sort_by_key(|(i, _)| *i);
    done.into_iter().map(|(_, out)| out).collect()
}

async fn parse_json_response(res: reqwest::Response) -> Result<Value, ShimError> {
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| ShimError::new("shim_error", e.to_string(), true))?;
    if !status.is_success() {
        return Err(error_from_body(status.as_u16(), &text));
    }
    serde_json::from_str(&text)
        .map_err(|e| ShimError::new("shim_error", format!("shim returned non-JSON: {e}"), true))
}

fn error_from_body(status: u16, text: &str) -> ShimError {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        if let Some(err) = v.get("error") {
            return error_from_value(err);
        }
    }
    ShimError::new(
        "shim_error",
        format!(
            "shim HTTP {status}: {}",
            text.chars().take(300).collect::<String>()
        ),
        status >= 500,
    )
}

fn error_from_value(err: &Value) -> ShimError {
    let message = err
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Muse error")
        .to_string();
    let code_str = err.get("code").and_then(Value::as_str).unwrap_or("");
    let ty = err.get("type").and_then(Value::as_str).unwrap_or("");
    // The browser transport surfaces first-run state as a raw Playwright dump
    // (`locator.waitFor: Timeout ... Call log: ...`): that is not a user
    // error, it is "Muse is not ready". Classify it (case-insensitively)
    // before the generic branch so callers get a stable, actionable code.
    let lower = message.to_lowercase();
    let not_ready = lower.contains("locator.waitfor")
        || lower.contains("waiting for locator")
        || (lower.contains("composer") && lower.contains("timeout"))
        || lower.contains("not logged in")
        || lower.contains("loggedin=false");
    let (code, retryable, message): (&'static str, bool, String) = if code_str
        == "muse_quota_exhausted"
        || ty == "insufficient_quota"
    {
        ("insufficient_quota", true, message)
    } else if code_str == "attachment_unreadable" {
        ("attachment_unreadable", false, message)
    } else if ty == "authentication_error" {
        ("unauthorized", false, message)
    } else if not_ready {
        (
            "not_ready",
            true,
            "Muse composer is not ready (browser transport). This usually means no signed-in, warmed-up session yet. Run `mc status`, finish the Meta sign-in in the opened Chrome window, then retry — or run headless with MUSE_TRANSPORT=noise.".to_string(),
        )
    } else {
        ("muse_error", true, message)
    };
    ShimError::new(code, message, retryable)
}

/// Minimal percent-encoding for query values (no extra dependency).
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_escapes() {
        assert_eq!(urlencode("a b&c=d"), "a%20b%26c%3Dd");
        assert_eq!(urlencode("plain-1_~."), "plain-1_~.");
    }

    #[test]
    fn reply_extraction() {
        let v =
            json!({"choices":[{"message":{"role":"assistant","content":"hi"}}], "account":"acc1"});
        let r = reply_from_completion(v);
        assert_eq!(r.content, "hi");
        assert_eq!(r.account.as_deref(), Some("acc1"));
        assert_eq!(r.session_id, None);
    }

    #[test]
    fn reply_extracts_snake_case_session_id() {
        let v = json!({"choices":[{"message":{"role":"assistant","content":"hi"}}], "session_id":"sess-1"});
        let r = reply_from_completion(v);
        assert_eq!(r.session_id.as_deref(), Some("sess-1"));
    }

    #[test]
    fn reply_extracts_camel_case_session_id() {
        let v = json!({"choices":[{"message":{"role":"assistant","content":"hi"}}], "sessionId":"sess-2"});
        let r = reply_from_completion(v);
        assert_eq!(r.session_id.as_deref(), Some("sess-2"));
    }

    #[test]
    fn health_ok_shapes() {
        assert!(health_ok(&json!({"ok": true})));
        assert!(health_ok(&json!({"models": []})));
        assert!(health_ok(&json!({"transport": "noise"})));
        assert!(!health_ok(&json!({"ok": false})));
        assert!(!health_ok(&json!({"status": "up"})));
        assert!(!health_ok(&json!({})));
    }

    #[test]
    fn quota_classification() {
        let e = error_from_value(
            &json!({"message":"out", "type":"insufficient_quota", "code":"muse_quota_exhausted"}),
        );
        assert_eq!(e.code, "insufficient_quota");
        assert!(e.retryable);
    }

    #[test]
    fn composer_timeout_is_not_ready() {
        let raw = "Muse error: locator.waitFor: Timeout 90000ms exceeded.\nCall log:\n  - waiting for locator('[data-hatch-composer-root] textarea')";
        let e = error_from_value(&json!({"message": raw, "type": "api_error"}));
        assert_eq!(e.code, "not_ready");
        assert!(e.retryable);
        assert!(
            e.message.contains("mc status"),
            "actionable hint: {}",
            e.message
        );
        assert!(!e.message.contains("Call log"), "no Playwright dump leaks");
    }

    #[tokio::test]
    async fn ordered_concurrent_preserves_input_order() {
        let out: Vec<String> =
            super::ordered_concurrent((0..8usize).collect::<Vec<_>>(), 3, |i| async move {
                // Later items finish first (fewer yields): output must still be ordered.
                for _ in 0..(8 - i) {
                    tokio::task::yield_now().await;
                }
                format!("item-{i}")
            })
            .await;
        let want: Vec<String> = (0..8usize).map(|i| format!("item-{i}")).collect();
        assert_eq!(out, want);
    }

    #[tokio::test]
    async fn ordered_concurrent_isolates_failures() {
        let out: Vec<Result<usize, &'static str>> =
            super::ordered_concurrent((0..5usize).collect::<Vec<_>>(), 2, |i| async move {
                if i == 2 {
                    Err("boom")
                } else {
                    Ok(i * 10)
                }
            })
            .await;
        assert_eq!(out.len(), 5);
        assert_eq!(out[0], Ok(0));
        assert_eq!(out[1], Ok(10));
        assert_eq!(out[2], Err("boom"));
        assert_eq!(out[3], Ok(30));
        assert_eq!(out[4], Ok(40));
    }

    #[tokio::test]
    async fn ordered_concurrent_clamps_concurrency() {
        // 0 clamps to 1 (still runs), huge clamps to 32 (still runs).
        let one: Vec<usize> =
            super::ordered_concurrent(vec![7usize], 0, |i| async move { i }).await;
        assert_eq!(one, vec![7]);
        let many: Vec<usize> = super::ordered_concurrent(
            (0..40usize).collect::<Vec<_>>(),
            10_000,
            |i| async move { i },
        )
        .await;
        let want: Vec<usize> = (0..40usize).collect();
        assert_eq!(many, want);
    }

    /// `chat_batch` against a raw `tokio` `TcpListener` speaking minimal
    /// HTTP/1.1 — no new dev-dependencies. The stub echoes the prompt back
    /// as canned OpenAI completion JSON (plus `session_id`), 500s the
    /// `"boom"` prompt, and records whether `x-muse-thread: new` arrived.
    #[tokio::test]
    async fn chat_batch_forces_new_thread_and_preserves_order() {
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        fn content_len_of(headers: &str) -> usize {
            for line in headers.lines().skip(1) {
                let l = line.trim().to_lowercase();
                if let Some(n) = l.strip_prefix("content-length:") {
                    return n.trim().parse().unwrap_or(0);
                }
            }
            0
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen_new_thread: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
        let seen = seen_new_thread.clone();
        // Three batch items below => exactly three POSTs.
        let server = tokio::spawn(async move {
            for _ in 0..3 {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf: Vec<u8> = Vec::new();
                let mut tmp = [0u8; 4096];
                let head_end = loop {
                    let n = sock.read(&mut tmp).await.unwrap();
                    assert!(n > 0, "client closed mid-request");
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let len = content_len_of(&headers);
                while buf.len() < head_end + len {
                    let n = sock.read(&mut tmp).await.unwrap();
                    assert!(n > 0, "client closed mid-body");
                    buf.extend_from_slice(&tmp[..n]);
                }
                let v: Value = serde_json::from_slice(&buf[head_end..head_end + len]).unwrap();
                let prompt = v["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|m| m["role"] == "user")
                    .and_then(|m| m["content"].as_str())
                    .unwrap_or("")
                    .to_string();
                seen.lock()
                    .unwrap()
                    .push(headers.to_lowercase().contains("x-muse-thread: new"));
                let (status, body) = if prompt == "boom" {
                    (
                        "500 Internal Server Error",
                        json!({"error":{"message":"stub boom","type":"api_error"}}),
                    )
                } else {
                    (
                        "200 OK",
                        json!({
                            "id": "chatcmpl-stub",
                            "object": "chat.completion",
                            "model": "stub",
                            "choices": [{"index": 0, "message": {"role": "assistant", "content": format!("echo:{prompt}")}, "finish_reason": "stop"}],
                            "session_id": format!("sess-{prompt}"),
                        }),
                    )
                };
                let body = serde_json::to_string(&body).unwrap();
                let resp = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                sock.write_all(resp.as_bytes()).await.unwrap();
            }
        });

        let client = ShimClient::new(&format!("http://127.0.0.1:{port}")).unwrap();
        let mk = |prompt: &str| ChatRequest {
            prompt: prompt.to_string(),
            model: "stub".to_string(),
            timeout_ms: 5_000,
            ..Default::default() // new_thread: false on purpose — batch must force it
        };
        let out = client
            .chat_batch(vec![mk("alpha"), mk("boom"), mk("gamma")], 2)
            .await;
        server.await.unwrap();

        assert_eq!(out.len(), 3);
        assert_eq!(out[0].prompt, "alpha");
        assert_eq!(out[1].prompt, "boom");
        assert_eq!(out[2].prompt, "gamma");
        let ok0 = out[0].reply.as_ref().expect("alpha must succeed");
        assert_eq!(ok0.content, "echo:alpha");
        assert_eq!(ok0.session_id.as_deref(), Some("sess-alpha"));
        assert!(out[1].reply.is_err(), "boom must fail in its own slot");
        let ok2 = out[2]
            .reply
            .as_ref()
            .expect("gamma must succeed despite boom");
        assert_eq!(ok2.content, "echo:gamma");
        assert_eq!(ok2.session_id.as_deref(), Some("sess-gamma"));
        // Every item went out as a fresh thread even though the caller passed false.
        assert_eq!(
            seen_new_thread.lock().unwrap().as_slice(),
            &[true, true, true]
        );
    }
}
