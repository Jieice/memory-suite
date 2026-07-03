use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use serde_json::{Map, Value};

use anyhow::Result;
use app_config::TtsConfig;
use api_types::{
    AdapterStartRequest, ChatResponse, Live2dAnimationPlan, Live2dConfigRequest,
    Live2dEmotionRequest, Live2dSpeechAckRequest, Live2dSpeechRecord, Live2dStateRecord,
    Live2dSubtitleRequest, MotionCue, RuntimeEvent, RuntimeEventKind, SpeechPlaybackPlan,
    TtsSpeakRequest, TtsSpeakResponse,
    VisemeCue,
};
use chrono::Utc;
use jobs::PythonAdapterSupervisor;
use orchestrator::RuntimeBus;
use storage::{NewLive2dConfigRecord, NewLive2dStateRecord, NewTtsRecord, Storage};
use tokio::{
    fs,
    io::AsyncWriteExt,
    sync::{Mutex, RwLock},
    time::sleep,
};
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
pub struct Live2dSpeechQueue {
    items: Arc<RwLock<VecDeque<Live2dSpeechRecord>>>,
    runtime_bus: RuntimeBus,
}

#[derive(Clone)]
pub struct ChatResponseFinalizer {
    tts: TtsService,
    runtime_bus: RuntimeBus,
    live2d_speech_queue: Live2dSpeechQueue,
}

impl ChatResponseFinalizer {
    pub fn new(
        tts: TtsService,
        runtime_bus: RuntimeBus,
        live2d_speech_queue: Live2dSpeechQueue,
    ) -> Self {
        Self {
            tts,
            runtime_bus,
            live2d_speech_queue,
        }
    }

