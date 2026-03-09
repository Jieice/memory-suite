use anyhow::Result;
use axum::serve;
use clap::{Parser, Subcommand};
use daemon::{bootstrap_state, build_router};
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
}

#[tokio::main]
async fn main() -> Result<()> {
    init()?;

    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve_daemon().await,
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
