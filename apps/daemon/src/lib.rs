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
    HealthResponse, ImportRequest, ImportSummary, JobKind, JobRequest, KnowledgeCatalogResponse,
    Live2dAnimationPlan, Live2dConfigRequest, Live2dEmotionRequest, Live2dSpeechAckRequest,
    Live2dSpeechAckResponse, Live2dSpeechNextResponse, Live2dSpeechRecord, Live2dSubtitleRequest,
    MotionCue, RuntimeEvent, RuntimeEventKind, RuntimeOverview, SpeechPlaybackPlan,
    ToolExecutionRequest, ToolExecutionResponse, ToolManifestRecord, ToolSchemaRecord,
    TtsSpeakRequest, VisemeCue,
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
    pub gateway: GatewayService,
    pub tool_executions: Arc<RwLock<VecDeque<ToolExecutionResponse>>>,
    pub live2d_speech_queue: Arc<RwLock<VecDeque<Live2dSpeechRecord>>>,
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
        reset_stale_danmaku_state_for_process_start(&storage).await?;
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
            tool_executions: Arc::new(RwLock::new(VecDeque::with_capacity(64))),
            live2d_speech_queue: Arc::new(RwLock::new(VecDeque::with_capacity(64))),
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
        .route("/api/import/legacy", post(import_legacy_endpoint))
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

fn live2d_core_vendor_dir() -> PathBuf {
    workspace_root()
        .join("runtime")
        .join("overlay-vendor")
        .join("live2d-core")
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
            let payload: Value =
                serde_json::from_str(line).context("invalid proactive-memory.jsonl line")?;
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

    let imports_root = PathBuf::from(&state.config.storage.data_root)
        .join("imports")
        .join("config");
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
    let mut response = state
        .orchestrator
        .handle_chat(request.clone())
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;

    let assistant_text = response.assistant_text.clone();
    let subtitle_duration_ms = estimate_subtitle_duration_ms(&assistant_text);
    let emotion = infer_emotion(&assistant_text);
    let now = chrono::Utc::now();

    if let Err(error) = state
        .live2d
        .set_subtitle(Live2dSubtitleRequest {
            text: assistant_text.clone(),
            duration_ms: subtitle_duration_ms,
        })
        .await
    {
        tracing::warn!("failed to auto-push subtitle from chat: {error}");
    }

    if let Err(error) = state
        .live2d
        .set_emotion(Live2dEmotionRequest {
            emotion: emotion.clone(),
        })
        .await
    {
        tracing::warn!("failed to auto-push emotion from chat: {error}");
    }

    let speech = match state
        .tts
        .enqueue(TtsSpeakRequest {
            session_id: Some(response.session_id.clone()),
            text: assistant_text.clone(),
            voice: Some(default_chat_voice()),
        })
        .await
    {
        Ok(tts_response) => {
            let duration_ms = estimate_speech_duration_ms(&assistant_text);
            let audio_url = tts_response
                .audio_path
                .as_ref()
                .map(|_| format!("/api/audio/{}", tts_response.request_id));
            let ready = tts_response.status == "completed" && audio_url.is_some();
            let status = if ready { "ready" } else { "failed" };
            let error = if ready {
                None
            } else {
                Some(format!(
                    "tts returned status={}, audio_path_present={}",
                    tts_response.status,
                    tts_response.audio_path.is_some()
                ))
            };
            SpeechPlaybackPlan {
                request_id: tts_response.request_id.to_string(),
                status: status.into(),
                audio_url,
                duration_ms,
                viseme_timeline: build_viseme_timeline(&assistant_text, duration_ms),
                error,
            }
        }
        Err(error) => {
            tracing::warn!("failed to auto-dispatch tts for chat reply: {error}");
            build_failed_speech_plan(
                uuid::Uuid::new_v4().to_string(),
                &assistant_text,
                Some(error.to_string()),
            )
        }
    };

    let animation = Live2dAnimationPlan {
        emotion: emotion.clone(),
        subtitle_text: assistant_text.clone(),
        motion_timeline: build_motion_timeline(&assistant_text, &emotion, speech.duration_ms),
    };
    response.speech = speech.clone();
    response.animation = animation.clone();

    if speech.status == "ready" {
        enqueue_live2d_speech(
            &state,
            Live2dSpeechRecord {
                id: speech.request_id.clone(),
                session_id: response.session_id.clone(),
                message_id: response.message_id,
                assistant_text,
                speech: speech.clone(),
                animation,
                status: "pending".into(),
                created_at: now,
            },
        )
        .await;
        publish_runtime_event(
            &state,
            RuntimeEventKind::SpeechQueued,
            response.session_id.clone(),
            Some(speech.request_id.clone()),
        );
        publish_runtime_event(
            &state,
            RuntimeEventKind::SpeechReady,
            response.session_id.clone(),
            Some(speech.request_id.clone()),
        );
    } else {
        publish_runtime_event(
            &state,
            RuntimeEventKind::SpeechFailed,
            response.session_id.clone(),
            speech.error.clone(),
        );
    }

    Ok(Json(response))
}

