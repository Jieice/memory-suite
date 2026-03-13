use std::{
    collections::VecDeque,
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use api_types::{
    AdapterStartRequest, ChatRequest, DanmakuDisconnectReportRequest, DanmakuHeartbeatRequest,
    DanmakuInjectRequest, DanmakuProtocolEventRequest, DanmakuSessionCloseRequest,
    DanmakuSessionErrorRequest, DanmakuSessionOpenRequest, DanmakuSourceUpdateRequest,
    HealthResponse, JobKind, JobRequest, KnowledgeCatalogResponse, Live2dConfigRequest,
    Live2dEmotionRequest, Live2dSpeechAckRequest, Live2dSpeechAckResponse, Live2dSpeechNextResponse,
    Live2dSpeechRecord, Live2dSubtitleRequest, PersonaRuntimeConfigUpdateRequest,
    PersonaRuntimeStateRecord, RuntimeEvent, RuntimeEventKind, RuntimeOverview,
    SceneContextRecord, SceneContextRequest, SceneEventRecord, SceneEventRequest,
    SceneSuggestionResponse, DiaryEntryRecord, DiaryListResponse, CharacterThoughtsResponse, ShortContentResponse,
    AudienceViewerRecord, AudienceStateRecord, HighlightReelResponse, ToolExecutionRequest, ToolExecutionResponse, ToolManifestRecord, ToolSchemaRecord,
    TtsSpeakRequest,
};
use app_config::{AppConfig, LlmConfig};
use axum::{
    Json, Router,
    extract::{Path as AxumPath, Query, State, WebSocketUpgrade, ws::Message},
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::{get, post},
};
use gateway::GatewayService;
use jobs::{JobService, PythonAdapterSupervisor};
use media::{ChatResponseFinalizer, Live2dService, TtsService};
use orchestrator::{Orchestrator, RuntimeBus};
use serde::Deserialize;
use serde_json::Value;
use storage::Storage;
use tokio::{
    process::Command,
    sync::RwLock,
    time::{Duration, Instant, timeout},
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
    pub chat_response_finalizer: ChatResponseFinalizer,
    pub gateway: GatewayService,
    pub tool_executions: Arc<RwLock<VecDeque<ToolExecutionResponse>>>,
    pub live2d_speech_queue: Arc<RwLock<VecDeque<Live2dSpeechRecord>>>,
    pub last_chat_at: Arc<std::sync::Mutex<std::time::Instant>>,
    pub scene_events: Arc<RwLock<VecDeque<SceneEventRecord>>>,
    pub scene_context: Arc<RwLock<Option<SceneContextRecord>>>,
    pub clip_candidates: Arc<RwLock<VecDeque<RuntimeEvent>>>,
    pub audience: Arc<RwLock<std::collections::HashMap<String, (u32, String, std::time::Instant)>>>,
    pub session_topics: Arc<RwLock<VecDeque<String>>>,
    /// Danmaku buffer for batch processing (user_id, text, timestamp)
    pub danmaku_buffer: Arc<RwLock<Vec<(String, String, std::time::Instant)>>>,
}

impl AppState {
    pub async fn from_config(config: AppConfig) -> Result<Self> {
        apply_llm_environment(&config.llm);
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
            config.tts.clone(),
        );
        let live2d = Live2dService::new(storage.clone(), runtime_bus.clone());
        let live2d_speech_queue = Arc::new(RwLock::new(VecDeque::with_capacity(64)));
        let chat_response_finalizer = ChatResponseFinalizer::new(
            live2d.clone(),
            tts.clone(),
            runtime_bus.clone(),
            live2d_speech_queue.clone(),
        );
        let gateway = GatewayService::new(
            storage.clone(),
            adapters.clone(),
            orchestrator.clone(),
            chat_response_finalizer.clone(),
            runtime_bus.clone(),
        );
        gateway.spawn_reconnect_worker();
        prime_danmaku_source_from_runtime_storage(&storage).await?;
        reset_stale_danmaku_state_for_process_start(&storage).await?;
        spawn_danmaku_autostart(gateway.clone(), storage.clone());

        let last_chat_at = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
        let clip_candidates: Arc<RwLock<VecDeque<RuntimeEvent>>> = Arc::new(RwLock::new(VecDeque::with_capacity(50)));
        spawn_idle_presence_worker(
            orchestrator.clone(),
            chat_response_finalizer.clone(),
            last_chat_at.clone(),
        );
        spawn_clip_listener(runtime_bus.clone(), clip_candidates.clone(), storage.clone());

        Ok(Self {
            config,
            storage,
            orchestrator,
            runtime_bus,
            jobs,
            adapters,
            tts,
            live2d,
            chat_response_finalizer,
            gateway,
            tool_executions: Arc::new(RwLock::new(VecDeque::with_capacity(64))),
            live2d_speech_queue,
            last_chat_at,
            scene_events: Arc::new(RwLock::new(VecDeque::with_capacity(32))),
            scene_context: Arc::new(RwLock::new(None)),
            clip_candidates,
            audience: Arc::new(RwLock::new(std::collections::HashMap::new())),
            session_topics: Arc::new(RwLock::new(VecDeque::with_capacity(20))),
            danmaku_buffer: Arc::new(RwLock::new(Vec::new())),
        })
    }

    pub fn listen_addr(&self) -> Result<SocketAddr> {
        format!("{}:{}", self.config.server.host, self.config.server.port)
            .parse()
            .context("invalid listen address")
    }

    /// Spawn background tasks that need full AppState access.
    pub fn spawn_background_tasks(self: &std::sync::Arc<Self>) {
        spawn_danmaku_batch_processor(self.clone());
    }
}

pub async fn bootstrap_state() -> Result<AppState> {
    let config_path = default_config_path();
    let config = AppConfig::load_from_file(&config_path)?;
    AppState::from_config(config).await
}

