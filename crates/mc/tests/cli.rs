//! Buffered-surface tests (`serve_to`: argv + stdout + exit code together),
//! plus the non-CLI `tool_catalog()` boundary MCP/Code Mode consume.
//! No live shim is touched: every case here is help / schema / manifest /
//! validation, which must work with nothing running.

use serde_json::Value;

async fn run(argv: &[&str]) -> (Option<i32>, String) {
    // Through the same argv normalization the binary applies.
    let argv = mc::normalize_argv(argv.iter().map(|s| s.to_string()).collect());
    let mut buf: Vec<u8> = Vec::new();
    let code = mc::build_cli()
        .serve_to(argv, &mut buf, false)
        .await
        .expect("serve_to");
    (code, String::from_utf8(buf).expect("utf8 stdout"))
}

#[test]
fn argv_normalization_bools_and_help() {
    let n = mc::normalize_argv;
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    // bare bool flag gets an explicit value; an explicit one is kept;
    // bool VALUES are never joined into the prompt.
    assert_eq!(
        n(v(&["ask", "--new-thread", "hi"])),
        v(&["ask", "--new-thread", "true", "hi"])
    );
    assert_eq!(
        n(v(&["ask", "--new-thread", "false", "hi"])),
        v(&["ask", "--new-thread", "false", "hi"])
    );
    assert_eq!(
        n(v(&["ask", "--no-stream", "Say", "ok"])),
        v(&["ask", "--no-stream", "true", "Say ok"])
    );
}

#[test]
fn argv_normalization_bool_before_command() {
    let n = mc::normalize_argv;
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    // A bool flag BEFORE the command/bare prompt must not merge the
    // command name into the prompt (regression: indexes were computed
    // before bool expansion shifted them).
    assert_eq!(
        n(v(&["--no-stream", "hello", "world"])),
        v(&["--no-stream", "true", "ask", "hello world"])
    );
    assert_eq!(
        n(v(&["--new-thread", "ask", "hello"])),
        v(&["--new-thread", "true", "ask", "hello"])
    );
}

#[test]
fn argv_normalization_joins_free_text() {
    let n = mc::normalize_argv;
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(n(v(&["hello", "world"])), v(&["ask", "hello world"]));
    assert_eq!(
        n(v(&["ask", "Say", "exactly", "ok"])),
        v(&["ask", "Say exactly ok"])
    );
    assert_eq!(
        n(v(&["ask", "-s", "Be brief", "Say", "ok"])),
        v(&["ask", "-s", "Be brief", "Say ok"])
    );
    assert_eq!(
        n(v(&["chats", "read", "My", "Thread"])),
        v(&["chats", "read", "My Thread"])
    );
    assert_eq!(n(v(&["--json", "status"])), v(&["--json", "status"]));
    assert_eq!(n(v(&["ask", "one"])), v(&["ask", "one"]));
}

#[test]
fn argv_normalization_preserves_values_and_delimiters() {
    let n = mc::normalize_argv;
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    for args in [
        &["--schema"][..],
        &["--base"],
        &["--help"],
        &["help", "ask"],
        &["ask", "--system"],
        &["batch", "--concurrency"],
        &["ask", "--system", "--no-stream", "hello"],
        &["ask", "--system=--no-stream", "hello"],
        &["doctor", "--base", "--manual"],
        &["batch", "--concurrency", "--no-stream"],
    ] {
        assert_eq!(n(v(args)), v(args));
    }
    assert_eq!(
        n(v(&["--", "--no-stream", "hello"])),
        v(&["ask", "--", "--no-stream hello"])
    );
    assert_eq!(
        n(v(&["ask", "--", "--no-stream", "hello"])),
        v(&["ask", "--", "--no-stream hello"])
    );
    assert_eq!(
        n(v(&["--schema", "help", "ask"])),
        v(&["--schema", "help", "ask"])
    );
}

