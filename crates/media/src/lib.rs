use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, OnceLock, RwLock as StdRwLock},
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use futures_util::StreamExt;
use reqwest::multipart::{Form, Part};
use serde_json::{Map, Value};

use anyhow::Result;
use api_types::{
    ChatResponse, Live2dAnimationPlan, Live2dConfigRequest, Live2dEmotionRequest,
    Live2dSpeechAckRequest, Live2dSpeechRecord, Live2dStateRecord, Live2dSubtitleRequest,
    MotionCue, RuntimeEvent, RuntimeEventKind, SpeechPlaybackPlan, SttTranscribeRequest,
    SttTranscribeResponse, TtsSpeakRequest, TtsSpeakResponse, VisemeCue, VisionObserveRequest,
    VisionObserveResponse,
};
use app_config::{SttConfig, TtsConfig, VisionConfig};
use chrono::Utc;
use orchestrator::RuntimeBus;
use python_adapters::TtsAdapterSupervisor;
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
    adapters: TtsAdapterSupervisor,
    runtime_bus: RuntimeBus,
    enable_mock_tts: bool,
    audio_cache_dir: PathBuf,
    config: Arc<StdRwLock<TtsConfig>>,
    /// Runtime voice override (e.g. mood-driven), takes precedence over config.
    voice_override: Arc<StdRwLock<Option<String>>>,
}

#[derive(Clone)]
pub struct SttService {
    adapters: TtsAdapterSupervisor,
    config: Arc<StdRwLock<SttConfig>>,
}

/// Forwards captured screen frames to an OpenAI-compatible vision model and
/// returns a one-line scene description. Both cloud (`openai_compatible`) and
/// self-hosted (`local`) VLMs speak the same `/chat/completions` image_url
/// format, so the provider hint only drives endpoint/model defaults.
#[derive(Clone)]
pub struct VisionService {
    config: Arc<StdRwLock<VisionConfig>>,
}

#[derive(Clone)]
pub struct Live2dService {
    storage: Storage,
    runtime_bus: RuntimeBus,
}

#[derive(Clone)]
pub struct SessionTurnGuard {
    generations: Arc<RwLock<HashMap<String, u64>>>,
}

#[derive(Clone)]
struct QueuedLive2dSpeechRecord {
    record: Live2dSpeechRecord,
    turn_generation: Option<u64>,
    /// True for the last sentence segment of a streamed turn. When such a
    /// segment finishes (completed/failed/cancelled) the queue emits a
    /// `SpeechTurnCompleted` event so the voice loop knows the whole turn is
    /// done — not just one of several sentences.
    is_turn_final: bool,
}

#[derive(Clone)]
pub struct Live2dSpeechQueue {
    items: Arc<RwLock<VecDeque<QueuedLive2dSpeechRecord>>>,
    runtime_bus: RuntimeBus,
    session_turn_guard: SessionTurnGuard,
}

#[derive(Clone)]
pub struct ChatResponseFinalizer {
    tts: TtsService,
    runtime_bus: RuntimeBus,
    live2d_speech_queue: Live2dSpeechQueue,
    session_turn_guard: SessionTurnGuard,
}

impl ChatResponseFinalizer {
    pub fn new(
        tts: TtsService,
        runtime_bus: RuntimeBus,
        live2d_speech_queue: Live2dSpeechQueue,
        session_turn_guard: SessionTurnGuard,
    ) -> Self {
        Self {
            tts,
            runtime_bus,
            live2d_speech_queue,
            session_turn_guard,
        }
    }

    pub async fn finalize(
        &self,
        mut response: ChatResponse,
        turn_generation: Option<u64>,
    ) -> Result<ChatResponse> {
        let assistant_text = response.assistant_text.clone();
        if assistant_text.trim().is_empty() {
            return Ok(response);
        }
        // Honor a leading model emotion tag (e.g. "[happy] ...") if present,
        // stripping it so TTS never reads it aloud; otherwise fall back to the
        // keyword heuristic.
        let (emotion, untagged_text) = resolve_emotion(&assistant_text);
        let spoken_text = prepare_spoken_text(&untagged_text);
        let chat_voice = self.tts.default_chat_voice();

        // TTS synthesis is always dispatched off the request path. The HTTP
        // response returns immediately with a `dispatching` plan; the actual
        // audio arrives asynchronously via the live2d speech queue and the
        // `speech_ready` runtime event, which is how every player (overlay +
        // voice loop) already consumes speech. Blocking the request on full
        // synthesis only added latency without changing what the user hears.
        let speech = build_background_dispatch_speech_plan(response.message_id, &spoken_text);
        let animation = Live2dAnimationPlan {
            emotion: emotion.clone(),
            subtitle_text: spoken_text.clone(),
            motion_timeline: build_motion_timeline(&spoken_text, &emotion, speech.duration_ms),
        };
        response.speech = speech;
        response.animation = animation;

        // Clip candidate detection is cheap (a string scan) and must run before
        // the assistant text is moved into the background task.
        if let Some(reason) = detect_clip_candidate(&assistant_text) {
            self.runtime_bus.publish(RuntimeEvent {
                id: Uuid::new_v4(),
                kind: RuntimeEventKind::ClipCandidate,
                source: response.session_id.clone(),
                detail: Some(format!(
                    "{reason}: {}",
                    assistant_text.chars().take(60).collect::<String>()
                )),
                created_at: chrono::Utc::now(),
            });
        }

        self.spawn_background_finalize(
            response.session_id.clone(),
            response.message_id,
            spoken_text,
            emotion,
            chat_voice,
            turn_generation,
        );

        Ok(response)
    }

    /// Consumes streamed sentences from `sentence_rx`, synthesizing and
    /// enqueuing each as its own playback segment as soon as it arrives. TTS
    /// dispatch is serialized here so segments enter the queue in reading order
    /// (playback is strictly ordered), but sentence N's synthesis still overlaps
    /// the model generating sentence N+1 — that overlap is the latency win.
    ///
    /// The last segment is marked turn-final so the queue emits
    /// `SpeechTurnCompleted` when the whole reply finishes playing, not after
    /// the first sentence. Returns after the channel closes and the final
    /// segment has been marked (the segments themselves play asynchronously).
    pub async fn consume_streamed_sentences(
        &self,
        session_id: String,
        message_id: Uuid,
        chat_voice: String,
        turn_generation: Option<u64>,
        mut sentence_rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    ) {
        let mut last_segment_id: Option<String> = None;
        let mut segment_index: u32 = 0;
        // Sticky emotion for the turn: set from the first tagged sentence and
        // reused for later segments (the model tags only the opening line).
        let mut turn_emotion: Option<String> = None;

        while let Some(sentence) = sentence_rx.recv().await {
            // A turn may be superseded (barge-in / manual interrupt) while its
            // sentences are still streaming in. Stop dispatching once stale so
            // we don't synthesize audio for an abandoned turn.
            if let Some(generation) = turn_generation {
                if !self
                    .session_turn_guard
                    .is_current(&session_id, generation)
                    .await
                {
                    break;
                }
            }
            // The model may prefix only the first sentence with an emotion tag,
            // but the whole turn should share that mood. Resolve+strip the tag on
            // each sentence; once a tag is seen, it sticks for later segments.
            let (sentence_emotion, sentence_body) = resolve_emotion(&sentence);
            if turn_emotion.is_none() && sentence_emotion != "normal" {
                turn_emotion = Some(sentence_emotion.clone());
            }
            let spoken = prepare_spoken_text(&sentence_body);
            if spoken.trim().is_empty() {
                continue;
            }
            // Each segment needs a distinct id; derive one from the message id so
            // segments of a turn stay visually grouped in logs.
            let segment_id = Uuid::new_v4();
            let speech = self
                .dispatch_speech_plan(segment_id, session_id.clone(), &spoken, &chat_voice)
                .await;
            if speech.status != "ready" {
                self.publish_runtime_event(
                    RuntimeEventKind::SpeechFailed,
                    session_id.clone(),
                    speech.error.clone(),
                );
                continue;
            }
            if let Some(generation) = turn_generation {
                if !self
                    .session_turn_guard
                    .is_current(&session_id, generation)
                    .await
                {
                    break;
                }
            }
            // Prefer the turn's tagged emotion (from the model); fall back to the
            // per-sentence heuristic when the reply carried no tag.
            let emotion = turn_emotion
                .clone()
                .unwrap_or_else(|| sentence_emotion.clone());
            let animation = Live2dAnimationPlan {
                emotion: emotion.clone(),
                subtitle_text: spoken.clone(),
                motion_timeline: build_motion_timeline(&spoken, &emotion, speech.duration_ms),
            };
            last_segment_id = Some(speech.request_id.clone());
            segment_index += 1;
            self.live2d_speech_queue
                .enqueue_segment(
                    Live2dSpeechRecord {
                        id: speech.request_id.clone(),
                        session_id: session_id.clone(),
                        message_id,
                        assistant_text: spoken,
                        speech: speech.clone(),
                        animation,
                        status: "pending".into(),
                        created_at: Utc::now(),
                    },
                    turn_generation,
                    // Not yet known to be final; marked below once the stream ends.
                    false,
                )
                .await;
        }

        // Mark the last enqueued segment as the turn boundary. If no segment was
        // enqueued (empty/failed reply), emit the turn-complete signal directly
        // so a waiting voice loop is never left hanging.
        match last_segment_id {
            Some(id) => {
                self.live2d_speech_queue
                    .mark_turn_final(&id, &session_id)
                    .await;
            }
            None => {
                if segment_index == 0 {
                    self.publish_runtime_event(
                        RuntimeEventKind::SpeechTurnCompleted,
                        session_id,
                        None,
                    );
                }
            }
        }
    }

