//! Lifecycle management for a project-local Ollama server.
//!
//! When the configured LLM endpoint points at a local Ollama instance, the
//! daemon fully manages its lifecycle: it starts `ollama serve` on boot (with
//! the model directory pinned inside the project so the weights travel with the
//! repo), preloads the model into VRAM so the first turn has no cold-start
//! penalty, and stops the server on shutdown to release VRAM.
//!
//! When the endpoint is remote (cloud or hybrid), all of this is skipped — the
//! daemon never touches an Ollama process it does not own.
//!
//! ## Ownership model
//!
//! The daemon only kills an Ollama server that *it* started. If a developer is
//! already running `ollama serve` manually, the daemon preloads the model but
//! leaves the process alone on shutdown. Ownership is tracked on [`OllamaHandle`]
//! via `owns_server`, which holds the spawned child (when we own it) plus the
//! model name for VRAM release.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use app_config::LlmConfig;
use serde::Deserialize;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";
const OLLAMA_HEALTH_URL: &str = "http://127.0.0.1:11434/api/version";
const OLLAMA_TAGS_URL: &str = "http://127.0.0.1:11434/api/tags";
const OLLAMA_HOST: &str = "127.0.0.1:11434";
const OLLAMA_PRELOAD_TIMEOUT_SECS: u64 = 360;

/// Handle to a daemon-managed Ollama server. Cloned into [`AppState`] so the
/// lifecycle spans the whole process. Cheap to clone (an `Arc`).
#[derive(Clone)]
pub struct OllamaHandle {
    inner: Arc<Mutex<OllamaState>>,
}

struct OllamaState {
    /// The spawned `ollama serve` child, when the daemon owns it. `None` when
    /// Ollama was already running (developer-managed) or the endpoint is remote.
    child: Option<Child>,
    /// Model name to unload on shutdown, when known.
    model: Option<String>,
    /// Whether the daemon started the server (and thus should stop it).
    owns_server: bool,
}

impl OllamaHandle {
    /// A handle that manages nothing — used for remote/cloud endpoints or when
    /// startup fails. `stop` is a no-op on it.
    pub fn disabled() -> Self {
        Self {
            inner: Arc::new(Mutex::new(OllamaState {
                child: None,
                model: None,
                owns_server: false,
            })),
        }
    }

    /// Starts and preloads the local Ollama server if the endpoint is local,
    /// recording ownership on this handle. Best-effort: logs and leaves the
    /// handle disabled on any failure so the daemon still functions (the
    /// orchestrator's built-in fallback covers a missing model).
    ///
    /// Awaits server health + model preload, so callers that must not block
    /// boot should invoke this inside `tokio::spawn`.
    pub async fn launch(&self, llm: &LlmConfig) {
        if !is_local_ollama(llm) {
            return;
        }
        let model = llm.model.clone().unwrap_or_default();
        if model.is_empty() {
            tracing::warn!(
                "local ollama endpoint configured but no model name set; skipping startup"
            );
            return;
        }

        // Skip spawning if already running (developer may have started it
        // manually). We preload the model but do not take ownership, so
        // shutdown leaves the process alone.
        if server_healthy().await {
            let model_dir = project_model_dir();
            tracing::info!(
                %model,
                model_dir = %model_dir.display(),
                "ollama already running; preloading model (not taking ownership)"
            );
            if !preload_model(&model).await {
                warn_about_model_catalog_mismatch(&model, &model_dir).await;
            }
            let mut state = self.inner.lock().await;
            state.model = Some(model);
            state.owns_server = false;
            return;
        }

        let model_dir = project_model_dir();
        tracing::info!(model_dir = %model_dir.display(), "starting project-local ollama serve");

        let mut cmd = Command::new("ollama");
        cmd.arg("serve")
            .env("OLLAMA_MODELS", &model_dir)
            .env("OLLAMA_HOST", OLLAMA_HOST)
            .env("OLLAMA_KEEP_ALIVE", "-1")
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                tracing::warn!(error = %error, "failed to spawn ollama serve; local llm will be unavailable");
                return;
            }
        };

        // Wait for the server to accept connections (up to ~10s).
        let mut healthy = false;
        for _ in 0..50 {
            if server_healthy().await {
                healthy = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        if healthy {
            tracing::info!(%model, "ollama server healthy; preloading model");
            if !preload_model(&model).await {
                warn_about_model_catalog_mismatch(&model, &model_dir).await;
            }
        } else {
            tracing::warn!(
                "ollama server did not become healthy within timeout; continuing anyway"
            );
        }

        let mut state = self.inner.lock().await;
        state.child = Some(child);
        state.model = Some(model);
        state.owns_server = true;
    }

    /// Stops the daemon-managed Ollama server on shutdown. When the daemon owns
    /// the server it unloads the model (to release VRAM) then kills the child
    /// process. For a developer-managed server it only releases VRAM, leaving
    /// the process up.
    pub async fn stop(&self) {
        let mut state = self.inner.lock().await;

        // Release VRAM whenever we know the model, regardless of ownership.
        if let Some(model) = state.model.clone() {
            unload_model(&model).await;
        }

        if !state.owns_server {
            return;
        }

        if let Some(mut child) = state.child.take() {
            match child.kill().await {
                Ok(()) => tracing::info!("stopped daemon-managed ollama server"),
                Err(error) => tracing::warn!(error = %error, "failed to kill ollama server"),
            }
        }
    }
}