#[tokio::test]
async fn root_schema_help_and_missing_values_do_not_panic() {
    let (code, out) = run(&["--schema", "--format", "json"]).await;
    assert_eq!(code, None, "{out}");
    assert!(serde_json::from_str::<Value>(&out).is_ok(), "{out}");
    let (code, out) = run(&["--help"]).await;
    assert_eq!(code, None, "{out}");
    let (code, out) = run(&["--base"]).await;
    assert_eq!(code, Some(1), "{out}");
    assert!(out.contains("VALIDATION_ERROR"), "{out}");
}

#[tokio::test]
async fn help_lists_the_graph() {
    // Root help is `mc ask`'s (root = ask); the graph lives in --llms.
    let (code, out) = run(&["--llms"]).await;
    assert_eq!(code, None);
    for needle in ["ask", "chats", "status", "usage", "http"] {
        assert!(out.contains(needle), "help mentions {needle}: {out}");
    }
}

#[tokio::test]
async fn bare_prompt_routes_to_ask_not_help() {
    // No shim at an unroutable base + autostart off: ask must be reached
    // (shim_unreachable), proving `mc "..."` is the root ask command.
    std::env::set_var("MC_NO_AUTOSTART", "1");
    let (code, out) = run(&["--base", "http://127.0.0.1:1", "hello", "world"]).await;
    assert_eq!(code, Some(1));
    assert!(
        out.contains("shim_unreachable"),
        "root ask reached the shim layer: {out}"
    );
}

#[tokio::test]
async fn unknown_flag_is_a_validation_error() {
    let (code, out) = run(&["ask", "--badflag", "x"]).await;
    assert_eq!(code, Some(1));
    assert!(out.contains("VALIDATION_ERROR"), "{out}");
}

#[tokio::test]
async fn llms_manifest_names_every_command() {
    let (code, out) = run(&["--llms-full", "--format", "json"]).await;
    assert_eq!(code, None);
    let v: Value = serde_json::from_str(&out).expect("manifest is JSON");
    let names: Vec<&str> = v["commands"]
        .as_array()
        .expect("commands")
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    for needle in [
        "ask",
        "status",
        "login",
        "new",
        "last",
        "models",
        "usage",
        "pause",
        "resume",
        "http",
        "chats list",
        "chats read",
        "chats media",
        "keys list",
        "keys create",
        "keys update",
        "keys remove",
    ] {
        assert!(
            names.iter().any(|n| n.ends_with(needle)),
            "manifest has {needle}: {names:?}"
        );
    }
}

#[tokio::test]
async fn command_schema_is_published() {
    let (code, out) = run(&["ask", "--schema", "--format", "json"]).await;
    assert_eq!(code, None);
    let v: Value = serde_json::from_str(&out).expect("schema is JSON");
    let text = v.to_string();
    assert!(
        text.contains("prompt"),
        "schema names the prompt arg: {text}"
    );
    // Schema JSON uses the CLI (kebab-case) spellings.
    assert!(text.contains("new-thread"), "schema names options: {text}");
}

#[test]
fn tool_catalog_matches_mcp_surface() {
    let catalog = mc::build_cli().tool_catalog();
    let names: Vec<String> = catalog
        .definitions()
        .iter()
        .map(|d| d.name.clone())
        .collect();
    for needle in [
        "ask",
        "status",
        "login",
        "new",
        "last",
        "usage",
        "chats_list",
        "chats_read",
        "chats_media",
        "keys_list",
        "keys_create",
        "keys_update",
        "keys_remove",
    ] {
        assert!(
            names.iter().any(|n| n == needle),
            "tool {needle} in {names:?}"
        );
    }
    for def in catalog.definitions() {
        assert!(
            !def.description.is_empty(),
            "tool {} has a description",
            def.name
        );
        assert!(
            def.output_schema.is_some(),
            "tool {} publishes an output schema",
            def.name
        );
    }
}