    fn spawn_background_finalize(
        &self,
        session_id: String,
        message_id: Uuid,
        assistant_text: String,
        emotion: String,
        chat_voice: String,
        turn_generation: Option<u64>,
    ) {
        let finalizer = self.clone();
        tokio::spawn(async move {
            let speech = finalizer
                .dispatch_speech_plan(message_id, session_id.clone(), &assistant_text, &chat_voice)
                .await;
            let animation = Live2dAnimationPlan {
                emotion: emotion.clone(),
                subtitle_text: assistant_text.clone(),
                motion_timeline: build_motion_timeline(
                    &assistant_text,
                    &emotion,
                    speech.duration_ms,
                ),
            };
            finalizer
                .apply_speech_result(
                    session_id,
                    message_id,
                    assistant_text,
                    speech,
                    animation,
                    turn_generation,
                )
                .await;
        });
    }

    async fn dispatch_speech_plan(
        &self,
        fallback_message_id: Uuid,
        session_id: String,
        assistant_text: &str,
        voice: &str,
    ) -> SpeechPlaybackPlan {
        match self
            .tts
            .enqueue(TtsSpeakRequest {
                session_id: Some(session_id),
                text: assistant_text.to_string(),
                voice: Some(voice.to_string()),
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
        turn_generation: Option<u64>,
    ) {
        if let Some(generation) = turn_generation {
            if !self
                .session_turn_guard
                .is_current(&session_id, generation)
                .await
            {
                return;
            }
        }
        if speech.status == "ready" {
            self.live2d_speech_queue
                .enqueue_with_turn(
                    Live2dSpeechRecord {
                        id: speech.request_id.clone(),
                        session_id: session_id.clone(),
                        message_id,
                        assistant_text,
                        speech: speech.clone(),
                        animation,
                        status: "pending".into(),
                        created_at: Utc::now(),
                    },
                    turn_generation,
                )
                .await;
        } else {
            self.publish_runtime_event(
                RuntimeEventKind::SpeechFailed,
                session_id,
                speech.error.clone(),
            );
        }
    }

    fn publish_runtime_event(
        &self,
        kind: RuntimeEventKind,
        source: String,
        detail: Option<String>,
    ) {
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

impl SessionTurnGuard {
    pub fn new() -> Self {
        Self {
            generations: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn begin_turn(&self, session_id: &str) -> u64 {
        self.bump(session_id).await
    }

    pub async fn interrupt(&self, session_id: &str) -> u64 {
        self.bump(session_id).await
    }

    pub async fn is_current(&self, session_id: &str, generation: u64) -> bool {
        self.current(session_id).await == generation
    }

    pub async fn current(&self, session_id: &str) -> u64 {
        *self
            .generations
            .read()
            .await
            .get(session_id)
            .unwrap_or(&0)
    }

    async fn bump(&self, session_id: &str) -> u64 {
        let mut generations = self.generations.write().await;
        let next = generations
            .get(session_id)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        generations.insert(session_id.to_string(), next);
        next
    }
}

impl Live2dSpeechQueue {
    pub fn new(runtime_bus: RuntimeBus, session_turn_guard: SessionTurnGuard) -> Self {
        Self {
            items: Arc::new(RwLock::new(VecDeque::with_capacity(64))),
            runtime_bus,
            session_turn_guard,
        }
    }

    pub async fn enqueue(&self, item: Live2dSpeechRecord) {
        self.enqueue_with_turn(item, None).await;
    }

    pub async fn enqueue_with_turn(&self, item: Live2dSpeechRecord, turn_generation: Option<u64>) {
        // A single whole-reply segment is trivially the final one for its turn.
        self.enqueue_segment(item, turn_generation, true).await;
    }

    /// Enqueue one playback segment. `is_turn_final` marks the last sentence of
    /// a streamed turn so the queue can emit `SpeechTurnCompleted` when it
    /// finishes. Non-final segments only emit the per-segment lifecycle events.
    pub async fn enqueue_segment(
        &self,
        item: Live2dSpeechRecord,
        turn_generation: Option<u64>,
        is_turn_final: bool,
    ) {
        let session_id = item.session_id.clone();
        let speech_id = item.id.clone();
        let mut items = self.items.write().await;
        if items.len() >= MAX_LIVE2D_SPEECH_QUEUE {
            items.pop_front();
        }
        items.push_back(QueuedLive2dSpeechRecord {
            record: item,
            turn_generation,
            is_turn_final,
        });
        drop(items);

        self.publish(
            RuntimeEventKind::SpeechQueued,
            session_id.clone(),
            Some(speech_id.clone()),
        );
        self.publish(RuntimeEventKind::SpeechReady, session_id, Some(speech_id));
    }

    pub async fn next(&self) -> Option<Live2dSpeechRecord> {
        loop {
            let candidate = {
                let items = self.items.read().await;
                items
                    .iter()
                    .find(|item| {
                        item.record.status == "pending" || item.record.status == "playing"
                    })
                    .map(|item| {
                        (
                            item.record.id.clone(),
                            item.record.session_id.clone(),
                            item.turn_generation,
                        )
                    })
            }?;

            let (speech_id, session_id, turn_generation) = candidate;
            if let Some(generation) = turn_generation {
                if !self
                    .session_turn_guard
                    .is_current(&session_id, generation)
                    .await
                {
                    let mut items = self.items.write().await;
                    if let Some(position) = items.iter().position(|item| item.record.id == speech_id)
                    {
                        items.remove(position);
                    }
                    continue;
                }
            }

            let mut items = self.items.write().await;
            let item = items
                .iter_mut()
                .find(|item| item.record.id == speech_id)?;

            if item.record.status == "pending" {
                item.record.status = "playing".into();
                self.publish(
                    RuntimeEventKind::SpeechStarted,
                    item.record.session_id.clone(),
                    Some(item.record.id.clone()),
                );
            }

            return Some(item.record.clone());
        }
    }

    pub async fn ack(
        &self,
        speech_id: &str,
        request: Live2dSpeechAckRequest,
    ) -> Option<Live2dSpeechRecord> {
        let mut items = self.items.write().await;
        let position = items.iter().position(|item| item.record.id == speech_id)?;
        let (updated_item, is_turn_final, session_id) = {
            let item = items
                .get_mut(position)
                .expect("speech queue position verified above");

            match request.status.as_str() {
                "completed" => {
                    item.record.status = "completed".into();
                    self.publish(
                        RuntimeEventKind::SpeechCompleted,
                        item.record.session_id.clone(),
                        Some(item.record.id.clone()),
                    );
                }
                _ => {
                    item.record.status = "failed".into();
                    if let Some(error) = request.error.clone() {
                        item.record.speech.error = Some(error);
                    }
                    let detail = Some(format_speech_failure_detail(
                        &item.record.id,
                        item.record.speech.error.as_deref(),
                    ));
                    self.publish(
                        RuntimeEventKind::SpeechFailed,
                        item.record.session_id.clone(),
                        detail,
                    );
                }
            }

            (
                item.record.clone(),
                item.is_turn_final,
                item.record.session_id.clone(),
            )
        };

        while items.len() > MAX_LIVE2D_SPEECH_QUEUE {
            items.pop_front();
        }
        drop(items);

        // The last segment of a streamed turn finished playing (or failed):
        // signal whole-turn completion so the voice loop returns to listening.
        // A single whole-reply segment is also final, so the non-streaming path
        // keeps working unchanged.
        if is_turn_final {
            self.publish(
                RuntimeEventKind::SpeechTurnCompleted,
                session_id,
                Some(speech_id.to_string()),
            );
        }

        Some(updated_item)
    }

    /// Marks `speech_id` as the final segment of its streamed turn. Called once
    /// the LLM stream closes and the last sentence's segment id is known.
    ///
    /// Handles both race orderings:
    /// - segment still queued/playing → set the flag so `ack` emits
    ///   `SpeechTurnCompleted` when it finishes.
    /// - segment already finished (fast TTS beat the stream close) → emit
    ///   `SpeechTurnCompleted` immediately so the voice loop is never stranded.
    ///
    /// If the id is unknown (e.g. the whole turn was cancelled and evicted),
    /// emits the turn-completed signal anyway so the caller cannot hang.
    pub async fn mark_turn_final(&self, speech_id: &str, session_id: &str) {
        let mut items = self.items.write().await;
        let Some(item) = items.iter_mut().find(|item| item.record.id == speech_id) else {
            drop(items);
            // Segment already evicted (turn cancelled or queue overflow). Emit
            // the signal regardless so a waiting voice loop returns to listening.
            self.publish(
                RuntimeEventKind::SpeechTurnCompleted,
                session_id.to_string(),
                Some(speech_id.to_string()),
            );
            return;
        };
        let already_finished =
            item.record.status == "completed" || item.record.status == "failed";
        item.is_turn_final = true;
        drop(items);

        if already_finished {
            self.publish(
                RuntimeEventKind::SpeechTurnCompleted,
                session_id.to_string(),
                Some(speech_id.to_string()),
            );
        }
    }

    pub async fn get(&self, speech_id: &str) -> Option<Live2dSpeechRecord> {
        self.items
            .read()
            .await
            .iter()
            .find(|item| item.record.id == speech_id)
            .map(|item| item.record.clone())
    }

    pub async fn cancel(&self, session_id: Option<&str>, reason: Option<&str>) -> usize {
        let failure_reason = reason
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("cancelled by operator")
            .to_string();
        let mut cancelled = Vec::new();

        {
            let mut items = self.items.write().await;
            for item in items.iter_mut() {
                let matches_session = session_id
                    .map(|expected| item.record.session_id == expected)
                    .unwrap_or(true);
                let active = item.record.status == "pending" || item.record.status == "playing";
                if !matches_session || !active {
                    continue;
                }
                item.record.status = "failed".into();
                item.record.speech.error = Some(failure_reason.clone());
                cancelled.push((
                    item.record.session_id.clone(),
                    item.record.id.clone(),
                    failure_reason.clone(),
                ));
            }
        }

        for (source, speech_id, error) in &cancelled {
            self.publish(
                RuntimeEventKind::SpeechFailed,
                source.clone(),
                Some(format_speech_failure_detail(speech_id, Some(error))),
            );
        }

        // Cancelling ends the turn (barge-in / manual interrupt). Emit one
        // `SpeechTurnCompleted` per affected session so the voice loop returns
        // to listening instead of waiting out its speech watchdog — the voice
        // loop keys off turn-completion, not the per-segment `speech_failed`.
        let mut signalled: Vec<String> = Vec::new();
        for (source, _, _) in &cancelled {
            if !signalled.contains(source) {
                signalled.push(source.clone());
                self.publish(RuntimeEventKind::SpeechTurnCompleted, source.clone(), None);
            }
        }

        cancelled.len()
    }

    pub async fn has_active(&self) -> bool {
        let items = self.items.read().await;
        for item in items.iter() {
            let active = item.record.status == "pending" || item.record.status == "playing";
            if !active {
                continue;
            }
            if let Some(generation) = item.turn_generation {
                if !self
                    .session_turn_guard
                    .is_current(&item.record.session_id, generation)
                    .await
                {
                    continue;
                }
            }
            return true;
        }
        false
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

fn format_speech_failure_detail(speech_id: &str, error: Option<&str>) -> String {
    match error.map(str::trim).filter(|value| !value.is_empty()) {
        Some(message) => format!("{speech_id}::{message}"),
        None => speech_id.to_string(),
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
        adapters: TtsAdapterSupervisor,
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
            config: Arc::new(StdRwLock::new(config)),
            voice_override: Arc::new(StdRwLock::new(None)),
        }
    }

    pub fn update_runtime_config(&self, config: TtsConfig) {
        if let Ok(mut guard) = self.config.write() {
            *guard = config;
        }
    }

    pub fn current_config(&self) -> TtsConfig {
        self.config
            .read()
            .ok()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// Set or clear the runtime voice override (e.g. when the persona mood
    /// maps to a different canon voice). Overrides `config.chat_voice`.
    pub fn set_voice_override(&self, voice: Option<String>) {
        if let Ok(mut guard) = self.voice_override.write() {
            *guard = voice.filter(|value| !value.trim().is_empty());
        }
    }

    pub fn default_chat_voice(&self) -> String {
        if let Ok(guard) = self.voice_override.read() {
            if let Some(voice) = guard.as_ref() {
                return voice.clone();
            }
        }
        self.current_config()
            .chat_voice
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "edge-tts-zh".into())
    }

    pub async fn test_runtime_config(
        &self,
        config: &TtsConfig,
        text: &str,
        voice: Option<&str>,
    ) -> Result<TtsSpeakResponse> {
        let session_id = "settings-tts-test".to_string();
        let text = prepare_spoken_text(text);
        let adapter_id = select_tts_adapter(config);
        let record = self
            .storage
            .enqueue_tts(NewTtsRecord {
                session_id,
                text,
                voice: voice.map(|value| value.to_string()),
            })
            .await?;

        match self.adapters.start_adapter(adapter_id).await {
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
                        config,
                    )
                    .await
                {
                    Ok(completed) => completed,
                    Err(error) if self.enable_mock_tts => {
                        return self.mock_response(record.id, adapter_id, error).await;
                    }
                    Err(error) => return Err(error),
                };
                Ok(TtsSpeakResponse {
                    request_id: completed.id,
                    status: completed.status,
                    audio_path: completed.audio_path,
                    created_at: completed.created_at,
                })
            }
            Err(error) if self.enable_mock_tts => {
                self.mock_response(record.id, adapter_id, error).await
            }
            Err(error) => Err(error),
        }
    }

    pub async fn enqueue(&self, request: TtsSpeakRequest) -> Result<TtsSpeakResponse> {
        let session_id = request
            .session_id
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let text = prepare_spoken_text(&request.text);
        let config = self.current_config();
        let adapter_id = select_tts_adapter(&config);
        let record = self
            .storage
            .enqueue_tts(NewTtsRecord {
                session_id,
                text,
                voice: request.voice,
            })
            .await?;

        match self.adapters.start_adapter(adapter_id).await {
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
                        &config,
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
        config: &TtsConfig,
    ) -> Result<api_types::TtsRequestRecord> {
        let endpoint = tts_endpoint(config, adapter_id);
        wait_for_tts_worker(&endpoint, tts_health_path(config, adapter_id)).await?;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()?;
        let response = client
            .post(format!("{endpoint}/tts"))
            .json(&build_tts_request_payload(
                config,
                adapter_id,
                text,
                voice,
            ))
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

impl SttService {
    pub fn new(adapters: TtsAdapterSupervisor, config: SttConfig) -> Self {
        Self {
            adapters,
            config: Arc::new(StdRwLock::new(config)),
        }
    }

    pub fn update_runtime_config(&self, config: SttConfig) {
        if let Ok(mut guard) = self.config.write() {
            *guard = config;
        }
    }

    pub fn current_config(&self) -> SttConfig {
        self.config
            .read()
            .ok()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub async fn prewarm_current(&self) -> Result<()> {
        let config = self.current_config();
        self.prewarm_with_config(&config).await
    }

    pub async fn prewarm_with_config(&self, config: &SttConfig) -> Result<()> {
        if select_stt_adapter(config).is_none() {
            return Ok(());
        }

        let cache_key = stt_prewarm_cache_key(config);
        let now = Instant::now();
        {
            let cache = stt_prewarm_cache().lock().await;
            if let Some(last_warmed_at) = cache.get(&cache_key) {
                if now.duration_since(*last_warmed_at) <= STT_PREWARM_CACHE_TTL {
                    return Ok(());
                }
            }
        }

        let warmup_request = SttTranscribeRequest {
            audio_base64: String::new(),
            mime_type: Some("audio/wav".into()),
            session_id: Some("runtime-stt-warmup".into()),
            user_id: Some("system".into()),
            language: config.language.clone(),
            prompt: config.prompt.clone(),
        };
        let _ = self
            .dispatch_local_stt(
                config,
                &generate_silence_wav(16_000, 320),
                "audio/wav",
                &warmup_request,
            )
            .await?;

        let mut cache = stt_prewarm_cache().lock().await;
        cache.insert(cache_key, Instant::now());
        Ok(())
    }

    pub async fn test_runtime_config(&self, config: &SttConfig) -> Result<SttTranscribeResponse> {
        let provider = normalized_stt_provider(config);
        let endpoint = stt_endpoint(config);
        let model = stt_model(config);
        let started = Instant::now();

        if endpoint.is_empty() {
            return Ok(SttTranscribeResponse {
                ok: false,
                provider,
                endpoint,
                text: String::new(),
                detected_language: None,
                latency_ms: None,
                message: "请先填写 STT endpoint。".into(),
            });
        }

        if select_stt_adapter(config).is_some() {
            self.prewarm_with_config(config).await?;
            let message = format!("STT 服务已就绪并完成预热。provider={provider} · model={model}");
            return Ok(SttTranscribeResponse {
                ok: true,
                provider,
                endpoint,
                text: String::new(),
                detected_language: None,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                message,
            });
        }

        let probe = self
            .dispatch_openai_compatible_stt(
                config,
                &generate_silence_wav(16_000, 320),
                "audio/wav",
                None,
                None,
            )
            .await?;
        Ok(SttTranscribeResponse {
            latency_ms: Some(started.elapsed().as_millis() as u64),
            message: "STT endpoint 连通测试通过。".into(),
            ..probe
        })
    }

    pub async fn transcribe(&self, request: SttTranscribeRequest) -> Result<SttTranscribeResponse> {
        let config = self.current_config();
        self.transcribe_with_config(&config, request).await
    }

    async fn transcribe_with_config(
        &self,
        config: &SttConfig,
        request: SttTranscribeRequest,
    ) -> Result<SttTranscribeResponse> {
        let bytes = BASE64_STANDARD
            .decode(request.audio_base64.as_bytes())
            .map_err(|error| anyhow::anyhow!("invalid audio_base64 payload: {error}"))?;
        let mime_type = request
            .mime_type
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("audio/wav");
        let started = Instant::now();

        let mut response = if select_stt_adapter(config).is_some() {
            self.dispatch_local_stt(config, &bytes, mime_type, &request).await?
        } else {
            self.dispatch_openai_compatible_stt(
                config,
                &bytes,
                mime_type,
                request.language.as_deref(),
                request.prompt.as_deref(),
            )
            .await?
        };

        response.latency_ms = Some(started.elapsed().as_millis() as u64);
        Ok(response)
    }

    async fn dispatch_local_stt(
        &self,
        config: &SttConfig,
        bytes: &[u8],
        mime_type: &str,
        request: &SttTranscribeRequest,
    ) -> Result<SttTranscribeResponse> {
        let provider = normalized_stt_provider(config);
        let endpoint = stt_endpoint(config);
        let model = stt_model(config);
        let adapter_id = select_stt_adapter(config)
            .ok_or_else(|| anyhow::anyhow!("no local STT adapter selected"))?;

        self.adapters.start_adapter(adapter_id).await?;
        wait_for_stt_worker(&stt_health_endpoint(config)).await?;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()?;
        let payload = serde_json::json!({
            "audio_base64": BASE64_STANDARD.encode(bytes),
            "mime_type": mime_type,
            "model": model,
            "language": request.language.as_deref().or(config.language.as_deref()),
            "prompt": request.prompt.as_deref().or(config.prompt.as_deref()),
        });
        let json = client
            .post(&endpoint)
            .json(&payload)
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        let text = json
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let detected_language = json
            .get("language")
            .and_then(Value::as_str)
            .map(|value| value.to_string());

        Ok(SttTranscribeResponse {
            ok: true,
            provider,
            endpoint,
            text,
            detected_language,
            latency_ms: None,
            message: "转写完成".into(),
        })
    }

    async fn dispatch_openai_compatible_stt(
        &self,
        config: &SttConfig,
        bytes: &[u8],
        mime_type: &str,
        request_language: Option<&str>,
        request_prompt: Option<&str>,
    ) -> Result<SttTranscribeResponse> {
        let provider = normalized_stt_provider(config);
        let endpoint = stt_endpoint(config);
        let model = stt_model(config);

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()?;
        let part = Part::bytes(bytes.to_vec())
            .file_name("microphone.wav")
            .mime_str(mime_type)?;
        let mut form = Form::new().part("file", part).text("model", model);

        if let Some(language) = request_language
            .or(config.language.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            form = form.text("language", language.to_string());
        }
        if let Some(prompt) = request_prompt
            .or(config.prompt.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            form = form.text("prompt", prompt.to_string());
        }

        let mut builder = client.post(&endpoint).multipart(form);
        if let Some(api_key) = config
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            builder = builder.bearer_auth(api_key);
        }

        let json = builder
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        let text = json
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let detected_language = json
            .get("language")
            .and_then(Value::as_str)
            .map(|value| value.to_string());

        Ok(SttTranscribeResponse {
            ok: true,
            provider,
            endpoint,
            text,
            detected_language,
            latency_ms: None,
            message: "转写完成".into(),
        })
    }
}

const MAX_SPOKEN_TEXT_CHARS: usize = 520;

fn prepare_spoken_text(text: &str) -> String {
    let (without_fences, had_code_block) = strip_fenced_code_blocks(text);
    let (without_structured_blocks, had_structured_block) =
        replace_inline_structured_blocks(&without_fences);
    let mut lines = Vec::new();
    let mut skipped_code_like_line = false;

    for raw_line in without_structured_blocks.lines() {
        let line = normalize_spoken_line(raw_line);
        if line.is_empty() {
            continue;
        }

        if looks_like_code_or_data_line(&line) {
            skipped_code_like_line = true;
            continue;
        }

        push_unique_line(&mut lines, &line);
    }

    let spoken = lines.join("\n").trim().to_string();
    let removed_non_spoken_content =
        had_code_block || had_structured_block || skipped_code_like_line || looks_code_heavy(text);
    let spoken = if spoken.is_empty() && removed_non_spoken_content {
        String::new()
    } else if spoken.is_empty() {
        text.trim().to_string()
    } else {
        spoken
    };

    limit_spoken_text(&spoken)
}

fn strip_fenced_code_blocks(text: &str) -> (String, bool) {
    let mut output = Vec::new();
    let mut in_fence = false;
    let mut removed = false;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            removed = true;
            in_fence = !in_fence;
            continue;
        }

        if in_fence {
            removed = true;
            continue;
        }

        output.push(line.to_string());
    }

    (output.join("\n"), removed)
}

fn replace_inline_structured_blocks(text: &str) -> (String, bool) {
    let chars = text.chars().collect::<Vec<_>>();
    let mut output = String::new();
    let mut index = 0usize;
    let mut replaced = false;

    while index < chars.len() {
        let ch = chars[index];
        let close = match ch {
            '{' => Some('}'),
            '[' => Some(']'),
            _ => None,
        };

        if let Some(close) = close {
            if let Some(end) = find_balanced_block(&chars, index, ch, close) {
                let snippet = chars[index..=end].iter().collect::<String>();
                if is_structured_snippet(&snippet) {
                    replaced = true;
                    index = end + 1;
                    continue;
                }
            }
        }

        output.push(ch);
        index += 1;
    }

    (output, replaced)
}

fn find_balanced_block(chars: &[char], start: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut quote = '\0';

    for (offset, ch) in chars[start..].iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if *ch == '\\' {
                escaped = true;
            } else if *ch == quote {
                in_string = false;
            }
            continue;
        }

        if *ch == '"' || *ch == '\'' {
            in_string = true;
            quote = *ch;
            continue;
        }

        if *ch == open {
            depth += 1;
        } else if *ch == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(start + offset);
            }
        }
    }

    None
}

fn is_structured_snippet(snippet: &str) -> bool {
    let trimmed = snippet.trim();
    if trimmed.chars().count() < 6 {
        return false;
    }

    (trimmed.starts_with('{') && (trimmed.contains("\":") || trimmed.contains("\\\":")))
        || (trimmed.starts_with('[')
            && (trimmed.contains('{')
                || trimmed.contains("\":")
                || trimmed
                    .chars()
                    .filter(|ch| *ch == ',' || *ch == '"')
                    .count()
                    >= 4))
}

fn normalize_spoken_line(line: &str) -> String {
    let mut normalized = line
        .replace("\\n", " ")
        .replace("\\r", " ")
        .replace("\\t", " ")
        .replace("\\\"", "\"")
        .replace('`', "")
        .replace('\t', " ");

    normalized = normalized
        .trim()
        .trim_start_matches('#')
        .trim_start()
        .to_string();

    for prefix in ["- ", "* ", "+ ", "> "] {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            normalized = rest.trim_start().to_string();
            break;
        }
    }

    collapse_inline_whitespace(&normalized)
}

fn collapse_inline_whitespace(text: &str) -> String {
    let mut output = String::new();
    let mut last_was_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                output.push(' ');
                last_was_space = true;
            }
        } else {
            output.push(ch);
            last_was_space = false;
        }
    }
    output.trim().to_string()
}

