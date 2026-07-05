use anyhow::Result;
use axum::serve;
use clap::{Parser, Subcommand};
use daemon::{bootstrap_state_with_shutdown, build_router};
use telemetry::init;
use tokio::sync::watch;

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
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let state = bootstrap_state_with_shutdown(shutdown_tx).await?;
    let addr = state.listen_addr()?;
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            anyhow::anyhow!(
                "startup failed: port {} is already in use.\n\
                 Fix options:\n\
                   1. Stop the process occupying port {}.\n\
                   2. Set MEMORY_SUITE_PORT=<alternate> (e.g. 18080) before starting.",
                addr.port(),
                addr.port()
            )
        } else {
            anyhow::anyhow!("startup failed: could not bind to {}: {}", addr, e)
        }
    })?;
    tracing::info!("memory-suite unified daemon listening on {}", addr);
    serve(listener, build_router(state))
        .with_graceful_shutdown(async move {
            loop {
                if *shutdown_rx.borrow() {
                    break;
                }
                if shutdown_rx.changed().await.is_err() {
                    break;
                }
            }
            tracing::info!("memory-suite unified daemon shutdown requested");
        })
        .await?;
    Ok(())
}