pub fn build_router(state: AppState) -> Router {
    let state_arc = Arc::new(state.clone());
    spawn_danmaku_batch_processor(state_arc);
    Router::new()
        .route("/api/health", get(health))
        .route("/api/chat", post(chat))
        .route("/api/runtime/overview", get(runtime_overview))
        .route("/api/knowledge/catalog", get(knowledge_catalog))
        .route("/api/tools/manifests", get(list_tool_manifests))
        .route("/api/tools/execute", post(execute_tool))
        .route("/api/tools/executions", get(list_tool_executions))
        .route("/api/runtime/adapters", get(list_adapters))
        .route(
            "/api/runtime/adapters/{adapter_id}/start",
            post(start_adapter),
        )
        .route("/api/jobs", get(list_jobs))
        .route(
            "/api/sessions/{session_id}/messages",
            get(list_session_messages),
        )
        .route("/api/tts/speak", post(tts_speak))
        .route("/api/audio/{request_id}", get(tts_audio_file))
        .route("/api/live2d/state", get(live2d_state))
        .route("/api/live2d/subtitle", post(live2d_subtitle))
        .route("/api/live2d/emotion", post(live2d_emotion))
        .route("/api/live2d/config", post(live2d_config))
        .route("/api/live2d/speech/next", get(next_live2d_speech))
        .route(
            "/api/live2d/speech/{speech_id}/ack",
            post(ack_live2d_speech),
        )
        .route(
            "/api/danmaku/source",
            get(danmaku_source).post(update_danmaku_source),
        )
        .route("/api/danmaku/state", get(danmaku_state))
        .route("/api/danmaku/bootstrap", post(bootstrap_danmaku))
        .route("/api/danmaku/native-probe", post(danmaku_native_probe))
        .route(
            "/api/danmaku/native-connect-once",
            post(danmaku_native_connect_once),
        )
        .route(
            "/api/danmaku/native-session/start",
            post(danmaku_native_session_start),
        )
        .route("/api/danmaku/connect", post(connect_danmaku))
        .route("/api/danmaku/disconnect", post(disconnect_danmaku))
        .route("/api/danmaku/heartbeat", post(danmaku_heartbeat))
        .route(
            "/api/danmaku/report-disconnect",
            post(danmaku_report_disconnect),
        )
        .route("/api/danmaku/session/open", post(danmaku_session_open))
        .route("/api/danmaku/session/error", post(danmaku_session_error))
        .route("/api/danmaku/session/close", post(danmaku_session_close))
        .route("/api/danmaku/protocol-event", post(danmaku_protocol_event))
        .route("/api/gateway/danmaku", post(gateway_danmaku))
        .route("/api/jobs/train", post(train_job))
        .route("/api/jobs/eval", post(eval_job))
        .route("/api/persona/state", get(persona_state))
        .route("/api/persona/config", post(persona_config))
        .route("/api/scene/event", post(scene_event))
        .route("/api/scene/context", post(scene_context))
        .route("/api/scene/context", get(get_scene_context))
        .route("/api/scene/suggest", get(scene_suggest))
        .route("/api/character/diary", get(get_character_diary))
        .route("/api/character/diary", post(generate_diary_entry))
        .route("/api/character/thoughts", get(get_character_thoughts))
        .route("/api/character/clips", get(get_character_clips))
        .route("/api/character/generate-short", post(generate_short_content))
        .route("/api/character/mood", get(get_character_mood))
        .route("/api/character/mood", post(set_character_mood))
        .route("/api/audience", get(get_audience_state))
        .route("/api/events/reaction", post(reaction_event))
        .route("/api/session/topics", get(get_session_topics))
        .route("/api/character/highlight-reel", post(generate_highlight_reel))
        .route("/ws/session/{session_id}", get(session_ws))
        .route("/ws/runtime", get(runtime_ws))
        .route("/ws/overlay", get(overlay_ws))
        .route("/overlay/live2d", get(live2d_overlay))
        .route("/overlay/danmaku", get(danmaku_overlay))
        .nest_service("/live2d-assets", ServeDir::new(live2d_assets_dir()))
        .nest_service("/overlay-vendor/pixi", ServeDir::new(pixi_vendor_dir()))
        .nest_service("/overlay-vendor/live2d", ServeDir::new(live2d_vendor_dir()))
        .nest_service(
            "/overlay-vendor/live2d-core",
            ServeDir::new(live2d_core_vendor_dir()),
        )
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
        workspace_root().join(candidate)
    }
}

fn apply_llm_environment(llm: &LlmConfig) {
    set_optional_env("MEMORY_SUITE_LLM_ENDPOINT", llm.endpoint.as_deref());
    set_optional_env("MEMORY_SUITE_LLM_MODEL", llm.model.as_deref());
    set_optional_env("MEMORY_SUITE_LLM_API_KEY", llm.api_key.as_deref());
    // system_prompt is intentionally NOT forwarded to env.
    // Persona canon (PERSONA_CANON.md) is now the single source for prompt construction.
    // Forwarding the old system_prompt from app.toml would override the canon.
    if let Some(timeout_ms) = llm.remote_timeout_ms {
        set_optional_env("MEMORY_SUITE_LLM_TIMEOUT_MS", Some(&timeout_ms.to_string()));
    }
    if let Some(fallback_ms) = llm.fallback_timeout_ms {
        set_optional_env("MEMORY_SUITE_LLM_FALLBACK_TIMEOUT_MS", Some(&fallback_ms.to_string()));
    }
}

