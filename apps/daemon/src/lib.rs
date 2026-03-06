use std::{
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use api_types::{
    AdapterStartRequest, ChatRequest, HealthResponse, ImportRequest, ImportSummary, JobKind,
    JobRequest, RuntimeOverview, TtsSpeakRequest,
};
use app_config::AppConfig;
use axum::{
    Json, Router,
    extract::{Path as AxumPath, State, WebSocketUpgrade, ws::Message},
    response::{Html, IntoResponse},
    routing::{get, post},
};
use jobs::{JobService, PythonAdapterSupervisor};
use media::TtsService;
use orchestrator::{Orchestrator, RuntimeBus};
use serde_json::Value;
use storage::{
    NewConfigArtifactRecord, NewLegacyEventRecord, NewMemoryEntryRecord, NewUserProfileRecord,
    Storage,
};
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub storage: Storage,
    pub orchestrator: Orchestrator,
    pub runtime_bus: RuntimeBus,
    pub jobs: JobService,
    pub adapters: PythonAdapterSupervisor,
    pub tts: TtsService,
}

impl AppState {
    pub async fn from_config(config: AppConfig) -> Result<Self> {
        let database_path = resolve_runtime_path(&config.storage.database_path);
        let storage = Storage::connect(&database_path).await?;
        let runtime_bus = RuntimeBus::new();
        let orchestrator = Orchestrator::new(storage.clone(), runtime_bus.clone());
        let adapters = PythonAdapterSupervisor::new(
            storage.clone(),
            config.python.executable.clone(),
            resolve_runtime_path(&config.python.models_root),
            runtime_bus.clone(),
        );
        let jobs = JobService::new(storage.clone(), adapters.clone(), runtime_bus.clone());
        let tts = TtsService::new(
            storage.clone(),
            adapters.clone(),
            runtime_bus.clone(),
            config.features.enable_mock_tts,
        );

        Ok(Self {
            config,
            storage,
            orchestrator,
            runtime_bus,
            jobs,
            adapters,
            tts,
        })
    }

    pub fn listen_addr(&self) -> Result<SocketAddr> {
        format!("{}:{}", self.config.server.host, self.config.server.port)
            .parse()
            .context("invalid listen address")
    }
}

pub async fn bootstrap_state() -> Result<AppState> {
    let config_path = default_config_path();
    let config = AppConfig::load_from_file(&config_path)?;
    AppState::from_config(config).await
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/chat", post(chat))
        .route("/api/runtime/overview", get(runtime_overview))
        .route("/api/runtime/adapters", get(list_adapters))
        .route("/api/runtime/adapters/{adapter_id}/start", post(start_adapter))
        .route("/api/jobs", get(list_jobs))
        .route("/api/sessions/{session_id}/messages", get(list_session_messages))
        .route("/api/tts/speak", post(tts_speak))
        .route("/api/jobs/train", post(train_job))
        .route("/api/jobs/eval", post(eval_job))
        .route("/api/import/legacy", post(import_legacy_endpoint))
        .route("/ws/session/{session_id}", get(session_ws))
        .route("/ws/runtime", get(runtime_ws))
        .route("/overlay/live2d", get(live2d_overlay))
        .route("/overlay/danmaku", get(danmaku_overlay))
        .fallback_service(ServeDir::new(web_dist_dir()))
        .with_state(Arc::new(state))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}

fn default_config_path() -> PathBuf {
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let explicit = workspace_root.join("config").join("app.toml");
    if explicit.exists() {
        explicit
    } else {
        workspace_root.join("config").join("app.toml.example")
    }
}

fn resolve_runtime_path(path: &str) -> PathBuf {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        candidate
    } else {
        Path::new(".").join(candidate)
    }
}

fn web_dist_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("apps")
        .join("web")
        .join("dist")
}

