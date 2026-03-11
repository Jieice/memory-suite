use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use serde_json::{Map, Value};

use anyhow::Result;
use app_config::TtsConfig;
use api_types::{
    AdapterStartRequest, ChatResponse, Live2dAnimationPlan, Live2dConfigRequest,
    Live2dEmotionRequest, Live2dSpeechRecord, Live2dStateRecord, Live2dSubtitleRequest, MotionCue,
    RuntimeEvent, RuntimeEventKind, SpeechPlaybackPlan, TtsSpeakRequest, TtsSpeakResponse,
    VisemeCue,
};
use chrono::Utc;
use jobs::PythonAdapterSupervisor;
use orchestrator::RuntimeBus;
use storage::{NewLive2dConfigRecord, NewLive2dStateRecord, NewTtsRecord, Storage};
use tokio::{fs, sync::{Mutex, RwLock}, time::sleep};
use uuid::Uuid;

#[derive(Clone)]
pub struct TtsService {
    storage: Storage,
    adapters: PythonAdapterSupervisor,
    runtime_bus: RuntimeBus,
    enable_mock_tts: bool,
    audio_cache_dir: PathBuf,
    config: TtsConfig,
}

#[derive(Clone)]
pub struct Live2dService {
    storage: Storage,
    runtime_bus: RuntimeBus,
}

#[derive(Clone)]
pub struct ChatResponseFinalizer {
    live2d: Live2dService,
    tts: TtsService,
    runtime_bus: RuntimeBus,
    live2d_speech_queue: Arc<RwLock<VecDeque<Live2dSpeechRecord>>>,
}

impl ChatResponseFinalizer {
    pub fn new(
        live2d: Live2dService,
        tts: TtsService,
        runtime_bus: RuntimeBus,
        live2d_speech_queue: Arc<RwLock<VecDeque<Live2dSpeechRecord>>>,
    ) -> Self {
        Self {
            live2d,
            tts,
            runtime_bus,
            live2d_speech_queue,
        }
    }

    pub async fn finalize(&self, mut response: ChatResponse) -> Result<ChatResponse> {
        let assistant_text = response.assistant_text.clone();
        let subtitle_duration_ms = estimate_subtitle_duration_ms(&assistant_text);
        let emotion = infer_emotion(&assistant_text);

        if should_enqueue_tts_in_background(&assistant_text) {
            let speech = build_background_dispatch_speech_plan(response.message_id, &assistant_text);
            let animation = Live2dAnimationPlan {
                emotion: emotion.clone(),
                subtitle_text: assistant_text.clone(),
                motion_timeline: build_motion_timeline(&assistant_text, &emotion, speech.duration_ms),
            };
            response.speech = speech;
            response.animation = animation;

            self.spawn_background_finalize(
                response.session_id.clone(),
                response.message_id,
                assistant_text,
                emotion,
                subtitle_duration_ms,
            );
            return Ok(response);
        }

        self.apply_live2d_updates(&assistant_text, &emotion, subtitle_duration_ms)
            .await;

        let speech = self
            .dispatch_speech_plan(response.message_id, response.session_id.clone(), &assistant_text)
            .await;
        let animation = Live2dAnimationPlan {
            emotion: emotion.clone(),
            subtitle_text: assistant_text.clone(),
            motion_timeline: build_motion_timeline(&assistant_text, &emotion, speech.duration_ms),
        };
        response.speech = speech.clone();
        response.animation = animation.clone();

        self.apply_speech_result(
            response.session_id.clone(),
            response.message_id,
            assistant_text,
            speech,
            animation,
        )
        .await;

        Ok(response)
    }

    fn spawn_background_finalize(
        &self,
        session_id: String,
        message_id: Uuid,
        assistant_text: String,
        emotion: String,
        subtitle_duration_ms: u64,
    ) {
        let finalizer = self.clone();
        tokio::spawn(async move {
            finalizer
                .apply_live2d_updates(&assistant_text, &emotion, subtitle_duration_ms)
                .await;
            let speech = finalizer
                .dispatch_speech_plan(message_id, session_id.clone(), &assistant_text)
                .await;
            let animation = Live2dAnimationPlan {
                emotion: emotion.clone(),
                subtitle_text: assistant_text.clone(),
                motion_timeline: build_motion_timeline(&assistant_text, &emotion, speech.duration_ms),
            };
            finalizer
                .apply_speech_result(session_id, message_id, assistant_text, speech, animation)
                .await;
        });
    }