fn set_optional_env(key: &str, value: Option<&str>) {
    // SAFETY: daemon bootstrap intentionally materializes resolved config into process env
    // so orchestrator keeps using its existing env-based remote model loader.
    unsafe {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
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

#[cfg(test)]
mod tests {
    use super::{resolve_runtime_path, workspace_root};

    #[test]
    fn resolves_relative_runtime_paths_from_workspace_root() {
        assert_eq!(
            resolve_runtime_path("./python"),
            workspace_root().join("./python")
        );
        assert_eq!(
            resolve_runtime_path("runtime/memory-suite.db"),
            workspace_root().join("runtime/memory-suite.db")
        );
    }
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

fn live2d_core_vendor_dir() -> PathBuf {
    workspace_root()
        .join("runtime")
        .join("overlay-vendor")
        .join("live2d-core")
}

async fn health(
    State(state): State<Arc<AppState>>,
) -> Result<Json<HealthResponse>, axum::http::StatusCode> {
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
    let request_preview = request.text.chars().take(60).collect::<String>();
    let chat_started = Instant::now();
    // Update idle presence timer
    if let Ok(mut t) = state.last_chat_at.lock() {
        *t = std::time::Instant::now();
    }
    let handle_started = Instant::now();
    // Build scene hint from current context and recent events
    let scene_hint = {
        let ctx = state.scene_context.read().await.clone();
        let events = state.scene_events.read().await;
        let mut parts = Vec::new();
        if let Some(ref c) = ctx {
            parts.push(format!("Screen: {}", c.description));
        }
        let recent: Vec<_> = events.iter().rev().take(3).collect();
        for e in recent.iter().rev() {
            let detail = e.detail.as_deref().unwrap_or("");
            parts.push(format!("Event[{}]: {}", e.kind, detail));
        }
        // Add active audience context
        {
            let audience = state.audience.read().await;
            let now = std::time::Instant::now();
            let active_count = audience.values().filter(|(_, _, last)| now.duration_since(*last).as_secs() < 300).count();
            if active_count > 0 {
                parts.push(format!("Active viewers in chat: {active_count}"));
                // Top 3 most active
                let mut top: Vec<_> = audience.iter()
                    .filter(|(_, (_, _, last))| now.duration_since(*last).as_secs() < 300)
                    .collect();
                top.sort_by(|a, b| b.1.0.cmp(&a.1.0));
                for (uid, (count, msg, _)) in top.iter().take(3) {
                    parts.push(format!("  {uid} ({count} msgs): \"{}\"", msg.chars().take(30).collect::<String>()));
                }
            }
        }
        if parts.is_empty() { None } else { Some(parts.join("\n")) }
    };
    let response = state
        .orchestrator
        .handle_chat_with_scene(request.clone(), scene_hint)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let handle_elapsed = handle_started.elapsed();

    // Optionally switch TTS voice based on current mood
    if let Ok(persona_state) = state.storage.get_persona_runtime_state().await {
        let canon_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../data/memories/global/PERSONA_CANON.md");
        if let Ok(src) = std::fs::read_to_string(&canon_path) {
            if let Ok(canon) = orchestrator::persona::PersonaCanon::parse(&src) {
                if let Some(voice) = canon.voice_for_mood(&persona_state.current_mood) {
                    // SAFETY: single-process daemon, no concurrent env mutation
                    unsafe { std::env::set_var("MEMORY_SUITE_TTS_CHAT_VOICE", &voice); }
                    tracing::debug!(mood = %persona_state.current_mood, voice = %voice, "switched TTS voice for mood");
                }
            }
        }
    }

    let finalize_started = Instant::now();
    let response = state
        .chat_response_finalizer
        .finalize(response)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let finalize_elapsed = finalize_started.elapsed();
    let total_elapsed = chat_started.elapsed();

    if total_elapsed >= Duration::from_millis(250) {
        tracing::warn!(
            session_id = %response.session_id,
            handle_chat_ms = handle_elapsed.as_millis(),
            finalize_ms = finalize_elapsed.as_millis(),
            total_ms = total_elapsed.as_millis(),
            text_preview = %request_preview,
            "slow /api/chat request"
        );
    }

    // Extract topic from user input and track it
    {
        let topic = extract_topic(&request_preview);
        if let Some(t) = topic {
            let mut topics = state.session_topics.write().await;
            // Avoid duplicates (case-insensitive prefix match)
            let already = topics.iter().any(|existing| existing.to_ascii_lowercase().contains(&t.to_ascii_lowercase()));
            if !already {
                if topics.len() >= 20 {
                    topics.pop_front();
                }
                topics.push_back(t);
            }
        }
    }

    Ok(Json(response))
}

async fn get_session_topics(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<String>> {
    let topics = state.session_topics.read().await;
    Json(topics.iter().cloned().collect())
}

fn extract_topic(text: &str) -> Option<String> {
    let trimmed = text.trim();
    // Skip slash commands and very short inputs
    if trimmed.starts_with('/') || trimmed.chars().count() < 3 {
        return None;
    }
    // Extract first 20 chars as topic hint
    let topic: String = trimmed.chars().take(20).collect();
    Some(topic)
}

fn publish_runtime_event(
    state: &Arc<AppState>,
    kind: RuntimeEventKind,
    source: String,
    detail: Option<String>,
) {
    state.runtime_bus.publish(RuntimeEvent {
        id: uuid::Uuid::new_v4(),
        kind,
        source,
        detail,
        created_at: chrono::Utc::now(),
    });
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
    let query = params
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let limit = params.limit.unwrap_or(24).clamp(1, 100);

    let (profiles, memory_entries, config_artifacts) = tokio::try_join!(
        state.storage.list_user_profiles(query, limit),
        state.storage.list_memory_entries(query, limit),
        state.storage.list_config_artifacts(query, limit.min(12)),
    )
    .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(KnowledgeCatalogResponse {
        query: query.map(ToOwned::to_owned),
        limit,
        profiles,
        memory_entries,
        config_artifacts,
    }))
}

async fn list_tool_manifests() -> Result<Json<Vec<ToolManifestRecord>>, axum::http::StatusCode> {
    let manifests =
        load_tool_manifests().map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(manifests))
}

#[derive(Debug, Deserialize)]
struct ToolExecutionHistoryParams {
    limit: Option<u32>,
}

async fn list_tool_executions(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ToolExecutionHistoryParams>,
) -> Result<Json<Vec<ToolExecutionResponse>>, axum::http::StatusCode> {
    let limit = params.limit.unwrap_or(20).clamp(1, 200) as usize;
    let history = state.tool_executions.read().await;
    let payload = history
        .iter()
        .rev()
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    Ok(Json(payload))
}

async fn execute_tool(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ToolExecutionRequest>,
) -> Result<Json<ToolExecutionResponse>, axum::http::StatusCode> {
    let response = run_tool_execution(request)
        .await
        .map_err(|error| match error {
            ToolExecutionError::NotFound => axum::http::StatusCode::NOT_FOUND,
            ToolExecutionError::UnsupportedRuntime => axum::http::StatusCode::BAD_REQUEST,
            ToolExecutionError::Internal => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        })?;
    push_tool_execution_history(&state, response.clone()).await;
    Ok(Json(response))
}

async fn push_tool_execution_history(state: &Arc<AppState>, response: ToolExecutionResponse) {
    const TOOL_EXECUTION_HISTORY_LIMIT: usize = 100;

    let mut history = state.tool_executions.write().await;
    if history.len() >= TOOL_EXECUTION_HISTORY_LIMIT {
        history.pop_front();
    }
    history.push_back(response);
}

#[derive(Debug, Clone, Copy)]
enum ToolExecutionError {
    NotFound,
    UnsupportedRuntime,
    Internal,
}

async fn run_tool_execution(
    request: ToolExecutionRequest,
) -> std::result::Result<ToolExecutionResponse, ToolExecutionError> {
    let loaded = load_tool_manifest_by_id(&request.tool_id)
        .map_err(|_| ToolExecutionError::Internal)?
        .ok_or(ToolExecutionError::NotFound)?;

    if loaded.manifest.runtime != "node" {
        return Err(ToolExecutionError::UnsupportedRuntime);
    }

    let entry_path = resolve_tool_entry_path(&loaded.tool_dir, &loaded.manifest.entry)
        .map_err(|_| ToolExecutionError::Internal)?;

    let execution_id = uuid::Uuid::new_v4().to_string();
    let args = request.args;
    let args_json = serde_json::to_string(&args).map_err(|_| ToolExecutionError::Internal)?;

    let timeout_ms = request
        .timeout_ms
        .or(loaded.manifest.timeout)
        .unwrap_or(30_000)
        .clamp(1, 120_000);

    let mut command = Command::new("node");
    command
        .arg(&entry_path)
        .arg(&args_json)
        .current_dir(&loaded.tool_dir)
        .env("TOOL_CALL_ID", &execution_id)
        .env("TOOL_ARGS_JSON", &args_json)
        .kill_on_drop(true);

    let started = Instant::now();
    let outcome = timeout(Duration::from_millis(timeout_ms), command.output()).await;
    let duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let executed_at = chrono::Utc::now();

    match outcome {
        Err(_) => Ok(ToolExecutionResponse {
            execution_id,
            tool_id: loaded.manifest.id,
            args,
            ok: false,
            status: "timeout".into(),
            exit_code: None,
            timed_out: true,
            duration_ms,
            output: None,
            stdout: None,
            stderr: None,
            error: Some(format!(
                "tool execution exceeded timeout budget ({timeout_ms}ms)"
            )),
            executed_at,
        }),
        Ok(Err(error)) => Ok(ToolExecutionResponse {
            execution_id,
            tool_id: loaded.manifest.id,
            args,
            ok: false,
            status: "failed".into(),
            exit_code: None,
            timed_out: false,
            duration_ms,
            output: None,
            stdout: None,
            stderr: None,
            error: Some(format!("failed to start tool process: {error}")),
            executed_at,
        }),
        Ok(Ok(output)) => {
            let stdout = normalize_stdio(&String::from_utf8_lossy(&output.stdout));
            let stderr = normalize_stdio(&String::from_utf8_lossy(&output.stderr));
            let parsed_output = parse_tool_output(stdout.as_deref());
            let exit_code = output.status.code();
            let ok = output.status.success();
            let status = if ok { "succeeded" } else { "failed" }.to_string();
            let error = if ok {
                None
            } else {
                parsed_output
                    .as_ref()
                    .and_then(|value| value.get("error"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| stderr.clone())
                    .or_else(|| {
                        Some(match exit_code {
                            Some(code) => format!("tool exited with non-zero status code {code}"),
                            None => "tool process terminated by signal".into(),
                        })
                    })
            };

            Ok(ToolExecutionResponse {
                execution_id,
                tool_id: loaded.manifest.id,
                args,
                ok,
                status,
                exit_code,
                timed_out: false,
                duration_ms,
                output: parsed_output,
                stdout,
                stderr,
                error,
                executed_at,
            })
        }
    }
}

fn resolve_tool_entry_path(tool_dir: &Path, entry: &str) -> Result<PathBuf> {
    let tool_dir_canonical = fs::canonicalize(tool_dir)
        .with_context(|| format!("invalid tool dir {}", tool_dir.display()))?;
    let entry_candidate = tool_dir.join(entry);
    let entry_canonical = fs::canonicalize(&entry_candidate)
        .with_context(|| format!("missing tool entry {}", entry_candidate.display()))?;

    if !entry_canonical.starts_with(&tool_dir_canonical) {
        anyhow::bail!(
            "tool entry escapes manifest directory: {}",
            entry_canonical.display()
        );
    }

    Ok(entry_candidate)
}

fn parse_tool_output(stdout: Option<&str>) -> Option<Value> {
    let stdout = stdout?.trim();
    if stdout.is_empty() {
        return None;
    }

    if let Ok(value) = serde_json::from_str::<Value>(stdout) {
        return Some(value);
    }

    stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
}

fn normalize_stdio(raw: &str) -> Option<String> {
    const MAX_STDIO_BYTES: usize = 16_384;

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.len() <= MAX_STDIO_BYTES {
        return Some(trimmed.to_string());
    }

    let mut split_index = 0;
    for (index, _) in trimmed.char_indices() {
        if index > MAX_STDIO_BYTES {
            break;
        }
        split_index = index;
    }

    Some(format!("{}...[truncated]", &trimmed[..split_index]))
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
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("unsupported adapter") {
                axum::http::StatusCode::BAD_REQUEST
            } else {
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            }
        })?;
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

async fn persona_state(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PersonaRuntimeStateRecord>, StatusCode> {
    state
        .storage
        .get_persona_runtime_state()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn persona_config(
    State(state): State<Arc<AppState>>,
    Json(request): Json<PersonaRuntimeConfigUpdateRequest>,
) -> Result<Json<PersonaRuntimeStateRecord>, StatusCode> {
    let current = state
        .storage
        .get_persona_runtime_state()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mode = request.mode.unwrap_or(current.mode);
    let tone_profile = request.tone_profile.unwrap_or(current.tone_profile);
    let warmth = request.warmth.unwrap_or(current.warmth);
    let sarcasm = request.sarcasm.unwrap_or(current.sarcasm);
    let autonomy = request.autonomy.unwrap_or(current.autonomy);
    let current_context = request.current_context.unwrap_or(current.current_context);
    let current_mood = request.current_mood.unwrap_or(current.current_mood);

    state
        .storage
        .upsert_persona_runtime_config(&mode, &tone_profile, warmth, sarcasm, autonomy, &current_context, &current_mood)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    state
        .storage
        .get_persona_runtime_state()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn scene_event(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SceneEventRequest>,
) -> Result<Json<SceneEventRecord>, StatusCode> {
    let record = SceneEventRecord {
        id: uuid::Uuid::new_v4().to_string(),
        kind: request.kind.clone(),
        detail: request.detail.clone(),
        created_at: chrono::Utc::now(),
    };

    {
        let mut events = state.scene_events.write().await;
        if events.len() >= 20 {
            events.pop_front();
        }
        events.push_back(record.clone());
    }

    publish_runtime_event(
        &state,
        RuntimeEventKind::MessageCreated,
        format!("scene:{}", request.kind),
        request.detail.clone(),
    );

    // Spawn autonomous scene commentary
    spawn_scene_commentary(state.clone(), record.clone());

    Ok(Json(record))
}

async fn scene_context(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SceneContextRequest>,
) -> Result<Json<SceneContextRecord>, StatusCode> {
    let record = SceneContextRecord {
        description: request.description,
        ttl_turns: request.ttl_turns.unwrap_or(5),
        updated_at: chrono::Utc::now(),
    };
    *state.scene_context.write().await = Some(record.clone());
    Ok(Json(record))
}

async fn get_scene_context(
    State(state): State<Arc<AppState>>,
) -> Json<Option<SceneContextRecord>> {
    Json(state.scene_context.read().await.clone())
}

async fn scene_suggest(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SceneSuggestionResponse>, StatusCode> {
    let ctx = state.scene_context.read().await.clone();
    let events = state.scene_events.read().await;
    let recent_events: Vec<_> = events.iter().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect();

    let mut hint_parts = Vec::new();
    if let Some(ref c) = ctx {
        hint_parts.push(format!("Current scene: {}", c.description));
    }
    for e in &recent_events {
        hint_parts.push(format!("Event: {} — {}", e.kind, e.detail.as_deref().unwrap_or("")));
    }
    let scene_hint = if hint_parts.is_empty() {
        None
    } else {
        Some(hint_parts.join("\n"))
    };

    let prompt = "根据当前场景和事件，用一句话建议接下来角色应该做什么或说什么。直接给出行动建议。".to_string();
    let request = ChatRequest {
        session_id: Some("scene-suggest".into()),
        user_id: Some("scene-system".into()),
        text: prompt,
    };

    let response = state
        .orchestrator
        .handle_chat_with_scene(request, scene_hint.clone())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(SceneSuggestionResponse {
        suggestion: response.assistant_text,
        scene_context: scene_hint,
    }))
}

async fn get_character_diary(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DiaryListResponse>, StatusCode> {
    let entries = state
        .storage
        .list_memory_entries(None, 10)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let diary_entries: Vec<DiaryEntryRecord> = entries
        .into_iter()
        .filter(|e| e.entry_type == "diary")
        .map(|e| {
            let content = e.payload
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            DiaryEntryRecord {
                id: e.id.to_string(),
                content,
                created_at: e.created_at,
            }
        })
        .collect();

    Ok(Json(DiaryListResponse { entries: diary_entries }))
}

async fn generate_diary_entry(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DiaryEntryRecord>, StatusCode> {
    // Get recent session summaries to base the diary on
    let memories = state
        .storage
        .list_memory_entries(None, 5)
        .await
        .unwrap_or_default();

    let summaries: Vec<String> = memories
        .iter()
        .filter(|e| e.entry_type == "session_summary")
        .take(3)
        .map(|e| {
            e.payload
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect();

    let context = if summaries.is_empty() {
        "今天的对话".to_string()
    } else {
        summaries.join(" | ")
    };

    let prompt = format!(
        "根据最近的对话记录，用第一人称写一条2-3句的角色日记。语气要符合忆的性格（敏锐、略有傲娇、直接）。不要用助手腔。参考内容：{}",
        context.chars().take(200).collect::<String>()
    );

    let request = ChatRequest {
        session_id: Some("diary-generation".into()),
        user_id: Some("system".into()),
        text: prompt,
    };

    let response = state
        .orchestrator
        .handle_chat_with_scene(request, None)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let content = response.assistant_text.clone();
    let now = chrono::Utc::now();

    // Store as memory entry
    let _ = state
        .storage
        .import_memory_entry(storage::NewMemoryEntryRecord {
            user_id: "character".into(),
            entry_type: "diary".into(),
            payload: serde_json::json!({ "content": content, "created_at": now.to_rfc3339() }),
            source: "auto_diary".into(),
        })
        .await;

    Ok(Json(DiaryEntryRecord {
        id: uuid::Uuid::new_v4().to_string(),
        content,
        created_at: now,
    }))
}

async fn get_character_thoughts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CharacterThoughtsResponse>, StatusCode> {
    // Gather recent diary entries and session summaries
    let memories = state
        .storage
        .list_memory_entries(None, 8)
        .await
        .unwrap_or_default();

    let diary_bits: Vec<String> = memories
        .iter()
        .filter(|e| e.entry_type == "diary")
        .take(2)
        .map(|e| e.payload.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string())
        .collect();

    let summary_bits: Vec<String> = memories
        .iter()
        .filter(|e| e.entry_type == "session_summary")
        .take(3)
        .map(|e| e.payload.get("summary").and_then(|v| v.as_str()).unwrap_or("").to_string())
        .collect();

    let context = [diary_bits, summary_bits].concat().join(" / ");
    let context_trimmed: String = context.chars().take(300).collect();

    let prompt = format!(
        "用第一人称写一段3-5句的角色内心独白或思考片段。语气是忆的风格：敏锐、不废话、偶尔带点自嘲。不要总结，要像在想事情。参考背景：{}",
        if context_trimmed.is_empty() { "最近发生了一些对话".to_string() } else { context_trimmed }
    );

    let request = ChatRequest {
        session_id: Some("character-thoughts".into()),
        user_id: Some("system".into()),
        text: prompt,
    };

    let response = state
        .orchestrator
        .handle_chat_with_scene(request, None)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(CharacterThoughtsResponse {
        thoughts: response.assistant_text,
        generated_at: chrono::Utc::now(),
    }))
}

async fn get_character_clips(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<RuntimeEvent>> {
    let clips = state.clip_candidates.read().await;
    Json(clips.iter().cloned().collect())
}

async fn generate_short_content(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ShortContentResponse>, StatusCode> {
    // Base on recent clips and diary for inspiration
    let clips: Vec<String> = {
        let q = state.clip_candidates.read().await;
        q.iter().rev().take(3)
            .filter_map(|e| e.detail.clone())
            .collect()
    };

    let memories = state.storage.list_memory_entries(None, 5).await.unwrap_or_default();
    let diary_bits: Vec<String> = memories.iter()
        .filter(|e| e.entry_type == "diary")
        .take(2)
        .map(|e| e.payload.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string())
        .collect();

    let inspiration: String = [clips, diary_bits].concat()
        .join(" / ")
        .chars().take(250).collect();

    let prompt = format!(
        "写一条2-3句的独立短内容，适合发布到社交媒体。风格是忆的语气：直接、有趣、不废话。可以是观察、吐槽、或者一个有趣的想法。不要用引号包裹。参考灵感（可以忽略）：{}",
        if inspiration.is_empty() { "随便想一个有趣的观察".to_string() } else { inspiration }
    );

    let request = ChatRequest {
        session_id: Some("short-content".into()),
        user_id: Some("system".into()),
        text: prompt,
    };

    let response = state.orchestrator
        .handle_chat_with_scene(request, None)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(ShortContentResponse {
        content: response.assistant_text,
        generated_at: chrono::Utc::now(),
    }))
}

async fn get_character_mood(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let s = state.storage.get_persona_runtime_state().await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "mood": s.current_mood })))
}

async fn set_character_mood(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let mood = body.get("mood").and_then(|v| v.as_str()).unwrap_or("neutral").to_string();
    let valid = ["neutral", "curious", "amused", "tired", "focused"];
    if !valid.contains(&mood.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let s = state.storage.get_persona_runtime_state().await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    state.storage.upsert_persona_runtime_config(
        &s.mode, &s.tone_profile, s.warmth, s.sarcasm, s.autonomy, &s.current_context, &mood,
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "mood": mood })))
}

async fn get_audience_state(
    State(state): State<Arc<AppState>>,
) -> Json<AudienceStateRecord> {
    let audience = state.audience.read().await;
    let now = std::time::Instant::now();
    // Only count viewers active in last 5 minutes
    let active: Vec<_> = audience.iter()
        .filter(|(_, (_, _, last))| now.duration_since(*last).as_secs() < 300)
        .collect();

    let mut top: Vec<_> = active.iter()
        .map(|(uid, (count, msg, last))| AudienceViewerRecord {
            user_id: (*uid).clone(),
            message_count: *count,
            last_message: msg.chars().take(40).collect(),
            last_seen: chrono::Utc::now() - chrono::Duration::seconds(
                now.duration_since(*last).as_secs() as i64
            ),
        })
        .collect();
    top.sort_by(|a, b| b.message_count.cmp(&a.message_count));
    top.truncate(10);

    Json(AudienceStateRecord {
        total_chatters: active.len() as u32,
        top_viewers: top,
    })
}

async fn reaction_event(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let reaction = body.get("kind").and_then(|v| v.as_str()).unwrap_or("heart").to_string();
    let source = body.get("source").and_then(|v| v.as_str()).unwrap_or("audience").to_string();

    let valid = ["laugh", "surprised", "heart", "clap", "wow"];
    if !valid.contains(&reaction.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let commentary = match reaction.as_str() {
        "laugh" => format!("观众笑了（{source}）。用一句话自然反应，可以得意也可以顺势说什么。"),
        "surprised" => format!("观众惊讶（{source}）。用一句话自然反应，可以追问或确认。"),
        "heart" => format!("观众发了爱心（{source}）。轻轻回应一下，不用太热情。"),
        "clap" => format!("观众鼓掌（{source}）。简短回应。"),
        _ => format!("观众反应：{reaction}（{source}）。用一句话自然回应。"),
    };

    spawn_scene_commentary(
        state.clone(),
        SceneEventRecord {
            id: uuid::Uuid::new_v4().to_string(),
            kind: format!("reaction:{reaction}"),
            detail: Some(commentary),
            created_at: chrono::Utc::now(),
        },
    );

    Ok(Json(serde_json::json!({ "ok": true, "kind": reaction })))
}

async fn generate_highlight_reel(
    State(state): State<Arc<AppState>>,
) -> Result<Json<HighlightReelResponse>, StatusCode> {
    let topics: Vec<String> = {
        let t = state.session_topics.read().await;
        t.iter().cloned().collect()
    };
    let clip_count = state.clip_candidates.read().await.len() as u32;
    let top_clips: Vec<String> = {
        let q = state.clip_candidates.read().await;
        q.iter().rev().take(3)
            .filter_map(|e| e.detail.clone())
            .collect()
    };

    let topics_str = if topics.is_empty() { "各种话题".to_string() } else { topics.iter().take(5).cloned().collect::<Vec<_>>().join("、") };
    let clips_str = if top_clips.is_empty() { String::new() } else {
        format!("精彩片段：{}", top_clips.iter().map(|c| c.chars().take(40).collect::<String>()).collect::<Vec<_>>().join(" / "))
    };

    let prompt = format!(
        "用忆的语气，写一段今天直播的精彩回顾（3-5句）。今天聊了：{}。{}\n格式：先给一个整体评价，再提1-2个具体亮点，最后一句收尾。",
        topics_str, clips_str
    );

    let request = ChatRequest {
        session_id: Some("highlight-reel".into()),
        user_id: Some("system".into()),
        text: prompt,
    };

    let response = state.orchestrator
        .handle_chat_with_scene(request, None)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(HighlightReelResponse {
        content: response.assistant_text,
        topics,
        clip_count,
        generated_at: chrono::Utc::now(),
    }))
}

fn spawn_clip_listener(
    runtime_bus: RuntimeBus,
    clip_candidates: Arc<RwLock<VecDeque<RuntimeEvent>>>,
    storage: Storage,
) {
    let mut rx = runtime_bus.subscribe();
    tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            if event.kind == RuntimeEventKind::ClipCandidate {
                {
                    let mut clips = clip_candidates.write().await;
                    if clips.len() >= 50 {
                        clips.pop_front();
                    }
                    clips.push_back(event.clone());
                }
                // Also store as memorable_moment memory entry for callback recall
                if let Some(ref detail) = event.detail {
                    if detail.len() > 20 {
                        let moment: String = detail.chars().take(120).collect();
                        let _ = storage.import_memory_entry(storage::NewMemoryEntryRecord {
                            user_id: "character".into(),
                            entry_type: "memorable_moment".into(),
                            payload: serde_json::json!({ "moment": moment, "source": event.source }),
                            source: "clip_detected".into(),
                        }).await;
                    }
                }
            }
        }
    });
}