async fn enqueue_live2d_speech(state: &Arc<AppState>, item: Live2dSpeechRecord) {
    const MAX_LIVE2D_SPEECH_QUEUE: usize = 256;

    let mut queue = state.live2d_speech_queue.write().await;
    if queue.len() >= MAX_LIVE2D_SPEECH_QUEUE {
        queue.pop_front();
    }
    queue.push_back(item);
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

fn default_chat_voice() -> String {
    std::env::var("MEMORY_SUITE_CHAT_TTS_VOICE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "edge-tts-zh".into())
}

fn estimate_subtitle_duration_ms(text: &str) -> u64 {
    estimate_speech_duration_ms(text).saturating_add(600)
}

fn estimate_speech_duration_ms(text: &str) -> u64 {
    let chars = text.chars().filter(|ch| !ch.is_whitespace()).count() as u64;
    let punctuation = text.chars().filter(|ch| is_pause_punctuation(*ch)).count() as u64;
    (chars.saturating_mul(95) + punctuation.saturating_mul(220)).clamp(900, 14_000)
}
fn build_failed_speech_plan(
    request_id: String,
    text: &str,
    error: Option<String>,
) -> SpeechPlaybackPlan {
    let duration_ms = estimate_speech_duration_ms(text);
    SpeechPlaybackPlan {
        request_id,
        status: "failed".into(),
        audio_url: None,
        duration_ms,
        viseme_timeline: build_viseme_timeline(text, duration_ms),
        error: error.or_else(|| Some("tts dispatch unavailable".into())),
    }
}

fn infer_emotion(text: &str) -> String {
    let lowered = text.to_ascii_lowercase();
    if lowered.contains("angry") || lowered.contains("mad") {
        "angry".into()
    } else if lowered.contains("sad") || lowered.contains("sorry") {
        "sad".into()
    } else if lowered.contains("wow")
        || lowered.contains("really")
        || text.contains('?')
        || text.contains('\u{ff1f}')
    {
        "surprised".into()
    } else if lowered.contains("great")
        || lowered.contains("nice")
        || lowered.contains("awesome")
        || text.contains('!')
        || text.contains('\u{ff01}')
    {
        "happy".into()
    } else {
        "normal".into()
    }
}
fn build_viseme_timeline(text: &str, duration_ms: u64) -> Vec<VisemeCue> {
    let units = text
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<Vec<_>>();
    if units.is_empty() {
        return vec![VisemeCue {
            start_ms: 0,
            end_ms: duration_ms,
            viseme: "rest".into(),
            mouth_open: 0.0,
        }];
    }

    let slot = (duration_ms / units.len() as u64).max(70);
    let mut cues = Vec::with_capacity(units.len() + 1);
    let mut cursor = 0u64;
    for (index, ch) in units.iter().enumerate() {
        let (viseme, mouth_open) = viseme_for_char(*ch, index);
        let end_ms = if index == units.len() - 1 {
            duration_ms
        } else {
            cursor.saturating_add(slot).min(duration_ms)
        };
        cues.push(VisemeCue {
            start_ms: cursor,
            end_ms,
            viseme: viseme.into(),
            mouth_open,
        });
        cursor = end_ms;
    }

    cues.push(VisemeCue {
        start_ms: duration_ms.saturating_sub(180),
        end_ms: duration_ms,
        viseme: "rest".into(),
        mouth_open: 0.0,
    });
    cues
}

fn viseme_for_char(ch: char, index: usize) -> (&'static str, f32) {
    let lower = ch.to_ascii_lowercase();
    match lower {
        'a' => ("A", 0.85),
        'e' => ("E", 0.68),
        'i' => ("I", 0.58),
        'o' => ("O", 0.76),
        'u' => ("U", 0.64),
        _ => match index % 5 {
            0 => ("A", 0.7),
            1 => ("E", 0.55),
            2 => ("I", 0.48),
            3 => ("O", 0.62),
            _ => ("U", 0.52),
        },
    }
}

fn build_motion_timeline(text: &str, emotion: &str, duration_ms: u64) -> Vec<MotionCue> {
    let mut cues = vec![MotionCue {
        at_ms: 0,
        duration_ms,
        motion: "Idle".into(),
    }];

    let mut last_trigger = 0u64;
    let cooldown_ms = 1_600u64;
    let mut cursor = 0u64;
    let unit = (duration_ms / text.chars().count().max(1) as u64).max(45);
    for ch in text.chars() {
        cursor = cursor.saturating_add(unit);
        if !is_sentence_boundary(ch) {
            continue;
        }
        if cursor.saturating_sub(last_trigger) < cooldown_ms {
            continue;
        }
        let motion = match emotion {
            "angry" => "Flick",
            "surprised" => "FlickUp",
            "sad" => "FlickDown",
            _ => "Tap",
        };
        cues.push(MotionCue {
            at_ms: cursor.min(duration_ms),
            duration_ms: 900,
            motion: motion.into(),
        });
        last_trigger = cursor;
        if cues.len() >= 4 {
            break;
        }
    }
    cues
}

fn is_pause_punctuation(ch: char) -> bool {
    matches!(
        ch,
        '.' | ','
            | '!'
            | '?'
            | ';'
            | ':'
            | '\u{3002}'
            | '\u{ff0c}'
            | '\u{ff01}'
            | '\u{ff1f}'
            | '\u{ff1b}'
            | '\u{3001}'
    )
}

fn is_sentence_boundary(ch: char) -> bool {
    matches!(
        ch,
        '.' | '!' | '?' | ';' | '\u{3002}' | '\u{ff01}' | '\u{ff1f}' | '\u{ff1b}'
    )
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
    let query = params
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
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
