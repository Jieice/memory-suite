use std::{collections::VecDeque, net::SocketAddr, sync::Arc};

use anyhow::{Context, Result};
use api_types::{
    ChatTimingRecord, RuntimeEvent, SceneContextRecord, SceneEventRecord, ToolExecutionResponse,
};
use app_config::{AppConfig, LlmConfig, SttConfig, TtsConfig, VisionConfig};
use gateway::GatewayService;
use media::{
    ChatResponseFinalizer, Live2dService, Live2dSpeechQueue, SessionTurnGuard, SttService,
    TtsService, VisionService,
};
use orchestrator::{Orchestrator, RuntimeBus};
use python_adapters::TtsAdapterSupervisor;
use storage::Storage;
use tokio::sync::{RwLock, watch};

use crate::ollama::OllamaHandle;
use crate::paths::{default_config_path, resolve_runtime_path};
use crate::workers::{spawn_clip_listener, spawn_danmaku_autostart};

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub storage: Storage,
    pub orchestrator: Orchestrator,
    pub runtime_bus: RuntimeBus,
    pub adapters: TtsAdapterSupervisor,
    pub tts: TtsService,
    pub stt: SttService,
    pub vision: VisionService,
    pub live2d: Live2dService,
    pub chat_response_finalizer: ChatResponseFinalizer,
    pub gateway: GatewayService,
    pub tool_executions: Arc<RwLock<VecDeque<ToolExecutionResponse>>>,
    pub live2d_speech_queue: Live2dSpeechQueue,
    pub session_turn_guard: SessionTurnGuard,
    pub last_chat_at: Arc<std::sync::Mutex<std::time::Instant>>,
    pub scene_events: Arc<RwLock<VecDeque<SceneEventRecord>>>,
    pub scene_context: Arc<RwLock<Option<SceneContextRecord>>>,
    pub clip_candidates: Arc<RwLock<VecDeque<RuntimeEvent>>>,
    pub audience: Arc<RwLock<std::collections::HashMap<String, (u32, String, std::time::Instant)>>>,
    pub session_topics: Arc<RwLock<VecDeque<String>>>,
    /// Danmaku buffer for batch processing (user_id, text, timestamp)
    pub danmaku_buffer: Arc<RwLock<Vec<(String, String, std::time::Instant)>>>,
    /// Session turn counter for energy level tracking
    pub session_turns: Arc<std::sync::atomic::AtomicU32>,
    /// Ring buffer of recent /api/chat stage timings (capped at 20)
    pub chat_latency_samples: Arc<RwLock<VecDeque<ChatTimingRecord>>>,
    /// Daemon shutdown signal used by the desktop shell "quit backend" action.
    pub shutdown_tx: watch::Sender<bool>,
    /// Lifecycle handle for a daemon-managed local Ollama server (no-op when the
    /// LLM endpoint is remote).
    pub ollama: OllamaHandle,
}

#[derive(Debug, Clone, Copy)]
pub struct AppStateOptions {
    pub spawn_danmaku_reconnect_worker: bool,
    pub autostart_danmaku: bool,
}

impl AppStateOptions {
    pub const fn isolated() -> Self {
        Self {
            spawn_danmaku_reconnect_worker: false,
            autostart_danmaku: false,
        }
    }
}

impl Default for AppStateOptions {
    fn default() -> Self {
        Self {
            spawn_danmaku_reconnect_worker: true,
            autostart_danmaku: true,
        }
    }
}

impl AppState {
    pub async fn from_config(config: AppConfig) -> Result<Self> {
        Self::from_config_with_options(config, AppStateOptions::default()).await
    }

    pub async fn from_config_with_options(
        config: AppConfig,
        options: AppStateOptions,
    ) -> Result<Self> {
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        Self::from_config_with_options_and_shutdown(config, options, shutdown_tx).await
    }