pub async fn import_legacy_from_root(state: &AppState, root: &Path) -> Result<ImportSummary> {
    let canonical_path = root.join("data").join("canonical-memory.json");
    let proactive_path = root.join("data").join("proactive-memory.jsonl");
    let config_candidates = [
        root.join("memory-danmaku").join("config.json"),
        root.join("memory-danmaku").join("config.example.json"),
    ];

    let mut summary = ImportSummary {
        status: "completed".into(),
        source_root: root.display().to_string(),
        user_profiles_imported: 0,
        memory_entries_imported: 0,
        proactive_events_imported: 0,
        config_artifacts_imported: 0,
    };

    if canonical_path.exists() {
        let raw = fs::read_to_string(&canonical_path)
            .with_context(|| format!("failed to read {}", canonical_path.display()))?;
        let payload: Value = serde_json::from_str(&raw)
            .with_context(|| format!("invalid json in {}", canonical_path.display()))?;
        if let Some(users) = payload.get("users").and_then(Value::as_object) {
            for (user_id, user_payload) in users {
                let preferred_name = user_payload
                    .get("preferredName")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let interaction_count = user_payload
                    .get("interactionCount")
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                let updated_at = user_payload
                    .get("updatedAt")
                    .and_then(Value::as_i64)
                    .map(epoch_millis_to_utc)
                    .transpose()?;

                state
                    .storage
                    .upsert_user_profile(NewUserProfileRecord {
                        user_id: user_id.clone(),
                        preferred_name,
                        interaction_count,
                        updated_at,
                    })
                    .await?;
                summary.user_profiles_imported += 1;

                for (entry_type, key) in [
                    ("fact", "facts"),
                    ("preference", "preferences"),
                    ("task", "tasks"),
                    ("conflict", "conflicts"),
                ] {
                    if let Some(items) = user_payload.get(key).and_then(Value::as_array) {
                        for item in items {
                            state
                                .storage
                                .import_memory_entry(NewMemoryEntryRecord {
                                    user_id: user_id.clone(),
                                    entry_type: entry_type.into(),
                                    payload: item.clone(),
                                    source: canonical_path.display().to_string(),
                                })
                                .await?;
                            summary.memory_entries_imported += 1;
                        }
                    }
                }
            }
        }
    }

    if proactive_path.exists() {
        let raw = fs::read_to_string(&proactive_path)
            .with_context(|| format!("failed to read {}", proactive_path.display()))?;
        for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
            let payload: Value = serde_json::from_str(line).context("invalid proactive-memory.jsonl line")?;
            state
                .storage
                .import_legacy_event(NewLegacyEventRecord {
                    source_path: proactive_path.display().to_string(),
                    source_type: "proactive-memory".into(),
                    payload,
                })
                .await?;
            summary.proactive_events_imported += 1;
        }
    }

    let imports_root = PathBuf::from(&state.config.storage.data_root).join("imports").join("config");
    fs::create_dir_all(&imports_root)
        .with_context(|| format!("failed to create {}", imports_root.display()))?;

    for candidate in config_candidates {
        if candidate.exists() {
            let raw = fs::read_to_string(&candidate)
                .with_context(|| format!("failed to read {}", candidate.display()))?;
            let payload: Value = serde_json::from_str(&raw)
                .with_context(|| format!("invalid json in {}", candidate.display()))?;
            let file_name = candidate
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "config.json".into());
            let copied_to = imports_root.join(file_name);
            fs::write(&copied_to, &raw)
                .with_context(|| format!("failed to write {}", copied_to.display()))?;
            state
                .storage
                .import_config_artifact(NewConfigArtifactRecord {
                    path: candidate.display().to_string(),
                    kind: "json-config".into(),
                    payload,
                    copied_to: Some(copied_to.display().to_string()),
                })
                .await?;
            summary.config_artifacts_imported += 1;
            break;
        }
    }

    Ok(summary)
}

fn epoch_millis_to_utc(epoch_millis: i64) -> Result<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::from_timestamp_millis(epoch_millis)
        .context("invalid epoch millis for legacy timestamp")
}

async fn health(State(state): State<Arc<AppState>>) -> Result<Json<HealthResponse>, axum::http::StatusCode> {
    let db_ready = state
        .storage
        .health_check()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(HealthResponse {
        status: "ok".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        db_ready,
        runtime_mode: "rust_single_process".into(),
    }))
}