fn looks_like_code_or_data_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    let lowered = trimmed.to_ascii_lowercase();
    let code_prefixes = [
        "use ",
        "pub ",
        "fn ",
        "let ",
        "const ",
        "var ",
        "function ",
        "class ",
        "import ",
        "export ",
        "from ",
        "def ",
        "return ",
        "if (",
        "for (",
        "while (",
        "switch (",
        "console.",
        "println!",
        "#include",
        "<script",
        "</",
    ];
    if code_prefixes
        .iter()
        .any(|prefix| lowered.starts_with(prefix))
    {
        return true;
    }

    if trimmed.starts_with('"') && (trimmed.contains("\":") || trimmed.contains("\\\":")) {
        return true;
    }

    if matches!(
        trimmed.chars().next(),
        Some('{') | Some('}') | Some('[') | Some(']')
    ) && (trimmed.contains(':') || trimmed.contains(',') || trimmed.contains('"'))
    {
        return true;
    }

    if trimmed.starts_with('<') && trimmed.ends_with('>') && trimmed.chars().count() > 4 {
        return true;
    }

    if trimmed.contains("=>")
        || trimmed.contains("();")
        || trimmed.contains("::{")
        || trimmed.contains(" = {")
        || trimmed.contains("={")
        || trimmed.contains(" = [")
        || trimmed.contains("=[")
    {
        return true;
    }

    let char_count = trimmed.chars().count();
    if char_count >= 28 {
        let symbol_count = trimmed
            .chars()
            .filter(|ch| {
                ch.is_ascii_punctuation()
                    && !matches!(
                        ch,
                        '.' | ',' | '?' | '!' | ':' | ';' | '\'' | '"' | '-' | '/'
                    )
            })
            .count();
        let has_code_markers = trimmed.contains('{')
            || trimmed.contains('}')
            || trimmed.contains('[')
            || trimmed.contains(']')
            || trimmed.contains("=>")
            || trimmed.contains("</")
            || trimmed.contains(");")
            || trimmed.contains("\":");
        if has_code_markers && symbol_count * 100 / char_count >= 12 {
            return true;
        }
    }

    false
}