    async fn apply_live2d_updates(&self, assistant_text: &str, emotion: &str, subtitle_duration_ms: u64) {
        if let Err(error) = self
            .live2d
            .set_subtitle(Live2dSubtitleRequest {
                text: assistant_text.to_string(),
                duration_ms: subtitle_duration_ms,
            })
            .await
        {
            tracing::warn!("failed to auto-push subtitle from chat: {error}");
        }

        if let Err(error) = self
            .live2d
            .set_emotion(Live2dEmotionRequest {
                emotion: emotion.to_string(),
            })
            .await
        {
            tracing::warn!("failed to auto-push emotion from chat: {error}");
        }
    }

    async fn dispatch_speech_plan(
        &self,
        fallback_message_id: Uuid,
        session_id: String,
        assistant_text: &str,
    ) -> SpeechPlaybackPlan {
        match self
            .tts
            .enqueue(TtsSpeakRequest {
                session_id: Some(session_id),
                text: assistant_text.to_string(),
                voice: Some(self.tts.default_chat_voice()),
            })
            .await
        {
            Ok(tts_response) => build_speech_plan_from_tts_response(tts_response, assistant_text),
            Err(error) => {
                tracing::warn!("failed to auto-dispatch tts for chat reply: {error}");
                build_failed_speech_plan(
                    fallback_message_id.to_string(),
                    assistant_text,
                    Some(error.to_string()),
                )
            }
        }
    }

    async fn apply_speech_result(
        &self,
        session_id: String,
        message_id: Uuid,
        assistant_text: String,
        speech: SpeechPlaybackPlan,
        animation: Live2dAnimationPlan,
    ) {
        if speech.status == "ready" {
            self.enqueue_live2d_speech(Live2dSpeechRecord {
                id: speech.request_id.clone(),
                session_id: session_id.clone(),
                message_id,
                assistant_text,
                speech: speech.clone(),
                animation,
                status: "pending".into(),
                created_at: Utc::now(),
            })
            .await;
            self.publish_runtime_event(
                RuntimeEventKind::SpeechQueued,
                session_id.clone(),
                Some(speech.request_id.clone()),
            );
            self.publish_runtime_event(
                RuntimeEventKind::SpeechReady,
                session_id,
                Some(speech.request_id.clone()),
            );
        } else {
            self.publish_runtime_event(RuntimeEventKind::SpeechFailed, session_id, speech.error.clone());
        }
    }

    async fn enqueue_live2d_speech(&self, item: Live2dSpeechRecord) {
        const MAX_LIVE2D_SPEECH_QUEUE: usize = 256;

        let mut queue = self.live2d_speech_queue.write().await;
        if queue.len() >= MAX_LIVE2D_SPEECH_QUEUE {
            queue.pop_front();
        }
        queue.push_back(item);
    }

    fn publish_runtime_event(&self, kind: RuntimeEventKind, source: String, detail: Option<String>) {
        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind,
            source,
            detail,
            created_at: Utc::now(),
        });
    }
}

impl Live2dService {
    pub fn new(storage: Storage, runtime_bus: RuntimeBus) -> Self {
        Self {
            storage,
            runtime_bus,
        }
    }

    pub async fn get_state(&self) -> Result<Live2dStateRecord> {
        self.storage.get_live2d_state().await
    }

    pub async fn set_subtitle(&self, request: Live2dSubtitleRequest) -> Result<Live2dStateRecord> {
        let current = self.storage.get_live2d_state().await?;
        let record = self
            .storage
            .upsert_live2d_state(NewLive2dStateRecord {
                subtitle: request.text,
                subtitle_duration_ms: request.duration_ms,
                emotion: current.emotion,
            })
            .await?;
        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::Live2dSubtitleUpdated,
            source: "live2d".into(),
            detail: Some(record.subtitle.clone()),
            created_at: record.updated_at,
        });
        Ok(record)
    }

    pub async fn set_emotion(&self, request: Live2dEmotionRequest) -> Result<Live2dStateRecord> {
        let current = self.storage.get_live2d_state().await?;
        let record = self
            .storage
            .upsert_live2d_state(NewLive2dStateRecord {
                subtitle: current.subtitle,
                subtitle_duration_ms: current.subtitle_duration_ms,
                emotion: request.emotion,
            })
            .await?;
        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::Live2dEmotionUpdated,
            source: "live2d".into(),
            detail: Some(record.emotion.clone()),
            created_at: record.updated_at,
        });
        Ok(record)
    }

    pub async fn set_config(&self, request: Live2dConfigRequest) -> Result<Live2dStateRecord> {
        self.storage
            .upsert_live2d_config(NewLive2dConfigRecord {
                scale: request.scale,
                x: request.x,
                y: request.y,
            })
            .await?;
        let record = self.storage.get_live2d_state().await?;
        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::Live2dConfigUpdated,
            source: "live2d".into(),
            detail: Some(format!(
                "scale={},x={},y={}",
                record.config.scale, record.config.x, record.config.y
            )),
            created_at: record.updated_at,
        });
        Ok(record)
    }
}