async fn chat(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ChatRequest>,
) -> Result<Json<api_types::ChatResponse>, axum::http::StatusCode> {
    let response = state
        .orchestrator
        .handle_chat(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn runtime_overview(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RuntimeOverview>, axum::http::StatusCode> {
    let db_ready = state
        .storage
        .health_check()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let counts = state
        .storage
        .runtime_counts()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(RuntimeOverview {
        db_ready,
        message_count: counts.messages.max(0) as u32,
        job_count: counts.jobs.max(0) as u32,
        user_profile_count: counts.user_profiles.max(0) as u32,
        memory_entry_count: counts.memory_entries.max(0) as u32,
        legacy_event_count: counts.legacy_events.max(0) as u32,
        config_artifact_count: counts.config_artifacts.max(0) as u32,
    }))
}

async fn list_jobs(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<api_types::JobRecord>>, axum::http::StatusCode> {
    let jobs = state
        .storage
        .list_jobs()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(jobs))
}

async fn list_adapters(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<api_types::AdapterRecord>>, axum::http::StatusCode> {
    let adapters = state
        .adapters
        .list_runs()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(adapters))
}

async fn start_adapter(
    AxumPath(adapter_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<AdapterStartRequest>,
) -> Result<Json<api_types::AdapterRecord>, axum::http::StatusCode> {
    let adapter = state
        .adapters
        .start_adapter(&adapter_id, request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(adapter))
}

async fn list_session_messages(
    AxumPath(session_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<api_types::StoredMessage>>, axum::http::StatusCode> {
    let messages = state
        .storage
        .list_messages(&session_id)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(messages))
}

async fn tts_speak(
    State(state): State<Arc<AppState>>,
    Json(request): Json<TtsSpeakRequest>,
) -> Result<Json<api_types::TtsSpeakResponse>, axum::http::StatusCode> {
    let response = state
        .tts
        .enqueue(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn train_job(
    State(state): State<Arc<AppState>>,
    Json(request): Json<JobRequest>,
) -> Result<Json<api_types::JobResponse>, axum::http::StatusCode> {
    let response = state
        .jobs
        .create_job(JobKind::Train, request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn eval_job(
    State(state): State<Arc<AppState>>,
    Json(request): Json<JobRequest>,
) -> Result<Json<api_types::JobResponse>, axum::http::StatusCode> {
    let response = state
        .jobs
        .create_job(JobKind::Eval, request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn import_legacy_endpoint(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ImportRequest>,
) -> Result<Json<ImportSummary>, axum::http::StatusCode> {
    let root = PathBuf::from(request.root);
    let summary = import_legacy_from_root(&state, &root)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(summary))
}

async fn session_ws(
    ws: WebSocketUpgrade,
    AxumPath(session_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |mut socket| async move {
        let mut receiver = state.orchestrator.subscribe(&session_id).await;
        while let Ok(event) = receiver.recv().await {
            match serde_json::to_string(&event) {
                Ok(payload) => {
                    if socket.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    })
}

async fn runtime_ws(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |mut socket| async move {
        let mut receiver = state.runtime_bus.subscribe();
        while let Ok(event) = receiver.recv().await {
            match serde_json::to_string(&event) {
                Ok(payload) => {
                    if socket.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    })
}

async fn live2d_overlay() -> Html<&'static str> {
    Html(
        r#"<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>Memory Suite Live2D</title></head>
  <body style="font-family:system-ui;background:#0f172a;color:#e2e8f0">
    <main><h1>Memory Suite Unified Live2D Overlay</h1><p>Rust daemon overlay endpoint is active.</p></main>
  </body>
</html>"#,
    )
}

async fn danmaku_overlay() -> Html<&'static str> {
    Html(
        r#"<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>Memory Suite Danmaku</title></head>
  <body style="font-family:system-ui;background:#111827;color:#f9fafb">
    <main><h1>Memory Suite Unified Danmaku Overlay</h1><p>Single-process gateway overlay is active.</p></main>
  </body>
</html>"#,
    )
}