fn looks_code_heavy(text: &str) -> bool {
    let char_count = text.chars().filter(|ch| !ch.is_whitespace()).count();
    if char_count < 20 {
        return false;
    }

    let marker_count = text
        .chars()
        .filter(|ch| matches!(ch, '{' | '}' | '[' | ']' | '<' | '>' | '`' | ';' | '='))
        .count();
    marker_count * 100 / char_count >= 18
}

fn push_unique_line(lines: &mut Vec<String>, value: &str) {
    if value.trim().is_empty() {
        return;
    }
    if lines.last().is_some_and(|last| last == value) {
        return;
    }
    lines.push(value.to_string());
}

fn limit_spoken_text(text: &str) -> String {
    if text.chars().count() <= MAX_SPOKEN_TEXT_CHARS {
        return text.to_string();
    }

    let mut output = text
        .chars()
        .take(MAX_SPOKEN_TEXT_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string();
    output.push_str("……后面内容保留在文本里，不继续朗读。");
    output
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

/// Emotions the Live2D overlay knows how to render (maps to motion groups in
/// `apps/web/overlays/live2d.html`). The model may tag a reply with one of
/// these; anything else falls back to `normal`.
const SUPPORTED_EMOTIONS: [&str; 6] = ["happy", "excited", "angry", "sad", "surprised", "normal"];

/// Extracts a leading inline emotion tag (e.g. `[happy] ...`) from a model
/// reply, returning `(emotion, text_without_tag)`. The model is prompted to
/// optionally prefix a line with such a tag; when present we honor it (this is
/// the model-driven path), when absent or unrecognized we fall back to the
/// keyword heuristic so older/untagged replies still animate.
///
/// Only a tag at the very start is consumed, and only when it names a supported
/// emotion — so a reply that legitimately opens with "[some note]" is left
/// intact and spoken as written.
fn resolve_emotion(text: &str) -> (String, String) {
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some(close) = rest.find(']') {
            let tag = rest[..close].trim().to_ascii_lowercase();
            if SUPPORTED_EMOTIONS.contains(&tag.as_str()) {
                let body = rest[close + 1..].trim_start().to_string();
                // If stripping the tag leaves nothing, keep the original text so
                // we never dispatch an empty utterance for a tag-only line.
                if body.is_empty() {
                    return (tag, text.to_string());
                }
                return (tag, body);
            }
        }
    }
    (infer_emotion(text), text.to_string())
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
        let already_near_end = cues
            .iter()
            .any(|c| c.at_ms > duration_ms.saturating_sub(500));
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
    if (lower.contains("像") || lower.contains("就像") || lower.contains("比如")) && char_count > 40
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
    if let Some(endpoint) = config
        .endpoint
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        return endpoint.trim().trim_end_matches('/').to_string();
    }

    match adapter_id {
        "sovits" => "http://127.0.0.1:9880".into(),
        _ => "http://127.0.0.1:9881".into(),
    }
}