    pub async fn from_config_with_options_and_shutdown(
        config: AppConfig,
        options: AppStateOptions,
        shutdown_tx: watch::Sender<bool>,
    ) -> Result<Self> {
        apply_llm_environment(&config.llm);
        apply_tts_environment(&config.tts);
        apply_stt_environment(&config.stt);
        let database_path = resolve_runtime_path(&config.storage.database_path);
        let storage = Storage::connect(&database_path).await?;
        let runtime_bus = RuntimeBus::new();
        let orchestrator = Orchestrator::new(storage.clone(), runtime_bus.clone());
        let adapters = TtsAdapterSupervisor::new(
            storage.clone(),
            config.python.executable.clone(),
            resolve_runtime_path(&config.python.models_root),
            runtime_bus.clone(),
        );
        let tts = TtsService::new(
            storage.clone(),
            adapters.clone(),
            runtime_bus.clone(),
            config.features.enable_mock_tts,
            resolve_runtime_path(&config.storage.data_root).join("audio-cache"),
            config.tts.clone(),
        );
        let stt = SttService::new(adapters.clone(), config.stt.clone());
        let vision = VisionService::new(config.vision.clone());
        let live2d = Live2dService::new(storage.clone(), runtime_bus.clone());
        let session_turn_guard = SessionTurnGuard::new();
        let live2d_speech_queue =
            Live2dSpeechQueue::new(runtime_bus.clone(), session_turn_guard.clone());
        let chat_response_finalizer = ChatResponseFinalizer::new(
            tts.clone(),
            runtime_bus.clone(),
            live2d_speech_queue.clone(),
            session_turn_guard.clone(),
        );
        let gateway = GatewayService::new(
            storage.clone(),
            orchestrator.clone(),
            chat_response_finalizer.clone(),
            runtime_bus.clone(),
        );
        if options.spawn_danmaku_reconnect_worker {
            gateway.spawn_reconnect_worker();
        }
        reset_stale_danmaku_state_for_process_start(&storage).await?;
        if options.autostart_danmaku {
            spawn_danmaku_autostart(gateway.clone(), storage.clone()).await;
        }

        let last_chat_at = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
        let clip_candidates: Arc<RwLock<VecDeque<RuntimeEvent>>> =
            Arc::new(RwLock::new(VecDeque::with_capacity(50)));
        spawn_clip_listener(
            runtime_bus.clone(),
            clip_candidates.clone(),
            storage.clone(),
        );
        let stt_for_warmup = stt.clone();
        tokio::spawn(async move {
            if let Err(error) = stt_for_warmup.prewarm_current().await {
                tracing::warn!("failed to prewarm stt service on startup: {error}");
            }
        });

        // Manage a project-local Ollama server when the LLM endpoint points at
        // one. Startup (serve + model preload) can take seconds, so it runs
        // detached — the daemon boots immediately and the model warms in the
        // background. The handle is shared so `shutdown_runtime_services` can
        // stop it. No-op for remote/cloud endpoints.
        let ollama = OllamaHandle::disabled();
        let ollama_for_start = ollama.clone();
        let llm_for_ollama = config.llm.clone();
        tokio::spawn(async move {
            ollama_for_start.launch(&llm_for_ollama).await;
        });

        Ok(Self {
            config,
            storage,
            orchestrator,
            runtime_bus,
            adapters,
            tts,
            stt,
            vision,
            live2d,
            chat_response_finalizer,
            gateway,
            tool_executions: Arc::new(RwLock::new(VecDeque::with_capacity(64))),
            live2d_speech_queue,
            session_turn_guard,
            last_chat_at,
            scene_events: Arc::new(RwLock::new(VecDeque::with_capacity(32))),
            scene_context: Arc::new(RwLock::new(None)),
            clip_candidates,
            audience: Arc::new(RwLock::new(std::collections::HashMap::new())),
            session_topics: Arc::new(RwLock::new(VecDeque::with_capacity(20))),
            danmaku_buffer: Arc::new(RwLock::new(Vec::new())),
            session_turns: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            chat_latency_samples: Arc::new(RwLock::new(VecDeque::with_capacity(20))),
            ollama,
            shutdown_tx,
        })
    }

    pub fn listen_addr(&self) -> Result<SocketAddr> {
        format!("{}:{}", self.config.server.host, self.config.server.port)
            .parse()
            .context("invalid listen address")
    }

    pub fn apply_llm_runtime_config(&self, llm: &LlmConfig) {
        apply_llm_environment(llm);
        self.orchestrator.apply_llm_config(llm);
    }

    pub fn apply_tts_runtime_config(&self, tts: TtsConfig) {
        apply_tts_environment(&tts);
        self.tts.update_runtime_config(tts);
    }

    pub fn apply_stt_runtime_config(&self, stt: SttConfig) {
        apply_stt_environment(&stt);
        self.stt.update_runtime_config(stt);
        let stt_service = self.stt.clone();
        tokio::spawn(async move {
            if let Err(error) = stt_service.prewarm_current().await {
                tracing::warn!("failed to prewarm stt service after config update: {error}");
            }
        });
    }

    pub fn apply_vision_runtime_config(&self, vision: VisionConfig) {
        self.vision.update_runtime_config(vision);
    }

    pub async fn shutdown_runtime_services(&self) -> Result<()> {
        self.adapters.stop_all_running_adapters().await?;
        self.ollama.stop().await;
        Ok(())
    }
}

pub async fn bootstrap_state() -> Result<AppState> {
    let config_path = default_config_path();
    let config = AppConfig::load_from_file(&config_path)?;
    AppState::from_config(config).await
}