impl TtsService {
    pub fn new(
        storage: Storage,
        adapters: PythonAdapterSupervisor,
        runtime_bus: RuntimeBus,
        enable_mock_tts: bool,
        audio_cache_dir: PathBuf,
        config: TtsConfig,
    ) -> Self {
        Self {
            storage,
            adapters,
            runtime_bus,
            enable_mock_tts,
            audio_cache_dir,
            config,
        }
    }

    pub fn default_chat_voice(&self) -> String {
        self.config
            .chat_voice
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "edge-tts-zh".into())
    }

    pub async fn enqueue(&self, request: TtsSpeakRequest) -> Result<TtsSpeakResponse> {
        let session_id = request
            .session_id
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let text = request.text.clone();
        let adapter_id = select_tts_adapter(&self.config);
        let record = self
            .storage
            .enqueue_tts(NewTtsRecord {
                session_id,
                text,
                voice: request.voice,
            })
            .await?;

        match self
            .adapters
            .start_adapter(adapter_id, AdapterStartRequest { args: Vec::new() })
            .await
        {
            Ok(_) => {
                let _ = self
                    .storage
                    .update_tts_dispatch(record.id, "dispatching", Some(adapter_id))
                    .await?;
                let completed = match self
                    .dispatch_to_python_worker(
                        record.id,
                        adapter_id,
                        &record.text,
                        record.voice.as_deref(),
                    )
                    .await
                {
                    Ok(completed) => completed,
                    Err(error) if self.enable_mock_tts => {
                        return self.mock_response(record.id, adapter_id, error).await;
                    }
                    Err(error) => return Err(error),
                };
                self.runtime_bus.publish(RuntimeEvent {
                    id: Uuid::new_v4(),
                    kind: RuntimeEventKind::TtsQueued,
                    source: adapter_id.to_string(),
                    detail: completed.audio_path.clone(),
                    created_at: completed.created_at,
                });
                return Ok(TtsSpeakResponse {
                    request_id: completed.id,
                    status: completed.status,
                    audio_path: completed.audio_path,
                    created_at: completed.created_at,
                });
            }
            Err(error) if self.enable_mock_tts => {
                return self.mock_response(record.id, adapter_id, error).await;
            }
            Err(error) => return Err(error),
        }
    }

    async fn mock_response(
        &self,
        request_id: Uuid,
        adapter_id: &str,
        error: anyhow::Error,
    ) -> Result<TtsSpeakResponse> {
        let mocked = self
            .storage
            .update_tts_dispatch(request_id, "mocked", Some(adapter_id))
            .await?;
        tracing::warn!("falling back to mock tts dispatch: {error}");
        Ok(TtsSpeakResponse {
            request_id: mocked.id,
            status: mocked.status,
            audio_path: mocked.audio_path,
            created_at: mocked.created_at,
        })
    }

    async fn dispatch_to_python_worker(
        &self,
        request_id: Uuid,
        adapter_id: &str,
        text: &str,
        voice: Option<&str>,
    ) -> Result<api_types::TtsRequestRecord> {
        let endpoint = tts_endpoint(&self.config, adapter_id);
        wait_for_tts_worker(&endpoint, tts_health_path(&self.config, adapter_id)).await?;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()?;
        let response = client
            .post(format!("{endpoint}/tts"))
            .json(&build_tts_request_payload(&self.config, adapter_id, text, voice))
            .send()
            .await?
            .error_for_status()?;

        let extension = audio_extension(response.headers().get(reqwest::header::CONTENT_TYPE));
        let audio = response.bytes().await?;
        fs::create_dir_all(&self.audio_cache_dir).await?;
        let audio_path = self
            .audio_cache_dir
            .join(format!("{request_id}.{extension}"));
        fs::write(&audio_path, &audio).await?;

        self.storage
            .update_tts_result(
                request_id,
                "completed",
                Some(adapter_id),
                Some(&audio_path.to_string_lossy()),
            )
            .await
    }
}

fn should_enqueue_tts_in_background(text: &str) -> bool {
    let trimmed = text.trim();
    let lowered = trimmed.to_ascii_lowercase();
    lowered.starts_with("runtime ok:")
        || lowered == "runtime status is temporarily unavailable, please retry in a moment."
        || lowered.starts_with("commands: /status, /memory, /help.")
        || lowered == "no imported memory was found for this user yet."
        || lowered == "i received an empty message. please send a specific task or question."
        || lowered.starts_with("memory snapshot:")
        || (trimmed.contains("acknowledged:") && trimmed.contains("Next step:"))
        || (trimmed.contains(", for \"") && trimmed.contains(": 1) define the exact outcome"))
}