impl Default for OllamaHandle {
    fn default() -> Self {
        Self::disabled()
    }
}

/// Returns true when the LLM endpoint points at a local Ollama instance that
/// this daemon should manage.
fn is_local_ollama(llm: &LlmConfig) -> bool {
    llm.endpoint
        .as_deref()
        .map(|endpoint| {
            let lowered = endpoint.to_ascii_lowercase();
            (lowered.contains("127.0.0.1") || lowered.contains("localhost"))
                && lowered.contains("11434")
        })
        .unwrap_or(false)
}

/// Model directory pinned inside the project so weights travel with the repo.
fn project_model_dir() -> std::path::PathBuf {
    crate::paths::workspace_root().join("models").join("ollama")
}

/// Preloads the model into VRAM with an empty generation so the first real
/// turn has no load latency. `keep_alive: -1` pins it resident.
async fn preload_model(model: &str) -> bool {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "keep_alive": -1,
        "prompt": "",
        "stream": false
    });
    match client
        .post(format!("{OLLAMA_BASE_URL}/api/generate"))
        .json(&body)
        .timeout(Duration::from_secs(OLLAMA_PRELOAD_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            tracing::info!(%model, "ollama model preloaded and pinned in VRAM");
            true
        }
        Ok(resp) => {
            tracing::warn!(status = %resp.status(), "ollama preload returned non-success");
            false
        }
        Err(error) => {
            tracing::warn!(error = %error, "ollama preload request failed");
            false
        }
    }
}

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaTag>,
}

#[derive(Debug, Deserialize)]
struct OllamaTag {
    name: String,
}

async fn warn_about_model_catalog_mismatch(model: &str, expected_model_dir: &Path) {
    let configured_model_dir = std::env::var("OLLAMA_MODELS").unwrap_or_default();
    match reqwest::Client::new()
        .get(OLLAMA_TAGS_URL)
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let status = resp.status();
            match resp.json::<OllamaTagsResponse>().await {
                Ok(tags) => {
                    let visible_models = tags
                        .models
                        .into_iter()
                        .map(|tag| tag.name)
                        .collect::<Vec<_>>()
                        .join(", ");
                    tracing::warn!(
                        %model,
                        visible_models,
                        expected_model_dir = %expected_model_dir.display(),
                        configured_model_dir,
                        "ollama cannot preload configured model; running server may be using a different model library"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        %model,
                        %status,
                        error = %error,
                        expected_model_dir = %expected_model_dir.display(),
                        configured_model_dir,
                        "ollama preload failed and model catalog could not be decoded"
                    );
                }
            }
        }
        Ok(resp) => {
            tracing::warn!(
                %model,
                status = %resp.status(),
                expected_model_dir = %expected_model_dir.display(),
                configured_model_dir,
                "ollama preload failed and model catalog request returned non-success"
            );
        }
        Err(error) => {
            tracing::warn!(
                %model,
                error = %error,
                expected_model_dir = %expected_model_dir.display(),
                configured_model_dir,
                "ollama preload failed and model catalog request failed"
            );
        }
    }
}

/// Unloads the model from VRAM by setting `keep_alive: 0`.
async fn unload_model(model: &str) {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "keep_alive": 0,
        "prompt": "",
        "stream": false
    });
    let _ = client
        .post(format!("{OLLAMA_BASE_URL}/api/generate"))
        .json(&body)
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    tracing::info!(%model, "requested ollama model unload on shutdown");
}

async fn server_healthy() -> bool {
    reqwest::Client::new()
        .get(OLLAMA_HEALTH_URL)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map(|resp| resp.status().is_success())
        .unwrap_or(false)
}