fn tts_health_path<'a>(config: &'a TtsConfig, adapter_id: &str) -> &'a str {
    if let Some(path) = config
        .health_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
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

fn normalized_stt_provider(config: &SttConfig) -> String {
    config
        .provider
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "faster_whisper".into())
}

fn select_stt_adapter(config: &SttConfig) -> Option<&'static str> {
    match normalized_stt_provider(config).as_str() {
        "faster_whisper" => Some("faster_whisper"),
        _ => None,
    }
}

fn stt_endpoint(config: &SttConfig) -> String {
    if let Some(endpoint) = config
        .endpoint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return endpoint.trim_end_matches('/').to_string();
    }

    match normalized_stt_provider(config).as_str() {
        "openai_compatible" => String::new(),
        _ => "http://127.0.0.1:9882/transcribe".into(),
    }
}

fn stt_health_endpoint(config: &SttConfig) -> String {
    let endpoint = stt_endpoint(config);
    if endpoint.is_empty() {
        return endpoint;
    }
    if let Some(base) = endpoint.strip_suffix("/transcribe") {
        return format!("{base}/health");
    }
    format!("{endpoint}/health")
}

fn stt_model(config: &SttConfig) -> String {
    config
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| match normalized_stt_provider(config).as_str() {
            "openai_compatible" => "whisper-1".into(),
            _ => "small".into(),
        })
}