fn build_background_dispatch_speech_plan(request_id: Uuid, text: &str) -> SpeechPlaybackPlan {
    let duration_ms = estimate_speech_duration_ms(text);
    SpeechPlaybackPlan {
        request_id: request_id.to_string(),
        status: "dispatching".into(),
        audio_url: None,
        duration_ms,
        viseme_timeline: build_viseme_timeline(text, duration_ms),
        error: None,
    }
}

fn build_speech_plan_from_tts_response(
    tts_response: TtsSpeakResponse,
    assistant_text: &str,
) -> SpeechPlaybackPlan {
    let duration_ms = estimate_speech_duration_ms(assistant_text);
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
        viseme_timeline: build_viseme_timeline(assistant_text, duration_ms),
        error,
    }
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

fn audio_extension(content_type: Option<&reqwest::header::HeaderValue>) -> &'static str {
    let Some(content_type) = content_type.and_then(|value| value.to_str().ok()) else {
        return "mp3";
    };
    let mime = content_type.to_ascii_lowercase();
    if mime.contains("audio/wav") || mime.contains("audio/x-wav") || mime.contains("audio/wave") {
        "wav"
    } else {
        "mp3"
    }
}

fn select_tts_adapter(config: &TtsConfig) -> &'static str {
    match config
        .provider
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .as_deref()
    {
        Some("sovits") => "sovits",
        _ => "edge_tts",
    }
}

fn tts_endpoint(config: &TtsConfig, adapter_id: &str) -> String {
    if let Some(endpoint) = config.endpoint.as_ref().filter(|value| !value.trim().is_empty()) {
        return endpoint.trim().trim_end_matches('/').to_string();
    }

    match adapter_id {
        "sovits" => format!(
            "http://127.0.0.1:{}",
            std::env::var("GENIE_PORT").unwrap_or_else(|_| "9880".into())
        ),
        _ => format!(
            "http://127.0.0.1:{}",
            std::env::var("EDGE_TTS_PORT").unwrap_or_else(|_| "9881".into())
        ),
    }
}

fn tts_health_path<'a>(config: &'a TtsConfig, adapter_id: &str) -> &'a str {
    if let Some(path) = config.health_path.as_deref().filter(|value| !value.trim().is_empty()) {
        return path;
    }

    match adapter_id {
        "sovits" => "/docs",
        _ => "/voices",
    }
}

fn default_character_name(config: &TtsConfig, adapter_id: &str) -> &'static str {
    let _ = config;
    match adapter_id {
        "sovits" => "feibi",
        _ => "feibi",
    }
}

fn build_tts_request_payload(
    config: &TtsConfig,
    adapter_id: &str,
    text: &str,
    voice: Option<&str>,
) -> Value {
    let mut payload = Map::from_iter([
        (
            "character_name".into(),
            Value::String(default_character_name(config, adapter_id).to_string()),
        ),
        ("text".into(), Value::String(text.to_string())),
        (
            "voice".into(),
            voice.map_or(Value::Null, |value| Value::String(value.to_string())),
        ),
    ]);

    if adapter_id == "edge_tts" {
        if let Some(rate) = config
            .speech_rate
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            payload.insert("rate".into(), Value::String(rate.to_string()));
        }
    }

    Value::Object(payload)
}

const TTS_HEALTH_CACHE_TTL: Duration = Duration::from_secs(8);

type TtsHealthCache = Arc<Mutex<HashMap<String, Instant>>>;

fn tts_health_cache() -> &'static TtsHealthCache {
    static CACHE: OnceLock<TtsHealthCache> = OnceLock::new();
    CACHE.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

