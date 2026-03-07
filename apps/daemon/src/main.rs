use anyhow::Result;
use axum::serve;
use clap::{Parser, Subcommand};
use daemon::{bootstrap_state, build_router, import_legacy_from_root};
use std::path::PathBuf;
use telemetry::init;

#[derive(Debug, Parser)]
#[command(author, version, about = "Memory Suite unified Rust daemon")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Serve,
    ImportLegacy {
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    init()?;

    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve_daemon().await,
        Command::ImportLegacy { root } => import_legacy(root).await,
    }
}

async fn serve_daemon() -> Result<()> {
    let state = bootstrap_state().await?;
    let addr = state.listen_addr()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("memory-suite unified daemon listening on {}", addr);
    serve(listener, build_router(state)).await?;
    Ok(())
}

async fn import_legacy(root: PathBuf) -> Result<()> {
    let state = bootstrap_state().await?;
    let summary = import_legacy_from_root(&state, &root).await?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}
