//! Configuration resolution for `mc`.
//!
//! Precedence (highest first): explicit `--base` flag > `mc.config.json`
//! (incurs config file, `{"commands":{...}}` — see `mc --config-schema`) >
//! environment (`MUSE_SHIM_URL`, `MC_*`) > built-in defaults. The Node
//! server remains the only reader of Muse credentials; `mc` config only
//! carries connection + presentation defaults.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;

use crate::shim::{shim_healthy, ShimError};

pub const DEFAULT_BASE: &str = "http://127.0.0.1:8787";
pub const DEFAULT_MODEL: &str = "muse-spark-1.3";
pub const DEFAULT_TIMEOUT_MS: u64 = 240_000;

/// Resolved runtime settings shared by every command.
#[derive(Debug, Clone)]
pub struct Settings {
    /// Shim origin, e.g. `http://127.0.0.1:8787` (no `/v1` suffix).
    pub base: String,
    pub model: String,
    pub timeout_ms: u64,
    pub autostart: bool,
    /// Directory holding the Node server (`muse-server.mjs`) for autostart.
    pub server_dir: Option<PathBuf>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base: normalize_base(
                &std::env::var("MUSE_SHIM_URL").unwrap_or_else(|_| DEFAULT_BASE.to_string()),
            ),
            model: std::env::var("MC_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string()),
            timeout_ms: std::env::var("MC_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_TIMEOUT_MS),
            autostart: std::env::var("MC_NO_AUTOSTART")
                .map(|v| v != "1")
                .unwrap_or(true)
                && std::env::var("MUSE_CLI_AUTOSTART")
                    .map(|v| v != "0")
                    .unwrap_or(true),
            server_dir: find_server_dir(),
        }
    }
}

/// Accept `http://host:8787`, `.../v1` or a trailing slash interchangeably.
pub fn normalize_base(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    if let Some(stripped) = s.strip_suffix("/v1") {
        s = stripped.to_string();
    }
    if s.is_empty() {
        DEFAULT_BASE.to_string()
    } else {
        s
    }
}

fn find_server_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("MC_SERVER_DIR") {
        let p = PathBuf::from(d);
        if p.join("muse-server.mjs").exists() {
            return Some(p);
        }
    }
    // Walk up from the binary and from the cwd: the repo root holds the server.
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        starts.push(exe);
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for start in starts {
        let mut dir: &Path = &start;
        for _ in 0..8 {
            if dir.join("muse-server.mjs").exists() {
                return Some(dir.to_path_buf());
            }
            // Exhausting one root must not skip the next: an installed
            // binary (~/.local/bin/mc) reaches `/` before the cwd walk.
            let Some(parent) = dir.parent() else { break };
            dir = parent;
        }
    }
    None
}

/// Ensure a shim answers at `settings.base`, auto-starting the Node server
/// when allowed. The child is detached: unlike the old `muse-cli.mjs` it is
/// NOT killed on exit — a warm shim (browser logged in, Noise pool connected)
/// is the state-of-the-art default, and `mc server stop` / the server's own
/// lifecycle owns shutdown.
pub async fn ensure_shim(settings: &Settings) -> Result<(), ShimError> {
    if shim_healthy(&settings.base).await {
        return Ok(());
    }
    if !settings.autostart {
        return Err(ShimError::new(
            "shim_unreachable",
            format!("no shim at {} and autostart is off; start `node muse-server.mjs --serve-only` or unset MC_NO_AUTOSTART", settings.base),
            true,
        ));
    }
    let dir = settings.server_dir.clone().ok_or_else(|| ShimError::new(
        "shim_unreachable",
        "no shim is running and muse-server.mjs was not found; set MC_SERVER_DIR to the repo root or start the server manually".to_string(),
        false,
    ))?;
    eprintln!(
        "[mc] starting shim ({}) …",
        dir.join("muse-server.mjs").display()
    );
    std::process::Command::new("node")
        .arg("muse-server.mjs")
        .arg("--serve-only")
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            ShimError::new(
                "shim_unreachable",
                format!("failed to spawn node: {e}"),
                true,
            )
        })?;
    let deadline = std::time::Instant::now() + Duration::from_secs(45);
    while std::time::Instant::now() < deadline {
        if shim_healthy(&settings.base).await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Err(ShimError::new(
        "shim_unreachable",
        "shim did not become ready in 45s".to_string(),
        true,
    ))
}

// Config-file option defaults are NOT read here: incurs merges
// `mc.config.json` (`{"commands":{"<cmd>":{"options":{...}}}}`,
// see `mc --config-schema`) into each command's `ctx.options` itself,
// and handlers read them from there (falling back to Settings/env).
// A second reader in this crate would be a competing source of truth.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_v1_and_slash() {
        assert_eq!(
            normalize_base("http://127.0.0.1:8787/v1/"),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_base("http://127.0.0.1:8787"),
            "http://127.0.0.1:8787"
        );
    }
}
