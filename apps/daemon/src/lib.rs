use std::{
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use api_types::{
    AdapterStartRequest, ChatRequest, DanmakuDisconnectReportRequest, DanmakuHeartbeatRequest,
    DanmakuInjectRequest, DanmakuProtocolEventRequest, DanmakuSourceUpdateRequest, HealthResponse, ImportRequest,
    ImportSummary, JobKind, JobRequest, KnowledgeCatalogResponse, Live2dConfigRequest,
    Live2dEmotionRequest, Live2dSubtitleRequest, RuntimeOverview, ToolManifestRecord,
    ToolSchemaRecord, TtsSpeakRequest, DanmakuSessionCloseRequest, DanmakuSessionErrorRequest,
    DanmakuSessionOpenRequest,
};
use app_config::AppConfig;
use axum::{
    Json, Router,
    extract::{Path as AxumPath, Query, State, WebSocketUpgrade, ws::Message},
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::{get, post},
};
use gateway::GatewayService;
use jobs::{JobService, PythonAdapterSupervisor};
use media::{Live2dService, TtsService};
use orchestrator::{Orchestrator, RuntimeBus};
use serde::Deserialize;
use serde_json::Value;
use storage::{
    NewConfigArtifactRecord, NewLegacyEventRecord, NewMemoryEntryRecord, NewUserProfileRecord,
    Storage,
};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub storage: Storage,
    pub orchestrator: Orchestrator,
    pub runtime_bus: RuntimeBus,
    pub jobs: JobService,
    pub adapters: PythonAdapterSupervisor,
    pub tts: TtsService,
    pub live2d: Live2dService,
    pub gateway: GatewayService,
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
            resolve_runtime_path(&config.storage.data_root).join("audio-cache"),
        );
        let live2d = Live2dService::new(storage.clone(), runtime_bus.clone());
        let gateway = GatewayService::new(
            storage.clone(),
            adapters.clone(),
            orchestrator.clone(),
            live2d.clone(),
            runtime_bus.clone(),
        );
        gateway.spawn_reconnect_worker();
        prime_danmaku_source_from_runtime_storage(&storage).await?;
        spawn_danmaku_autostart(gateway.clone(), storage.clone());

        Ok(Self {
            config,
            storage,
            orchestrator,
            runtime_bus,
            jobs,
            adapters,
            tts,
            live2d,
            gateway,
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
        .route("/api/knowledge/catalog", get(knowledge_catalog))
        .route("/api/tools/manifests", get(list_tool_manifests))
        .route("/api/runtime/adapters", get(list_adapters))
        .route("/api/runtime/adapters/{adapter_id}/start", post(start_adapter))
        .route("/api/jobs", get(list_jobs))
        .route("/api/sessions/{session_id}/messages", get(list_session_messages))
        .route("/api/tts/speak", post(tts_speak))
        .route("/api/live2d/state", get(live2d_state))
        .route("/api/live2d/subtitle", post(live2d_subtitle))
        .route("/api/live2d/emotion", post(live2d_emotion))
        .route("/api/live2d/config", post(live2d_config))
        .route("/api/danmaku/source", get(danmaku_source).post(update_danmaku_source))
        .route("/api/danmaku/state", get(danmaku_state))
        .route("/api/danmaku/bootstrap", post(bootstrap_danmaku))
        .route("/api/danmaku/native-probe", post(danmaku_native_probe))
        .route("/api/danmaku/native-connect-once", post(danmaku_native_connect_once))
        .route("/api/danmaku/native-session/start", post(danmaku_native_session_start))
        .route("/api/danmaku/connect", post(connect_danmaku))
        .route("/api/danmaku/disconnect", post(disconnect_danmaku))
        .route("/api/danmaku/heartbeat", post(danmaku_heartbeat))
        .route("/api/danmaku/report-disconnect", post(danmaku_report_disconnect))
        .route("/api/danmaku/session/open", post(danmaku_session_open))
        .route("/api/danmaku/session/error", post(danmaku_session_error))
        .route("/api/danmaku/session/close", post(danmaku_session_close))
        .route("/api/danmaku/protocol-event", post(danmaku_protocol_event))
        .route("/api/gateway/danmaku", post(gateway_danmaku))
        .route("/api/jobs/train", post(train_job))
        .route("/api/jobs/eval", post(eval_job))
        .route("/api/import/legacy", post(import_legacy_endpoint))
        .route("/ws/session/{session_id}", get(session_ws))
        .route("/ws/runtime", get(runtime_ws))
        .route("/ws/overlay", get(overlay_ws))
        .route("/overlay/live2d", get(live2d_overlay))
        .route("/overlay/danmaku", get(danmaku_overlay))
        .nest_service("/live2d-assets", ServeDir::new(live2d_assets_dir()))
        .nest_service("/overlay-vendor/pixi", ServeDir::new(pixi_vendor_dir()))
        .nest_service("/overlay-vendor/live2d", ServeDir::new(live2d_vendor_dir()))
        .fallback_service(
            ServeDir::new(web_dist_dir())
                .not_found_service(ServeFile::new(web_dist_dir().join("index.html"))),
        )
        .with_state(Arc::new(state))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}

fn default_config_path() -> PathBuf {
    let workspace_root = workspace_root();
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
    workspace_root().join("apps").join("web").join("dist")
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn tools_root() -> PathBuf {
    workspace_root().join("data").join("tools")
}

fn overlay_pages_dir() -> PathBuf {
    workspace_root().join("apps").join("web").join("overlays")
}

fn live2d_assets_dir() -> PathBuf {
    workspace_root()
        .join("Liver2d")
        .join("hiyori_pro_zh")
        .join("runtime")
}

fn pixi_vendor_dir() -> PathBuf {
    workspace_root()
        .join("apps")
        .join("web")
        .join("node_modules")
        .join("pixi.js")
        .join("dist")
        .join("browser")
}

fn live2d_vendor_dir() -> PathBuf {
    workspace_root()
        .join("apps")
        .join("web")
        .join("node_modules")
        .join("pixi-live2d-display")
        .join("dist")
}

pub async fn import_legacy_from_root(state: &AppState, root: &Path) -> Result<ImportSummary> {
    let canonical_path = root.join("data").join("canonical-memory.json");
    let proactive_path = root.join("data").join("proactive-memory.jsonl");
    let config_candidates = [
        root.join("memory-danmaku").join("config.json"),
        root.join("memory-danmaku").join("config.example.json"),
        root.join("config").join("danmaku.source.example.json"),
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

#[derive(Debug, Deserialize)]
struct KnowledgeCatalogParams {
    query: Option<String>,
    limit: Option<u32>,
}

async fn knowledge_catalog(
    State(state): State<Arc<AppState>>,
    Query(params): Query<KnowledgeCatalogParams>,
) -> Result<Json<KnowledgeCatalogResponse>, axum::http::StatusCode> {
    let query = params.query.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let limit = params.limit.unwrap_or(24).clamp(1, 100);

    let (profiles, memory_entries, legacy_events, config_artifacts) = tokio::try_join!(
        state.storage.list_user_profiles(query, limit),
        state.storage.list_memory_entries(query, limit),
        state.storage.list_legacy_events(query, limit.min(12)),
        state.storage.list_config_artifacts(query, limit.min(12)),
    )
    .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(KnowledgeCatalogResponse {
        query: query.map(ToOwned::to_owned),
        limit,
        profiles,
        memory_entries,
        legacy_events,
        config_artifacts,
    }))
}

async fn list_tool_manifests() -> Result<Json<Vec<ToolManifestRecord>>, axum::http::StatusCode> {
    let manifests = load_tool_manifests().map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(manifests))
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

async fn live2d_state(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::Live2dStateRecord>, axum::http::StatusCode> {
    let response = state
        .live2d
        .get_state()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn live2d_subtitle(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Live2dSubtitleRequest>,
) -> Result<Json<api_types::Live2dStateRecord>, axum::http::StatusCode> {
    let response = state
        .live2d
        .set_subtitle(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn live2d_emotion(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Live2dEmotionRequest>,
) -> Result<Json<api_types::Live2dStateRecord>, axum::http::StatusCode> {
    let response = state
        .live2d
        .set_emotion(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn live2d_config(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Live2dConfigRequest>,
) -> Result<Json<api_types::Live2dStateRecord>, axum::http::StatusCode> {
    let response = state
        .live2d
        .set_config(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn gateway_danmaku(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DanmakuInjectRequest>,
) -> Result<Json<api_types::ChatResponse>, axum::http::StatusCode> {
    let response = state
        .gateway
        .inject_danmaku(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn danmaku_source(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuSourceConfigRecord>, axum::http::StatusCode> {
    let response = state
        .gateway
        .get_source_config()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn update_danmaku_source(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DanmakuSourceUpdateRequest>,
) -> Result<Json<api_types::DanmakuSourceConfigRecord>, axum::http::StatusCode> {
    let response = state
        .gateway
        .update_source_config(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn danmaku_state(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuConnectionStateRecord>, axum::http::StatusCode> {
    let response = state
        .gateway
        .get_connection_state()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn connect_danmaku(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuConnectionActionResponse>, axum::http::StatusCode> {
    let response = state
        .gateway
        .connect()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn bootstrap_danmaku(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuBootstrapRecord>, axum::http::StatusCode> {
    let response = state
        .gateway
        .bootstrap()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn danmaku_native_probe(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuNativeProbeResponse>, axum::http::StatusCode> {
    let response = state
        .gateway
        .native_probe()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn danmaku_native_connect_once(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuNativeConnectResponse>, axum::http::StatusCode> {
    let response = state
        .gateway
        .native_connect_once()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn danmaku_native_session_start(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuConnectionActionResponse>, axum::http::StatusCode> {
    let response = state
        .gateway
        .start_native_session()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn disconnect_danmaku(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuConnectionActionResponse>, axum::http::StatusCode> {
    let response = state
        .gateway
        .disconnect()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn danmaku_heartbeat(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DanmakuHeartbeatRequest>,
) -> Result<Json<api_types::DanmakuConnectionStateRecord>, axum::http::StatusCode> {
    let response = state
        .gateway
        .heartbeat(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn danmaku_report_disconnect(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DanmakuDisconnectReportRequest>,
) -> Result<Json<api_types::DanmakuConnectionStateRecord>, axum::http::StatusCode> {
    let response = state
        .gateway
        .report_disconnect(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn danmaku_session_open(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DanmakuSessionOpenRequest>,
) -> Result<Json<api_types::DanmakuConnectionStateRecord>, axum::http::StatusCode> {
    let response = state
        .gateway
        .session_open(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn danmaku_session_error(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DanmakuSessionErrorRequest>,
) -> Result<Json<api_types::DanmakuConnectionStateRecord>, axum::http::StatusCode> {
    let response = state
        .gateway
        .session_error(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn danmaku_session_close(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DanmakuSessionCloseRequest>,
) -> Result<Json<api_types::DanmakuConnectionStateRecord>, axum::http::StatusCode> {
    let response = state
        .gateway
        .session_close(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn danmaku_protocol_event(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DanmakuProtocolEventRequest>,
) -> Result<Json<api_types::ChatResponse>, axum::http::StatusCode> {
    let response = state
        .gateway
        .ingest_protocol_event(request)
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

async fn overlay_ws(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |mut socket| async move {
        let mut receiver = state.runtime_bus.subscribe();
        while let Ok(event) = receiver.recv().await {
            if !matches!(
                event.kind,
                api_types::RuntimeEventKind::Live2dSubtitleUpdated
                    | api_types::RuntimeEventKind::Live2dEmotionUpdated
                    | api_types::RuntimeEventKind::Live2dConfigUpdated
                    | api_types::RuntimeEventKind::DanmakuReceived
                    | api_types::RuntimeEventKind::DanmakuConnectionConnecting
                    | api_types::RuntimeEventKind::DanmakuConnectionDisconnected
                    | api_types::RuntimeEventKind::DanmakuHeartbeatReceived
                    | api_types::RuntimeEventKind::DanmakuReconnectScheduled
            ) {
                continue;
            }

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

async fn live2d_overlay() -> impl IntoResponse {
    render_overlay_page("live2d.html")
}

async fn danmaku_overlay() -> impl IntoResponse {
    render_overlay_page("danmaku.html")
}

fn render_overlay_page(file_name: &str) -> impl IntoResponse {
    let path = overlay_pages_dir().join(file_name);
    match fs::read_to_string(&path) {
        Ok(html) => (StatusCode::OK, Html(html)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Html(format!(
                "<!doctype html><html><body><pre>overlay page missing: {} ({})</pre></body></html>",
                path.display(),
                error
            )),
        )
            .into_response(),
    }
}

async fn prime_danmaku_source_from_runtime_storage(storage: &Storage) -> Result<()> {
    let config_path = workspace_root().join("config").join("danmaku.source.json");
    if !config_path.exists() {
        return Ok(());
    }

    let raw = fs::read_to_string(&config_path)
        .with_context(|| format!("failed to read {}", config_path.display()))?;
    let persisted: PersistedDanmakuSource = serde_json::from_str(&raw)
        .with_context(|| format!("invalid json in {}", config_path.display()))?;

    if persisted.room_id.trim().is_empty()
        || persisted.buvid.trim().is_empty()
        || persisted.cookie.as_deref().map(str::trim).unwrap_or_default().is_empty()
    {
        return Ok(());
    }

    storage
        .upsert_danmaku_source_config(storage::NewDanmakuSourceConfigRecord {
            room_id: persisted.room_id,
            uid: persisted.uid,
            buvid: persisted.buvid,
            cookie: persisted.cookie,
            signature_mode: persisted.signature_mode,
            connection_mode: persisted.connection_mode,
        })
        .await?;

    Ok(())
}

fn spawn_danmaku_autostart(gateway: GatewayService, storage: Storage) {
    tokio::spawn(async move {
        let Ok(source) = storage.get_danmaku_source_config().await else {
            return;
        };
        let configured = !source.room_id.trim().is_empty()
            && !source.buvid.trim().is_empty()
            && source.has_cookie;
        if !configured {
            return;
        }

        let Ok(state) = storage.get_danmaku_connection_state().await else {
            return;
        };
        if state.status == "connected" || state.status == "connecting" {
            return;
        }

        let _ = if source.connection_mode == "native_websocket" {
            gateway.start_native_session().await
        } else {
            gateway.connect().await
        };
    });
}

#[derive(Debug, Deserialize)]
struct PersistedDanmakuSource {
    room_id: String,
    uid: u64,
    buvid: String,
    cookie: Option<String>,
    signature_mode: String,
    connection_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolManifestFile {
    id: String,
    name: String,
    version: String,
    runtime: String,
    entry: String,
    enabled_by_default: Option<bool>,
    confirmation_level: Option<String>,
    access_level: Option<String>,
    schemas: Option<Vec<ToolSchemaFile>>,
}

#[derive(Debug, Deserialize)]
struct ToolSchemaFile {
    name: String,
    description: Option<String>,
    input: Option<Value>,
}

fn load_tool_manifests() -> Result<Vec<ToolManifestRecord>> {
    let mut manifests = Vec::new();
    let root = tools_root();
    if !root.exists() {
        return Ok(manifests);
    }

    for entry in fs::read_dir(&root).with_context(|| format!("failed to read {}", root.display()))? {
        let entry = entry?;
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }

        let raw = fs::read_to_string(&manifest_path)
            .with_context(|| format!("failed to read {}", manifest_path.display()))?;
        let manifest: ToolManifestFile = serde_json::from_str(&raw)
            .with_context(|| format!("invalid tool manifest {}", manifest_path.display()))?;
        let schemas = manifest
            .schemas
            .unwrap_or_default()
            .into_iter()
            .map(|schema| ToolSchemaRecord {
                name: schema.name,
                description: schema.description,
                action_count: extract_schema_action_count(schema.input.as_ref()),
            })
            .collect::<Vec<_>>();

        let description = schemas.iter().find_map(|schema| schema.description.clone());
        manifests.push(ToolManifestRecord {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            runtime: manifest.runtime,
            entry: manifest.entry,
            enabled_by_default: manifest.enabled_by_default.unwrap_or(false),
            access_level: manifest.access_level.unwrap_or_else(|| "operator".into()),
            confirmation_level: manifest.confirmation_level,
            description,
            schema_count: schemas.len() as u32,
            schemas,
        });
    }

    manifests.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Ok(manifests)
}

fn extract_schema_action_count(input: Option<&Value>) -> u32 {
    input
        .and_then(|value| value.get("properties"))
        .and_then(|value| value.get("action"))
        .and_then(|value| value.get("enum"))
        .and_then(Value::as_array)
        .map(|values| values.len() as u32)
        .unwrap_or(0)
}