async fn wait_for_tts_worker(endpoint: &str, health_path: &str) -> Result<()> {
    let health_url = format!("{endpoint}{}", normalize_health_path(health_path));
    let now = Instant::now();
    {
        let cache = tts_health_cache().lock().await;
        if let Some(last_healthy_at) = cache.get(&health_url) {
            if now.duration_since(*last_healthy_at) <= TTS_HEALTH_CACHE_TTL {
                return Ok(());
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;

    let mut last_error = None;
    for _ in 0..30 {
        match client.get(&health_url).send().await {
            Ok(response) if response.status().is_success() => {
                let mut cache = tts_health_cache().lock().await;
                cache.insert(health_url.clone(), Instant::now());
                return Ok(());
            }
            Ok(response) => {
                last_error = Some(format!("worker returned {}", response.status()));
            }
            Err(error) => {
                last_error = Some(error.to_string());
            }
        }
        sleep(Duration::from_millis(250)).await;
    }

    Err(anyhow::anyhow!(
        "timed out waiting for tts worker at {endpoint}: {}",
        last_error.unwrap_or_else(|| "unknown error".into())
    ))
}

fn normalize_health_path(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::{Duration, Instant};

    use app_config::TtsConfig;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::{
        build_tts_request_payload, select_tts_adapter, tts_endpoint, tts_health_path,
        wait_for_tts_worker,
    };

    #[test]
    fn tts_adapter_selection_respects_provider_config() {
        assert_eq!(select_tts_adapter(&TtsConfig::default()), "edge_tts");
        assert_eq!(
            select_tts_adapter(&TtsConfig {
                provider: Some("sovits".into()),
                ..TtsConfig::default()
            }),
            "sovits"
        );
    }

    #[test]
    fn tts_endpoint_prefers_formal_config_and_health_path() {
        let config = TtsConfig {
            provider: Some("sovits".into()),
            endpoint: Some("http://127.0.0.1:9882/".into()),
            health_path: Some("healthz".into()),
            chat_voice: None,
            speech_rate: None,
        };

        assert_eq!(tts_endpoint(&config, "sovits"), "http://127.0.0.1:9882");
        assert_eq!(tts_health_path(&config, "sovits"), "healthz");
    }

    #[test]
    fn edge_tts_dispatch_includes_configured_speech_rate() {
        let payload = build_tts_request_payload(
            &TtsConfig {
                provider: Some("edge_tts".into()),
                endpoint: None,
                health_path: None,
                chat_voice: Some("edge-tts-zh".into()),
                speech_rate: Some("1.4".into()),
            },
            "edge_tts",
            "speak faster",
            Some("edge-tts-zh"),
        );

        assert_eq!(
            payload,
            json!({
                "character_name": "feibi",
                "text": "speak faster",
                "voice": "edge-tts-zh",
                "rate": "1.4"
            })
        );
    }

    #[test]
    fn edge_tts_dispatch_omits_speech_rate_when_not_configured() {
        let payload = build_tts_request_payload(
            &TtsConfig {
                provider: Some("edge_tts".into()),
                endpoint: None,
                health_path: None,
                chat_voice: Some("edge-tts-zh".into()),
                speech_rate: None,
            },
            "edge_tts",
            "default speed",
            Some("edge-tts-zh"),
        );

        assert_eq!(
            payload,
            json!({
                "character_name": "feibi",
                "text": "default speed",
                "voice": "edge-tts-zh"
            })
        );
        assert!(payload.get("rate").is_none());
    }

    #[test]
    fn sovits_dispatch_omits_speech_rate_even_when_configured() {
        let payload = build_tts_request_payload(
            &TtsConfig {
                provider: Some("sovits".into()),
                endpoint: Some("http://127.0.0.1:9882".into()),
                health_path: None,
                chat_voice: Some("unused".into()),
                speech_rate: Some("1.4".into()),
            },
            "sovits",
            "keep original payload",
            Some("unused"),
        );

        assert_eq!(
            payload,
            json!({
                "character_name": "feibi",
                "text": "keep original payload",
                "voice": "unused"
            })
        );
        assert!(payload.get("rate").is_none());
    }

    #[tokio::test]
    async fn wait_for_tts_worker_reuses_recently_healthy_endpoint() {
        let hits = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let addr = listener.local_addr().expect("listener addr");
        let hits_for_server = Arc::clone(&hits);
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.expect("accept health request");
                hits_for_server.fetch_add(1, Ordering::SeqCst);
                let mut buffer = [0u8; 1024];
                let _ = socket.read(&mut buffer).await;
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nOK")
                    .await
                    .expect("write health response");
            }
        });

        let endpoint = format!("http://{}", addr);
        wait_for_tts_worker(&endpoint, "/healthz")
            .await
            .expect("first health probe succeeds");
        let after_first = hits.load(Ordering::SeqCst);
        assert_eq!(after_first, 1);

        let start = Instant::now();
        wait_for_tts_worker(&endpoint, "/healthz")
            .await
            .expect("cached health probe succeeds");
        let elapsed = start.elapsed();

        assert_eq!(
            hits.load(Ordering::SeqCst),
            after_first,
            "recently healthy worker should not be probed again immediately"
        );
        assert!(elapsed < Duration::from_millis(100));

        server.abort();
    }
}