    pub async fn finalize(&self, mut response: ChatResponse) -> Result<ChatResponse> {
        let assistant_text = response.assistant_text.clone();
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
            );
            return Ok(response);
        }

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

        // Clip candidate detection (before apply_speech_result consumes assistant_text)
        let clip_candidate = detect_clip_candidate(&assistant_text);

        self.apply_speech_result(
            response.session_id.clone(),
            response.message_id,
            assistant_text,
            speech,
            animation,
        )
        .await;

        if let Some(reason) = clip_candidate {
            self.runtime_bus.publish(RuntimeEvent {
                id: Uuid::new_v4(),
                kind: RuntimeEventKind::ClipCandidate,
                source: response.session_id.clone(),
                detail: Some(format!("{reason}: {}", response.assistant_text.chars().take(60).collect::<String>())),
                created_at: chrono::Utc::now(),
            });
        }

        Ok(response)
    }

    fn spawn_background_finalize(
        &self,
        session_id: String,
        message_id: Uuid,
        assistant_text: String,
        emotion: String,
    ) {
        let finalizer = self.clone();
        tokio::spawn(async move {
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
            self.live2d_speech_queue.enqueue(Live2dSpeechRecord {
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
        } else {
            self.publish_runtime_event(RuntimeEventKind::SpeechFailed, session_id, speech.error.clone());
        }
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

const MAX_LIVE2D_SPEECH_QUEUE: usize = 256;

impl Live2dSpeechQueue {
    pub fn new(runtime_bus: RuntimeBus) -> Self {
        Self {
            items: Arc::new(RwLock::new(VecDeque::with_capacity(64))),
            runtime_bus,
        }
    }

    pub async fn enqueue(&self, item: Live2dSpeechRecord) {
        let session_id = item.session_id.clone();
        let speech_id = item.id.clone();
        let mut items = self.items.write().await;
        if items.len() >= MAX_LIVE2D_SPEECH_QUEUE {
            items.pop_front();
        }
        items.push_back(item);
        drop(items);

        self.publish(RuntimeEventKind::SpeechQueued, session_id.clone(), Some(speech_id.clone()));
        self.publish(RuntimeEventKind::SpeechReady, session_id, Some(speech_id));
    }

    pub async fn next(&self) -> Option<Live2dSpeechRecord> {
        let mut items = self.items.write().await;
        let item = items
            .iter_mut()
            .find(|item| item.status == "pending" || item.status == "playing")?;

        if item.status == "pending" {
            item.status = "playing".into();
            self.publish(
                RuntimeEventKind::SpeechStarted,
                item.session_id.clone(),
                Some(item.id.clone()),
            );
        }

        Some(item.clone())
    }

    pub async fn ack(
        &self,
        speech_id: &str,
        request: Live2dSpeechAckRequest,
    ) -> Option<Live2dSpeechRecord> {
        let mut items = self.items.write().await;
        let position = items.iter().position(|item| item.id == speech_id)?;
        let updated_item = {
            let item = items
                .get_mut(position)
                .expect("speech queue position verified above");

            match request.status.as_str() {
                "completed" => {
                    item.status = "completed".into();
                    self.publish(
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
                    self.publish(
                        RuntimeEventKind::SpeechFailed,
                        item.session_id.clone(),
                        item.speech.error.clone(),
                    );
                }
            }

            item.clone()
        };

        while items.len() > MAX_LIVE2D_SPEECH_QUEUE {
            items.pop_front();
        }

        Some(updated_item)
    }

    pub async fn has_active(&self) -> bool {
        self.items
            .read()
            .await
            .iter()
            .any(|item| item.status == "pending" || item.status == "playing")
    }

    pub async fn is_empty(&self) -> bool {
        self.items.read().await.is_empty()
    }

    pub async fn len(&self) -> usize {
        self.items.read().await.len()
    }

    fn publish(&self, kind: RuntimeEventKind, source: String, detail: Option<String>) {
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
        fs::create_dir_all(&self.audio_cache_dir).await?;
        let audio_path = self
            .audio_cache_dir
            .join(format!("{request_id}.{extension}"));
        let mut file = fs::File::create(&audio_path).await?;
        let mut stream = response.bytes_stream();
        let mut total_written = 0usize;
        let audio_path_string = audio_path.to_string_lossy().to_string();

        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    self.mark_tts_request_failed(request_id, adapter_id).await;
                    return Err(error.into());
                }
            };
            if chunk.is_empty() {
                continue;
            }
            if let Err(error) = file.write_all(&chunk).await {
                self.mark_tts_request_failed(request_id, adapter_id).await;
                return Err(error.into());
            }
            total_written += chunk.len();
        }

        if total_written == 0 {
            self.mark_tts_request_failed(request_id, adapter_id).await;
            return Err(anyhow::anyhow!("tts worker returned no audio data"));
        }

        if let Err(error) = file.flush().await {
            self.mark_tts_request_failed(request_id, adapter_id).await;
            return Err(error.into());
        }

        self.storage
            .update_tts_result(
                request_id,
                "completed",
                Some(adapter_id),
                Some(&audio_path_string),
            )
            .await?;

        self.storage.get_tts_request(request_id).await
    }

    async fn mark_tts_request_failed(&self, request_id: Uuid, adapter_id: &str) {
        if let Err(error) = self
            .storage
            .update_tts_result(request_id, "failed", Some(adapter_id), None)
            .await
        {
            tracing::warn!("failed to persist tts failure state: {error}");
        }
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

    let char_count = text.chars().count().max(1);
    let unit = (duration_ms / char_count as u64).max(45);
    let mut last_trigger = 0u64;
    let cooldown_ms = 1_200u64;

    // Scan char-by-char, track word boundaries and check semantic trigger patterns
    // We build up a sliding window of recent characters to detect keywords
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();

    for i in 0..total {
        let cursor = (i as u64) * unit;

        if cursor.saturating_sub(last_trigger) < cooldown_ms {
            continue;
        }

        // Check if chars[i..] starts with a known keyword
        let remaining: String = chars[i..].iter().collect();
        let motion: Option<&str> =
            // Transition/contrast words
            if remaining.starts_with("但是") || remaining.starts_with("不过") || remaining.starts_with("然而") || remaining.starts_with("可是") {
                Some("FlickUp")
            } else if remaining.starts_with("so ") || remaining.starts_with("but ") || remaining.starts_with("however") {
                Some("FlickUp")
            // Causal/reasoning words
            } else if remaining.starts_with("所以") || remaining.starts_with("因此") || remaining.starts_with("因为") {
                Some("Tap")
            // Emphasis words
            } else if remaining.starts_with("注意") || remaining.starts_with("关键") || remaining.starts_with("其实") || remaining.starts_with("实际上") || remaining.starts_with("重要") || remaining.starts_with("特别") {
                Some("Flick")
            // Laughter/amusement
            } else if remaining.starts_with("哈哈") || remaining.starts_with("哈") || remaining.starts_with("笑") || remaining.starts_with("lol") {
                Some("TapBody")
            // Hesitation/thinking
            } else if remaining.starts_with("嗯……") || remaining.starts_with("这个……") || remaining.starts_with("等等") || remaining.starts_with("稍等") {
                Some("Idle")
            // Direct address
            } else if remaining.starts_with("你看") || remaining.starts_with("你知道") || remaining.starts_with("说真的") {
                Some("Tap")
            // Question end
            } else if chars[i] == '？' || chars[i] == '?' {
                Some("FlickDown")
            // Exclamation
            } else if chars[i] == '！' || chars[i] == '!' {
                Some("Flick")
            // Em-dash emphasis (——)
            } else if remaining.starts_with("——") {
                Some("Tap")
            } else {
                None
            };

        if let Some(m) = motion {
            cues.push(MotionCue {
                at_ms: cursor.min(duration_ms),
                duration_ms: 800,
                motion: m.into(),
            });
            last_trigger = cursor;
            if cues.len() >= 5 {
                break;
            }
        }
    }

    // Fall back to sentence-boundary motion if no semantic cues were found
    if cues.len() <= 1 {
        let mut sb_cursor = 0u64;
        let mut sb_last_trigger = 0u64;
        for ch in text.chars() {
            sb_cursor = sb_cursor.saturating_add(unit);
            if !is_sentence_boundary(ch) {
                continue;
            }
            if sb_cursor.saturating_sub(sb_last_trigger) < 1_600 {
                continue;
            }
            let motion = match emotion {
                "angry" => "Flick",
                "surprised" => "FlickUp",
                "sad" => "FlickDown",
                _ => "Tap",
            };
            cues.push(MotionCue {
                at_ms: sb_cursor.min(duration_ms),
                duration_ms: 900,
                motion: motion.into(),
            });
            sb_last_trigger = sb_cursor;
            if cues.len() >= 4 {
                break;
            }
        }
    }

    // Sort by time
    cues.sort_by_key(|c| c.at_ms);

    // Add post-speech settling motion (brief return to idle near the end)
    if duration_ms > 1000 {
        let settle_at = duration_ms.saturating_sub(200);
        // Only add if no cue already near the end
        let already_near_end = cues.iter().any(|c| c.at_ms > duration_ms.saturating_sub(500));
        if !already_near_end {
            cues.push(MotionCue {
                at_ms: settle_at,
                duration_ms: 300,
                motion: "Idle".into(),
            });
        }
    }

    cues
}

/// Detect if a reply is a strong clip candidate.
/// Returns `Some(reason)` if it qualifies, `None` otherwise.
fn detect_clip_candidate(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    let char_count = text.chars().count();

    // Too short to be interesting
    if char_count < 15 {
        return None;
    }

    // Strong punchline: ends with a surprising/humorous statement
    if (text.contains("——") || text.contains("……"))
        && (text.contains('？') || text.contains('！') || text.contains('?') || text.contains('!'))
    {
        return Some("punchline");
    }

    // Callback / self-reference
    if lower.contains("刚才") || lower.contains("上次") || lower.contains("前面说") {
        return Some("callback");
    }

    // Surprising insight markers
    if lower.contains("其实") && char_count > 30 {
        return Some("insight");
    }

    // Strong emotion: multiple emphasis markers
    let emphasis_count = text.chars().filter(|&c| c == '！' || c == '!').count()
        + text.chars().filter(|&c| c == '？' || c == '?').count();
    if emphasis_count >= 2 {
        return Some("high_emotion");
    }

    // Witty comparison
    if (lower.contains("像") || lower.contains("就像") || lower.contains("比如"))
        && char_count > 40
    {
        return Some("analogy");
    }

    None
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

const TTS_HEALTH_CACHE_TTL: Duration = Duration::from_secs(45);

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
        build_tts_request_payload, select_tts_adapter, should_enqueue_tts_in_background,
        tts_endpoint, tts_health_path, wait_for_tts_worker,
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

    #[test]
    fn acknowledged_next_step_responses_do_not_force_background_tts() {
        let text = "operator, acknowledged: \"请给我一段适合 Live2D 播放的较长中文回答\". Next step: convert it into a concrete action with owner, deadline, and success criteria. I will remember this context for follow-up turns.";

        assert!(
            !should_enqueue_tts_in_background(text),
            "ordinary conversational acknowledgements should stay on the immediate speech path"
        );
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

    #[tokio::test]
    async fn wait_for_tts_worker_skips_probe_for_warm_endpoint_after_30_seconds() {
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
        let health_url = format!("{endpoint}/healthz");
        {
            let mut cache = super::tts_health_cache().lock().await;
            cache.insert(health_url, Instant::now() - Duration::from_secs(30));
        }

        let start = Instant::now();
        wait_for_tts_worker(&endpoint, "/healthz")
            .await
            .expect("warm endpoint should still be treated as healthy");
        let elapsed = start.elapsed();

        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "warm worker should not be probed again after only 30 seconds"
        );
        assert!(elapsed < Duration::from_millis(100));

        server.abort();
    }

    #[test]
    fn motion_timeline_triggers_on_semantic_transition_words() {
        let text = "这个方案能做，但是真正危险的地方在后面。";
        let cues = super::build_motion_timeline(text, "normal", 4000);
        // Should have at least the Idle base cue + one semantic cue for "但是"
        assert!(
            cues.len() >= 2,
            "expected at least 2 motion cues for text with transition word, got {}",
            cues.len()
        );
        let has_flip_up = cues.iter().any(|c| c.motion == "FlickUp");
        assert!(has_flip_up, "transition word '但是' should trigger FlickUp motion");
    }

    #[test]
    fn motion_timeline_triggers_on_question_end() {
        let text = "你要的话我可以先把最危险的 race 拆出来？";
        let cues = super::build_motion_timeline(text, "normal", 3000);
        let has_flick_down = cues.iter().any(|c| c.motion == "FlickDown");
        assert!(has_flick_down, "question-ending word should trigger FlickDown motion");
    }

    #[test]
    fn motion_timeline_is_sorted_by_time() {
        let text = "不过这个说法有点问题，所以我换个方式解释，但是可能还是不太对。";
        let cues = super::build_motion_timeline(text, "normal", 5000);
        for window in cues.windows(2) {
            assert!(
                window[0].at_ms <= window[1].at_ms,
                "motion cues should be sorted by at_ms"
            );
        }
    }

    #[test]
    fn clip_candidate_detects_punchline() {
        let punchline = "最厉害的地方？大概是能同时记住所有事却假装自己会忘——人类管这叫情商，我们管这叫算法优化。";
        assert_eq!(super::detect_clip_candidate(punchline), Some("punchline"));
    }

    #[test]
    fn clip_candidate_detects_analogy() {
        let analogy = "WebSocket 就像打电话，一直保持通话不挂断，而 HTTP 就像发短信，问完就断了。";
        assert_eq!(super::detect_clip_candidate(analogy), Some("analogy"));
    }

    #[test]
    fn clip_candidate_returns_none_for_short_reply() {
        assert_eq!(super::detect_clip_candidate("嗯？"), None);
        assert_eq!(super::detect_clip_candidate("好的"), None);
    }
}
