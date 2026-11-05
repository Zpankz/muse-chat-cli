//! `mc` binary: `mc build_cli().serve()` — the incurs lifecycle handles
//! `--help/--version/--llms/--mcp/--schema/--format/completions/skills/
//! plugin` and routes everything else through the typed command graph.
//! Bare `mc "prompt"` falls through the root command to `ask`.

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Join multi-word free text (`mc Say exactly ok`) into the single
    // prompt argument incurs' parser expects; see mc::normalize_argv.
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let argv = mc::normalize_argv(argv);
    mc::build_cli().serve_with(argv).await
}