pub async fn bootstrap_state_with_shutdown(shutdown_tx: watch::Sender<bool>) -> Result<AppState> {
    let config_path = default_config_path();
    let config = AppConfig::load_from_file(&config_path)?;
    AppState::from_config_with_options_and_shutdown(config, AppStateOptions::default(), shutdown_tx)
        .await
}

fn apply_llm_environment(llm: &LlmConfig) {
    set_optional_env("MEMORY_SUITE_LLM_PROVIDER", llm.provider.as_deref());
    set_optional_env("MEMORY_SUITE_LLM_ENDPOINT", llm.endpoint.as_deref());
    set_optional_env("MEMORY_SUITE_LLM_MODEL", llm.model.as_deref());
    set_optional_env("MEMORY_SUITE_LLM_API_KEY", llm.api_key.as_deref());
    // system_prompt is intentionally NOT forwarded to env.
    // Persona canon (PERSONA_CANON.md) is now the single source for prompt construction.
    // Forwarding the old system_prompt from app.toml would override the canon.
    if let Some(timeout_ms) = llm.remote_timeout_ms {
        set_optional_env("MEMORY_SUITE_LLM_TIMEOUT_MS", Some(&timeout_ms.to_string()));
    } else {
        set_optional_env("MEMORY_SUITE_LLM_TIMEOUT_MS", None);
    }
    if let Some(fallback_ms) = llm.fallback_timeout_ms {
        set_optional_env(
            "MEMORY_SUITE_LLM_FALLBACK_TIMEOUT_MS",
            Some(&fallback_ms.to_string()),
        );
    } else {
        set_optional_env("MEMORY_SUITE_LLM_FALLBACK_TIMEOUT_MS", None);
    }
    set_optional_env("MEMORY_SUITE_LLM_TEMPERATURE", llm.temperature.as_deref());
    if let Some(max_tokens) = llm.max_tokens {
        set_optional_env("MEMORY_SUITE_LLM_MAX_TOKENS", Some(&max_tokens.to_string()));
    } else {
        set_optional_env("MEMORY_SUITE_LLM_MAX_TOKENS", None);
    }
    // Hybrid-router cloud tier. Forwarded so ChatEngine::from_env() can build the
    // optional cloud RemoteModelConfig. Absent → pure local, no behavior change.
    set_optional_env(
        "MEMORY_SUITE_LLM_CLOUD_ENDPOINT",
        llm.cloud_endpoint.as_deref(),
    );
    set_optional_env("MEMORY_SUITE_LLM_CLOUD_MODEL", llm.cloud_model.as_deref());
    set_optional_env(
        "MEMORY_SUITE_LLM_CLOUD_API_KEY",
        llm.cloud_api_key.as_deref(),
    );
    if let Some(cloud_max_tokens) = llm.cloud_max_tokens {
        set_optional_env(
            "MEMORY_SUITE_LLM_CLOUD_MAX_TOKENS",
            Some(&cloud_max_tokens.to_string()),
        );
    } else {
        set_optional_env("MEMORY_SUITE_LLM_CLOUD_MAX_TOKENS", None);
    }
}

fn apply_tts_environment(tts: &TtsConfig) {
    set_optional_env("MEMORY_SUITE_TTS_PROVIDER", tts.provider.as_deref());
    set_optional_env("MEMORY_SUITE_TTS_ENDPOINT", tts.endpoint.as_deref());
    set_optional_env("MEMORY_SUITE_TTS_HEALTH_PATH", tts.health_path.as_deref());
    set_optional_env("MEMORY_SUITE_TTS_CHAT_VOICE", tts.chat_voice.as_deref());
    set_optional_env("MEMORY_SUITE_TTS_RATE", tts.speech_rate.as_deref());
}

fn apply_stt_environment(stt: &SttConfig) {
    set_optional_env("MEMORY_SUITE_STT_PROVIDER", stt.provider.as_deref());
    set_optional_env("MEMORY_SUITE_STT_ENDPOINT", stt.endpoint.as_deref());
    set_optional_env("MEMORY_SUITE_STT_MODEL", stt.model.as_deref());
    set_optional_env("MEMORY_SUITE_STT_API_KEY", stt.api_key.as_deref());
    set_optional_env("MEMORY_SUITE_STT_LANGUAGE", stt.language.as_deref());
    set_optional_env("MEMORY_SUITE_STT_PROMPT", stt.prompt.as_deref());
    // Device/compute type steer the local faster-whisper worker onto GPU.
    // Absent → worker defaults (cpu/int8), so pure-CPU setups are unaffected.
    set_optional_env("MEMORY_SUITE_STT_DEVICE", stt.device.as_deref());
    set_optional_env("MEMORY_SUITE_STT_COMPUTE_TYPE", stt.compute_type.as_deref());
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
        })
        .await?;

    Ok(())
}