const STT_PREWARM_CACHE_TTL: Duration = Duration::from_secs(600);

type SttPrewarmCache = Arc<Mutex<HashMap<String, Instant>>>;

fn stt_prewarm_cache() -> &'static SttPrewarmCache {
    static CACHE: OnceLock<SttPrewarmCache> = OnceLock::new();
    CACHE.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn stt_prewarm_cache_key(config: &SttConfig) -> String {
    format!(
        "{}|{}|{}",
        normalized_stt_provider(config),
        stt_endpoint(config),
        stt_model(config)
    )
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

async fn wait_for_stt_worker(health_url: &str) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;

    let mut last_error = None;
    for _ in 0..40 {
        match client.get(health_url).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
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
        "timed out waiting for stt worker at {health_url}: {}",
        last_error.unwrap_or_else(|| "unknown error".into())
    ))
}

fn generate_silence_wav(sample_rate_hz: u32, frame_count: usize) -> Vec<u8> {
    let channels = 1u16;
    let bits_per_sample = 16u16;
    let bytes_per_sample = (bits_per_sample / 8) as usize;
    let data_len = frame_count * channels as usize * bytes_per_sample;
    let mut wav = Vec::with_capacity(44 + data_len);

    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate_hz.to_le_bytes());
    let byte_rate = sample_rate_hz * channels as u32 * (bits_per_sample as u32 / 8);
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    let block_align = channels * (bits_per_sample / 8);
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_len as u32).to_le_bytes());
    wav.resize(44 + data_len, 0u8);

    wav
}

const DEFAULT_VISION_PROMPT: &str = "你是一个虚拟主播的“眼睛”。用一句自然的中文口语描述这张画面里正在发生什么，抓住最值得吐槽或反应的点。不要罗列细节，不要说“这张图片”，直接描述内容，20字以内。";

impl VisionService {
    pub fn new(config: VisionConfig) -> Self {
        Self {
            config: Arc::new(StdRwLock::new(config)),
        }
    }

    pub fn update_runtime_config(&self, config: VisionConfig) {
        if let Ok(mut guard) = self.config.write() {
            *guard = config;
        }
    }

    pub fn current_config(&self) -> VisionConfig {
        self.config
            .read()
            .ok()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn is_enabled(&self) -> bool {
        self.current_config().enabled
    }

    pub fn ttl_turns(&self) -> u32 {
        self.current_config().ttl_turns.unwrap_or(3).clamp(1, 30)
    }

    /// Describe a single frame using the currently configured vision model.
    /// `config` is passed explicitly so the test endpoint can probe an unsaved
    /// draft without mutating runtime state.
    pub async fn describe(
        &self,
        config: &VisionConfig,
        request: &VisionObserveRequest,
    ) -> Result<VisionObserveResponse> {
        let started = Instant::now();
        let endpoint = config
            .endpoint
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("vision endpoint 未配置"))?;

        let image = request.image_base64.trim();
        if image.is_empty() {
            return Err(anyhow::anyhow!("empty image payload"));
        }
        let mime = request
            .mime_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("image/jpeg");
        let data_url = format!("data:{mime};base64,{image}");

        let instruction = config
            .prompt
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_VISION_PROMPT);
        let mode_hint = match request.mode.as_deref() {
            Some("stream") => "\n（画面来源：主播自己的直播/游戏画面）",
            Some("desktop") | Some("monitor") => "\n（画面来源：操作员的桌面）",
            _ => "",
        };
        let user_text = format!("{instruction}{mode_hint}");

        let model = config
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("gpt-4o-mini");
        let timeout_ms = config.timeout_ms.unwrap_or(20_000);
        let max_tokens = config.max_tokens.unwrap_or(200);

        let payload = serde_json::json!({
            "model": model,
            "max_tokens": max_tokens,
            "temperature": 0.4,
            "stream": false,
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": user_text },
                    { "type": "image_url", "image_url": { "url": data_url } }
                ]
            }]
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()?;
        let mut builder = client.post(endpoint).json(&payload);
        if let Some(key) = config
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            builder = builder.bearer_auth(key);
        }

        let response = builder.send().await?;
        let status = response.status();
        let raw = response.text().await?;
        if !status.is_success() {
            let preview = raw.chars().take(260).collect::<String>();
            return Err(anyhow::anyhow!("vision status {status}: {preview}"));
        }
        let parsed: Value = serde_json::from_str(&raw)?;
        // Some OpenAI-compatible gateways return 2xx with an inline error body
        // (e.g. "model not found", "unsupported image"). Surface that instead
        // of a generic "no text content".
        if let Some(err_msg) = parsed
            .pointer("/error/message")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            return Err(anyhow::anyhow!("模型返回错误：{err_msg}"));
        }
        // finish_reason length/content_filter 也算值得告诉用户的事。
        if let Some(reason) = parsed
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
        {
            if reason == "content_filter" {
                return Err(anyhow::anyhow!("模型内容审核拦截了这次识别"));
            }
        }
        // 模型可能正常响应但没给文本（比如 1x1 探测图被忽略）。连通测试时这算成功。
        let description = extract_vision_description(&parsed).unwrap_or_default();
        let message = if description.trim().is_empty() {
            "模型已响应，但未返回描述文本".to_string()
        } else {
            "画面识别完成".to_string()
        };

        Ok(VisionObserveResponse {
            ok: true,
            description,
            latency_ms: Some(started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
            applied: false,
            message,
        })
    }
}

/// Pull the assistant text out of an OpenAI-compatible chat/completions
/// response, tolerating both string and multi-part array `content`.
/// Returns None when the model returned no usable text (e.g. empty content
/// on a 1x1 probe image). Callers decide whether that's a hard failure.
fn extract_vision_description(payload: &Value) -> Option<String> {
    if let Some(text) = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        let trimmed = collapse_vision_whitespace(text);
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    if let Some(parts) = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_array)
    {
        let text = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        let trimmed = collapse_vision_whitespace(&text);
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    None
}