async fn next_live2d_speech(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Live2dSpeechNextResponse>, axum::http::StatusCode> {
    let mut queue = state.live2d_speech_queue.write().await;
    if let Some(item) = queue
        .iter_mut()
        .find(|item| item.status == "pending" || item.status == "playing")
    {
        if item.status == "pending" {
            item.status = "playing".into();
            publish_runtime_event(
                &state,
                RuntimeEventKind::SpeechStarted,
                item.session_id.clone(),
                Some(item.id.clone()),
            );
        }
        return Ok(Json(Live2dSpeechNextResponse {
            item: Some(item.clone()),
        }));
    }

    Ok(Json(Live2dSpeechNextResponse { item: None }))
}

async fn ack_live2d_speech(
    AxumPath(speech_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<Live2dSpeechAckRequest>,
) -> Result<Json<Live2dSpeechAckResponse>, axum::http::StatusCode> {
    let mut queue = state.live2d_speech_queue.write().await;
    let Some(position) = queue.iter().position(|item| item.id == speech_id) else {
        return Err(axum::http::StatusCode::NOT_FOUND);
    };
    let updated_item = {
        let item = queue
            .get_mut(position)
            .expect("speech queue position verified above");

        match request.status.as_str() {
            "completed" => {
                item.status = "completed".into();
                publish_runtime_event(
                    &state,
                    RuntimeEventKind::SpeechCompleted,
                    item.session_id.clone(),
                    Some(item.id.clone()),
                );
            }
            _ => {
                item.status = "failed".into();
                if let Some(error) = request.error.clone() {
                    item.speech.error = Some(error);
                }
                publish_runtime_event(
                    &state,
                    RuntimeEventKind::SpeechFailed,
                    item.session_id.clone(),
                    item.speech.error.clone(),
                );
            }
        }

        item.clone()
    };

    while queue.len() > 256 {
        queue.pop_front();
    }

    Ok(Json(Live2dSpeechAckResponse {
        ok: true,
        item: Some(updated_item),
    }))
}

async fn tts_audio_file(
    AxumPath(request_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let parsed_id =
        uuid::Uuid::parse_str(&request_id).map_err(|_| axum::http::StatusCode::BAD_REQUEST)?;
    let record = state
        .storage
        .get_tts_request(parsed_id)
        .await
        .map_err(|_| axum::http::StatusCode::NOT_FOUND)?;
    let audio_path = record
        .audio_path
        .map(PathBuf::from)
        .ok_or(axum::http::StatusCode::NOT_FOUND)?;

    let data_root = resolve_runtime_path(&state.config.storage.data_root).join("audio-cache");
    let canonical_root =
        fs::canonicalize(&data_root).map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let canonical_audio =
        fs::canonicalize(&audio_path).map_err(|_| axum::http::StatusCode::NOT_FOUND)?;
    if !canonical_audio.starts_with(&canonical_root) {
        return Err(axum::http::StatusCode::FORBIDDEN);
    }

    let audio = tokio::fs::read(&canonical_audio)
        .await
        .map_err(|_| axum::http::StatusCode::NOT_FOUND)?;
    let content_type = mime_from_audio_extension(&canonical_audio);

    Ok(([(axum::http::header::CONTENT_TYPE, content_type)], audio))
}

fn mime_from_audio_extension(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("aac") => "audio/aac",
        Some("flac") => "audio/flac",
        _ => "audio/mpeg",
    }
}

async fn gateway_danmaku(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DanmakuInjectRequest>,
) -> Result<Json<api_types::ChatResponse>, axum::http::StatusCode> {
    // Track viewer in audience map
    {
        let mut audience = state.audience.write().await;
        let entry = audience.entry(request.user_id.clone()).or_insert((0, String::new(), std::time::Instant::now()));
        entry.0 += 1;
        entry.1 = request.text.chars().take(40).collect();
        entry.2 = std::time::Instant::now();
    }

    // Add to batch buffer instead of immediate LLM call
    {
        let mut buf = state.danmaku_buffer.write().await;
        buf.push((request.user_id.clone(), request.text.clone(), std::time::Instant::now()));
    }

    // Return a placeholder response (batch processor handles LLM call)
    Ok(Json(api_types::ChatResponse {
        session_id: format!("danmaku-{}", request.user_id),
        message_id: uuid::Uuid::new_v4(),
        assistant_text: String::new(),
        created_at: chrono::Utc::now(),
        speech: api_types::SpeechPlaybackPlan {
            request_id: uuid::Uuid::new_v4().to_string(),
            status: "buffered".into(),
            audio_url: None,
            duration_ms: 0,
            viseme_timeline: Vec::new(),
            error: None,
        },
        animation: api_types::Live2dAnimationPlan {
            emotion: "normal".into(),
            subtitle_text: String::new(),
            motion_timeline: Vec::new(),
        },
        events: Vec::new(),
    }))
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
        .start_native_session("manual_api")
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
                    | api_types::RuntimeEventKind::SpeechReady
                    | api_types::RuntimeEventKind::SpeechStarted
                    | api_types::RuntimeEventKind::SpeechCompleted
                    | api_types::RuntimeEventKind::SpeechFailed
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
        || persisted
            .cookie
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
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

async fn reset_stale_danmaku_state_for_process_start(storage: &Storage) -> Result<()> {
    let current = storage.get_danmaku_connection_state().await?;
    if current.status == "disconnected" {
        return Ok(());
    }

    storage
        .upsert_danmaku_connection_state(storage::NewDanmakuConnectionStateRecord {
            status: "disconnected".into(),
            attempt_count: current.attempt_count,
            consecutive_failures: current.consecutive_failures,
            retry_delay_ms: 0,
            session_id: None,
            current_upstream_host: current.current_upstream_host,
            last_connect_attempt_at: current.last_connect_attempt_at,
            last_heartbeat_at: current.last_heartbeat_at,
            next_retry_at: None,
            last_error: current
                .last_error
                .or_else(|| Some("recovered_after_daemon_restart".into())),
            last_close_reason: current.last_close_reason,
            adapter_id: current.adapter_id,
        })
        .await?;

    Ok(())
}

/// Spawn a background task that generates a short autonomous comment about a scene event.
/// Rate-limited: only fires if TTS queue is currently empty to avoid interrupting playback.
fn spawn_scene_commentary(state: Arc<AppState>, event: SceneEventRecord) {
    tokio::spawn(async move {
        // Small delay to let the event propagate
        tokio::time::sleep(Duration::from_millis(500)).await;

        // Don't interrupt if something is already playing
        {
            let queue = state.live2d_speech_queue.read().await;
            let has_active = queue.iter().any(|item| item.status == "pending" || item.status == "playing");
            if has_active {
                return;
            }
        }

        let detail = event.detail.as_deref().unwrap_or("");
        let commentary_text = format!("（场景事件：{} — {}）用一句话快速评论一下，不超过20字", event.kind, detail);
        let scene_hint = Some(format!("Scene event just happened: {} — {}", event.kind, detail));

        let request = ChatRequest {
            session_id: Some(format!("scene-commentary-{}", event.id)),
            user_id: Some("scene-system".into()),
            text: commentary_text,
        };

        match state.orchestrator.handle_chat_with_scene(request, scene_hint).await {
            Ok(response) => {
                tracing::info!(event_kind = %event.kind, speech_status = %response.speech.status, assistant_text = %response.assistant_text, "scene commentary generated");
                match state.chat_response_finalizer.finalize(response).await {
                    Ok(finalized) => {
                        tracing::info!(speech_status = %finalized.speech.status, audio_url = ?finalized.speech.audio_url, "scene commentary finalized");
                    }
                    Err(err) => {
                        tracing::warn!("scene commentary finalize failed: {err}");
                    }
                }
            }
            Err(err) => {
                tracing::warn!("scene commentary chat failed: {err}");
            }
        }
    });
}

/// Batch processor: collects danmaku every 3 seconds, picks best 1-2, calls LLM once.
fn spawn_danmaku_batch_processor(state: Arc<AppState>) {
    tokio::spawn(async move {
        let batch_window = Duration::from_secs(3);
        loop {
            tokio::time::sleep(batch_window).await;

            let batch: Vec<(String, String)> = {
                let mut buf = state.danmaku_buffer.write().await;
                if buf.is_empty() {
                    continue;
                }
                let items: Vec<_> = buf.drain(..)
                    .map(|(uid, text, _)| (uid, text))
                    .collect();
                items
            };

            if batch.is_empty() {
                continue;
            }

            // Skip trivial messages, prioritize questions and longer messages
            let interesting: Vec<_> = batch.iter()
                .filter(|(_, text)| text.chars().count() >= 3)
                .take(2)
                .collect();

            if interesting.is_empty() {
                continue;
            }

            // Don't interrupt active speech
            {
                let queue = state.live2d_speech_queue.read().await;
                if queue.iter().any(|item| item.status == "pending" || item.status == "playing") {
                    continue;
                }
            }

            // Build combined context
            let context_parts: Vec<String> = interesting.iter()
                .map(|(uid, text)| format!("{uid}: {text}"))
                .collect();
            let combined = context_parts.join(" / ");
            let prompt = format!("观众说：{}。选最有趣的一条自然回应，1-2句。", combined);
            let scene_hint = Some(format!("Batch of {} danmaku: {}", batch.len(), combined));

            let request = ChatRequest {
                session_id: Some("danmaku-batch".into()),
                user_id: Some("viewer".into()),
                text: prompt,
            };

            match state.orchestrator.handle_chat_with_scene(request, scene_hint).await {
                Ok(response) => {
                    if let Err(err) = state.chat_response_finalizer.finalize(response).await {
                        tracing::warn!("danmaku batch finalize failed: {err}");
                    } else {
                        tracing::debug!(batch_size = batch.len(), "danmaku batch processed");
                    }
                }
                Err(err) => {
                    tracing::warn!("danmaku batch chat failed: {err}");
                }
            }
        }
    });
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
        if state.status == "connected" {
            return;
        }

        let _ = if source.connection_mode == "native_websocket" {
            gateway.start_native_session("daemon_autostart").await
        } else {
            gateway.connect().await
        };
    });
}

fn spawn_idle_presence_worker(
    orchestrator: Orchestrator,
    finalizer: ChatResponseFinalizer,
    last_chat_at: Arc<std::sync::Mutex<std::time::Instant>>,
) {
    tokio::spawn(async move {
        let check_interval = Duration::from_secs(15);
        // Minimum silence before any idle trigger
        let min_idle = Duration::from_secs(60);
        // Track when we last fired idle so we don't spam
        let mut last_idle_at = std::time::Instant::now();
        let idle_cooldown = Duration::from_secs(90);

        loop {
            tokio::time::sleep(check_interval).await;

            let elapsed = last_chat_at
                .lock()
                .map(|t| t.elapsed())
                .unwrap_or(Duration::ZERO);

            if elapsed < min_idle {
                continue;
            }
            if last_idle_at.elapsed() < idle_cooldown {
                continue;
            }

            let canon_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../data/memories/global/PERSONA_CANON.md");
            let canon = std::fs::read_to_string(&canon_path)
                .ok()
                .and_then(|src| orchestrator::persona::PersonaCanon::parse(&src).ok())
                .unwrap_or_default();

            let seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(42) as usize;

            // Choose idle text based on how long silence has been
            let text = if elapsed > Duration::from_secs(900) {
                // 15+ minutes: offer to start something new
                format!("（沉默了很久）……要不要聊点什么？")
            } else if elapsed > Duration::from_secs(300) {
                // 5+ minutes: slightly more active idle
                if !canon.idle_presence.is_empty() {
                    canon.idle_presence[seed % canon.idle_presence.len()].clone()
                } else {
                    "嗯，刚才那个问题其实——".into()
                }
            } else {
                // 1-2 minutes: light presence
                if !canon.idle_presence.is_empty() {
                    let idx = (seed / 3) % canon.idle_presence.len();
                    canon.idle_presence[idx].clone()
                } else {
                    "还在的".into()
                }
            };

            let request = ChatRequest {
                session_id: Some("idle-presence".into()),
                user_id: None,
                text,
            };

            match orchestrator.handle_chat(request).await {
                Ok(response) => {
                    if let Err(err) = finalizer.finalize(response).await {
                        tracing::warn!("idle presence finalize failed: {err}");
                    } else {
                        tracing::debug!(idle_secs = elapsed.as_secs(), "idle presence emitted");
                        last_idle_at = std::time::Instant::now();
                        if let Ok(mut t) = last_chat_at.lock() {
                            *t = std::time::Instant::now();
                        }
                    }
                }
                Err(err) => {
                    tracing::warn!("idle presence chat failed: {err}");
                }
            }
        }
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

#[derive(Debug, Deserialize, Clone)]
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
    timeout: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
struct ToolSchemaFile {
    name: String,
    description: Option<String>,
    input: Option<Value>,
}

#[derive(Debug)]
struct LoadedToolManifest {
    tool_dir: PathBuf,
    manifest: ToolManifestFile,
}

fn load_tool_manifests() -> Result<Vec<ToolManifestRecord>> {
    let mut manifests = load_tool_manifest_files()?
        .into_iter()
        .map(|loaded| tool_manifest_record_from_file(&loaded.manifest))
        .collect::<Vec<_>>();
    manifests.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Ok(manifests)
}

fn load_tool_manifest_by_id(tool_id: &str) -> Result<Option<LoadedToolManifest>> {
    Ok(load_tool_manifest_files()?
        .into_iter()
        .find(|loaded| loaded.manifest.id == tool_id))
}

fn load_tool_manifest_files() -> Result<Vec<LoadedToolManifest>> {
    let mut manifests = Vec::new();
    let root = tools_root();
    if !root.exists() {
        return Ok(manifests);
    }

    for entry in
        fs::read_dir(&root).with_context(|| format!("failed to read {}", root.display()))?
    {
        let entry = entry?;
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }

        let raw = fs::read_to_string(&manifest_path)
            .with_context(|| format!("failed to read {}", manifest_path.display()))?;
        let manifest: ToolManifestFile = serde_json::from_str(&raw)
            .with_context(|| format!("invalid tool manifest {}", manifest_path.display()))?;
        manifests.push(LoadedToolManifest {
            tool_dir: entry.path(),
            manifest,
        });
    }

    Ok(manifests)
}

fn tool_manifest_record_from_file(manifest: &ToolManifestFile) -> ToolManifestRecord {
    let schemas = manifest
        .schemas
        .as_ref()
        .map(|schemas| {
            schemas
                .iter()
                .map(|schema| ToolSchemaRecord {
                    name: schema.name.clone(),
                    description: schema.description.clone(),
                    action_count: extract_schema_action_count(schema.input.as_ref()),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let description = schemas.iter().find_map(|schema| schema.description.clone());

    ToolManifestRecord {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        runtime: manifest.runtime.clone(),
        entry: manifest.entry.clone(),
        enabled_by_default: manifest.enabled_by_default.unwrap_or(false),
        access_level: manifest
            .access_level
            .clone()
            .unwrap_or_else(|| "operator".into()),
        confirmation_level: manifest.confirmation_level.clone(),
        description,
        schema_count: schemas.len() as u32,
        schemas,
    }
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