fn collapse_vision_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::{Duration, Instant};

    use api_types::{
        AdapterStatus, ChatResponse, Live2dAnimationPlan, Live2dSpeechRecord,
        SpeechPlaybackPlan, TtsSpeakRequest,
    };
    use app_config::TtsConfig;
    use chrono::Utc;
    use orchestrator::RuntimeBus;
    use python_adapters::TtsAdapterSupervisor;
    use serde_json::{Value, json};
    use storage::{NewAdapterRunRecord, Storage};
    use tempfile::tempdir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::Mutex;
    use uuid::Uuid;

    use super::{
        ChatResponseFinalizer, Live2dSpeechQueue, SessionTurnGuard, TtsService,
        build_tts_request_payload, select_tts_adapter,
        tts_endpoint, tts_health_path, wait_for_tts_worker,
    };

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> (String, Vec<u8>) {
        let mut buffer = Vec::new();
        let header_end = loop {
            let mut chunk = [0u8; 1024];
            let read = socket.read(&mut chunk).await.expect("read request");
            assert!(read > 0, "socket closed before request headers completed");
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                break position + 4;
            }
        };

        let headers = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);

        while buffer.len() < header_end + content_length {
            let mut chunk = [0u8; 1024];
            let read = socket.read(&mut chunk).await.expect("read request body");
            assert!(read > 0, "socket closed before request body completed");
            buffer.extend_from_slice(&chunk[..read]);
        }

        (
            headers,
            buffer[header_end..header_end + content_length].to_vec(),
        )
    }

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
    fn tts_endpoint_falls_back_to_static_local_defaults() {
        let config = TtsConfig::default();

        assert_eq!(tts_endpoint(&config, "sovits"), "http://127.0.0.1:9880");
        assert_eq!(tts_endpoint(&config, "edge_tts"), "http://127.0.0.1:9881");
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
    fn spoken_text_deletes_inline_json_memory_payloads() {
        let raw = "memory snapshot: memorable_moment: {\"moment\":\"观众说不要念 operator_acknowledged 和内部字段\", \"source\":\"danmaku-batch\"}";
        let spoken = super::prepare_spoken_text(raw);

        assert!(spoken.contains("memory snapshot"));
        assert!(!spoken.contains("结构化数据已省略朗读"));
        assert!(!spoken.contains("\"moment\""));
        assert!(!spoken.contains("\"source\""));
        assert!(!spoken.contains("operator_acknowledged"));
        assert!(!spoken.contains('{'));
        assert!(!spoken.contains('}'));
    }

    #[tokio::test]
    async fn live2d_speech_queue_cancel_marks_active_items_failed() {
        let queue = Live2dSpeechQueue::new(RuntimeBus::new(), SessionTurnGuard::new());
        let base_speech = SpeechPlaybackPlan {
            request_id: "speech-1".into(),
            status: "ready".into(),
            audio_url: Some("/api/audio/speech-1".into()),
            duration_ms: 1200,
            viseme_timeline: Vec::new(),
            error: None,
        };
        let base_animation = Live2dAnimationPlan {
            emotion: "normal".into(),
            subtitle_text: "测试".into(),
            motion_timeline: Vec::new(),
        };

        queue
            .enqueue(Live2dSpeechRecord {
                id: "speech-1".into(),
                session_id: "session-a".into(),
                message_id: Uuid::new_v4(),
                assistant_text: "第一条".into(),
                speech: base_speech.clone(),
                animation: base_animation.clone(),
                status: "pending".into(),
                created_at: Utc::now(),
            })
            .await;
        queue
            .enqueue(Live2dSpeechRecord {
                id: "speech-2".into(),
                session_id: "session-a".into(),
                message_id: Uuid::new_v4(),
                assistant_text: "第二条".into(),
                speech: SpeechPlaybackPlan {
                    request_id: "speech-2".into(),
                    ..base_speech
                },
                animation: base_animation,
                status: "pending".into(),
                created_at: Utc::now(),
            })
            .await;

        let playing = queue.next().await.expect("first item should be claimable");
        assert_eq!(playing.id, "speech-1");
        assert_eq!(playing.status, "playing");

        let cancelled = queue.cancel(Some("session-a"), Some("manual interrupt")).await;
        assert_eq!(cancelled, 2);
        assert!(!queue.has_active().await);
        assert!(queue.next().await.is_none());
    }

    #[tokio::test]
    async fn stale_turn_speech_is_dropped_before_playback() {
        let runtime_bus = RuntimeBus::new();
        let turn_guard = SessionTurnGuard::new();
        let queue = Live2dSpeechQueue::new(runtime_bus, turn_guard.clone());
        let generation_1 = turn_guard.begin_turn("session-a").await;
        let generation_2 = turn_guard.interrupt("session-a").await;

        assert!(generation_2 > generation_1);

        queue
            .enqueue_with_turn(
                Live2dSpeechRecord {
                    id: "speech-stale".into(),
                    session_id: "session-a".into(),
                    message_id: Uuid::new_v4(),
                    assistant_text: "过期回复".into(),
                    speech: SpeechPlaybackPlan {
                        request_id: "speech-stale".into(),
                        status: "ready".into(),
                        audio_url: Some("/api/audio/speech-stale".into()),
                        duration_ms: 800,
                        viseme_timeline: Vec::new(),
                        error: None,
                    },
                    animation: Live2dAnimationPlan {
                        emotion: "normal".into(),
                        subtitle_text: "过期回复".into(),
                        motion_timeline: Vec::new(),
                    },
                    status: "pending".into(),
                    created_at: Utc::now(),
                },
                Some(generation_1),
            )
            .await;

        assert!(queue.next().await.is_none());
        assert_eq!(turn_guard.current("session-a").await, generation_2);
    }

    #[test]
    fn speech_failure_detail_keeps_speech_id_for_overlay_interrupts() {
        assert_eq!(
            super::format_speech_failure_detail("speech-123", Some("manual interrupt")),
            "speech-123::manual interrupt"
        );
        assert_eq!(
            super::format_speech_failure_detail("speech-123", None),
            "speech-123"
        );
    }

    #[tokio::test]
    async fn finalizer_does_not_send_markdown_code_blocks_to_tts_or_live2d() {
        let captured_text = Arc::new(Mutex::new(None::<String>));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind tts test listener");
        let addr = listener.local_addr().expect("listener addr");
        let captured_text_for_server = Arc::clone(&captured_text);
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept request");
                let (headers, body) = read_http_request(&mut socket).await;
                let request_line = headers.lines().next().unwrap_or_default().to_string();

                if request_line.starts_with("GET /voices ") {
                    socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n[]",
                        )
                        .await
                        .expect("write health response");
                    continue;
                }

                if request_line.starts_with("POST /tts ") {
                    let payload: Value =
                        serde_json::from_slice(&body).expect("parse tts request payload");
                    *captured_text_for_server.lock().await = payload
                        .get("text")
                        .and_then(|value| value.as_str())
                        .map(str::to_string);
                    socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: audio/mpeg\r\ncontent-length: 4\r\nconnection: close\r\n\r\nFAKE",
                        )
                        .await
                        .expect("write audio response");
                    continue;
                }

                panic!("unexpected request line: {request_line}");
            }
        });

        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("media.db"))
            .await
            .expect("storage");
        storage
            .create_adapter_run(NewAdapterRunRecord {
                adapter_id: "edge_tts".into(),
                status: AdapterStatus::Running,
                python_executable: "python".into(),
                args: Vec::new(),
                pid: Some(std::process::id()),
                last_error: None,
            })
            .await
            .expect("seed running adapter");

        let runtime_bus = RuntimeBus::new();
        let adapter_storage = storage.clone();
        let tts = TtsService::new(
            storage,
            TtsAdapterSupervisor::new(
                adapter_storage,
                "python",
                dir.path().join("models"),
                runtime_bus.clone(),
            ),
            runtime_bus.clone(),
            false,
            dir.path().join("audio"),
            TtsConfig {
                provider: Some("edge_tts".into()),
                endpoint: Some(format!("http://{addr}")),
                health_path: Some("/voices".into()),
                chat_voice: Some("edge-tts-zh".into()),
                speech_rate: None,
            },
        );
        let session_turn_guard = SessionTurnGuard::new();
        let queue = Live2dSpeechQueue::new(runtime_bus.clone(), session_turn_guard.clone());
        let finalizer = ChatResponseFinalizer::new(tts, runtime_bus, queue.clone(), session_turn_guard);
        let raw_text = "可以，先看这个片段：\n```ts\nconst secret = '不要朗读';\nconsole.log(secret);\n```\n结论：保留文本展示，但语音跳过代码。";
        let response = ChatResponse {
            session_id: "code-session".into(),
            message_id: Uuid::new_v4(),
            assistant_text: raw_text.into(),
            created_at: Utc::now(),
            speech: SpeechPlaybackPlan {
                request_id: Uuid::new_v4().to_string(),
                status: "not_requested".into(),
                audio_url: None,
                duration_ms: 0,
                viseme_timeline: Vec::new(),
                error: None,
            },
            animation: Live2dAnimationPlan {
                emotion: "normal".into(),
                subtitle_text: String::new(),
                motion_timeline: Vec::new(),
            },
            events: Vec::new(),
            timing: None,
        };

        let finalized = finalizer.finalize(response, None).await.expect("finalize");
        // TTS now always dispatches off the request path, so poll for the
        // background task to capture the spoken text.
        let spoken = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(text) = captured_text.lock().await.clone() {
                    break text;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("captured tts text before timeout");

        assert_eq!(finalized.assistant_text, raw_text);
        assert!(spoken.contains("可以，先看这个片段"));
        assert!(!spoken.contains("代码片段已省略朗读"));
        assert!(spoken.contains("结论：保留文本展示"));
        assert!(!spoken.contains("```"));
        assert!(!spoken.contains("const secret"));
        assert!(!spoken.contains("console.log"));
        assert!(!spoken.contains("不要朗读"));
        assert_eq!(finalized.animation.subtitle_text, spoken);

        let queued = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(item) = queue.next().await {
                    break item;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("queued live2d item before timeout");
        assert_eq!(queued.assistant_text, spoken);
        assert!(!queued.assistant_text.contains("const secret"));

        server.abort();
    }

    #[tokio::test]
    async fn direct_tts_enqueue_sanitizes_code_before_worker_dispatch() {
        let captured_text = Arc::new(Mutex::new(None::<String>));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind tts test listener");
        let addr = listener.local_addr().expect("listener addr");
        let captured_text_for_server = Arc::clone(&captured_text);
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept request");
                let (headers, body) = read_http_request(&mut socket).await;
                let request_line = headers.lines().next().unwrap_or_default().to_string();

                if request_line.starts_with("GET /voices ") {
                    socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n[]",
                        )
                        .await
                        .expect("write health response");
                    continue;
                }

                if request_line.starts_with("POST /tts ") {
                    let payload: Value =
                        serde_json::from_slice(&body).expect("parse tts request payload");
                    *captured_text_for_server.lock().await = payload
                        .get("text")
                        .and_then(|value| value.as_str())
                        .map(str::to_string);
                    socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: audio/mpeg\r\ncontent-length: 4\r\nconnection: close\r\n\r\nFAKE",
                        )
                        .await
                        .expect("write audio response");
                    continue;
                }

                panic!("unexpected request line: {request_line}");
            }
        });

        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("media.db"))
            .await
            .expect("storage");
        storage
            .create_adapter_run(NewAdapterRunRecord {
                adapter_id: "edge_tts".into(),
                status: AdapterStatus::Running,
                python_executable: "python".into(),
                args: Vec::new(),
                pid: Some(std::process::id()),
                last_error: None,
            })
            .await
            .expect("seed running adapter");

        let runtime_bus = RuntimeBus::new();
        let adapter_storage = storage.clone();
        let tts = TtsService::new(
            storage,
            TtsAdapterSupervisor::new(
                adapter_storage,
                "python",
                dir.path().join("models"),
                runtime_bus.clone(),
            ),
            runtime_bus,
            false,
            dir.path().join("audio"),
            TtsConfig {
                provider: Some("edge_tts".into()),
                endpoint: Some(format!("http://{addr}")),
                health_path: Some("/voices".into()),
                chat_voice: Some("edge-tts-zh".into()),
                speech_rate: None,
            },
        );

        tts.enqueue(TtsSpeakRequest {
            session_id: Some("direct-tts".into()),
            text: "请播报：\n```rs\nfn main() { println!(\"不要念\"); }\n```\n只读结论。".into(),
            voice: Some("edge-tts-zh".into()),
        })
        .await
        .expect("tts enqueue");

        let spoken = captured_text
            .lock()
            .await
            .clone()
            .expect("captured tts text");

        assert!(spoken.contains("请播报"));
        assert!(!spoken.contains("代码片段已省略朗读"));
        assert!(spoken.contains("只读结论"));
        assert!(!spoken.contains("fn main"));
        assert!(!spoken.contains("println"));
        assert!(!spoken.contains("不要念"));

        server.abort();
    }

    #[tokio::test]
    async fn background_finalize_uses_voice_snapshot_from_request_start() {
        let captured_voice = Arc::new(Mutex::new(None::<String>));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind tts test listener");
        let addr = listener.local_addr().expect("listener addr");
        let voice_for_server = Arc::clone(&captured_voice);
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept request");
                let (headers, body) = read_http_request(&mut socket).await;
                let request_line = headers.lines().next().unwrap_or_default().to_string();

                if request_line.starts_with("GET /voices ") {
                    socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n[]",
                        )
                        .await
                        .expect("write health response");
                    continue;
                }

                if request_line.starts_with("POST /tts ") {
                    let payload: Value =
                        serde_json::from_slice(&body).expect("parse tts request payload");
                    *voice_for_server.lock().await = payload
                        .get("voice")
                        .and_then(|value| value.as_str())
                        .map(str::to_string);
                    socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: audio/mpeg\r\ncontent-length: 4\r\nconnection: close\r\n\r\nFAKE",
                        )
                        .await
                        .expect("write audio response");
                    continue;
                }

                panic!("unexpected request line: {request_line}");
            }
        });

        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("media.db"))
            .await
            .expect("storage");
        storage
            .create_adapter_run(NewAdapterRunRecord {
                adapter_id: "edge_tts".into(),
                status: AdapterStatus::Running,
                python_executable: "python".into(),
                args: Vec::new(),
                pid: Some(std::process::id()),
                last_error: None,
            })
            .await
            .expect("seed running adapter");

        let runtime_bus = RuntimeBus::new();
        let adapter_storage = storage.clone();
        let tts = TtsService::new(
            storage,
            TtsAdapterSupervisor::new(
                adapter_storage,
                "python",
                dir.path().join("models"),
                runtime_bus.clone(),
            ),
            runtime_bus.clone(),
            false,
            dir.path().join("audio"),
            TtsConfig {
                provider: Some("edge_tts".into()),
                endpoint: Some(format!("http://{addr}")),
                health_path: Some("/voices".into()),
                chat_voice: Some("base-voice".into()),
                speech_rate: None,
            },
        );
        let session_turn_guard = SessionTurnGuard::new();
        let finalizer = ChatResponseFinalizer::new(
            tts.clone(),
            runtime_bus.clone(),
            Live2dSpeechQueue::new(runtime_bus, session_turn_guard.clone()),
            session_turn_guard,
        );

        tts.set_voice_override(Some("voice-a".into()));
        let response = ChatResponse {
            session_id: "session-1".into(),
            message_id: Uuid::new_v4(),
            assistant_text: "runtime ok: messages=1, profiles=1, memories=1, configs=1".into(),
            created_at: Utc::now(),
            speech: SpeechPlaybackPlan {
                request_id: Uuid::new_v4().to_string(),
                status: "not_requested".into(),
                audio_url: None,
                duration_ms: 0,
                viseme_timeline: Vec::new(),
                error: None,
            },
            animation: Live2dAnimationPlan {
                emotion: "normal".into(),
                subtitle_text: String::new(),
                motion_timeline: Vec::new(),
            },
            events: Vec::new(),
            timing: None,
        };

        finalizer
            .finalize(response, None)
            .await
            .expect("background finalize");
        tts.set_voice_override(Some("voice-b".into()));

        let voice = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(voice) = captured_voice.lock().await.clone() {
                    break voice;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("voice capture timeout");

        assert_eq!(voice, "voice-a");
        server.abort();
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
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nOK",
                    )
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
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nOK",
                    )
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
        assert!(
            has_flip_up,
            "transition word '但是' should trigger FlickUp motion"
        );
    }

    #[test]
    fn motion_timeline_triggers_on_question_end() {
        let text = "你要的话我可以先把最危险的 race 拆出来？";
        let cues = super::build_motion_timeline(text, "normal", 3000);
        let has_flick_down = cues.iter().any(|c| c.motion == "FlickDown");
        assert!(
            has_flick_down,
            "question-ending word should trigger FlickDown motion"
        );
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

    #[test]
    fn resolve_emotion_honors_leading_tag_and_strips_it() {
        let (emotion, body) = super::resolve_emotion("[happy] 今天真开心呀");
        assert_eq!(emotion, "happy");
        assert_eq!(body, "今天真开心呀");
    }

    #[test]
    fn resolve_emotion_accepts_excited_which_heuristic_never_emits() {
        let (emotion, body) = super::resolve_emotion("[excited]冲冲冲！");
        assert_eq!(emotion, "excited");
        assert_eq!(body, "冲冲冲！");
    }

    #[test]
    fn resolve_emotion_falls_back_to_heuristic_without_tag() {
        let (emotion, body) = super::resolve_emotion("这也太棒了吧！");
        assert_eq!(emotion, "happy");
        assert_eq!(body, "这也太棒了吧！");
    }

    #[test]
    fn resolve_emotion_ignores_unknown_tag_and_keeps_text_intact() {
        // A bracketed opener that is not a supported emotion must be left in the
        // spoken text, not silently stripped.
        let (emotion, body) = super::resolve_emotion("[备注] 这是一句话");
        assert_eq!(emotion, "normal");
        assert_eq!(body, "[备注] 这是一句话");
    }

    #[test]
    fn resolve_emotion_keeps_original_when_tag_leaves_empty_body() {
        let (emotion, body) = super::resolve_emotion("[happy]");
        assert_eq!(emotion, "happy");
        assert_eq!(body, "[happy]");
    }
}
