pub mod persona;
pub mod runtime_bus;

mod chat_engine;
mod heuristics;
mod prompt;
mod text;

use std::{collections::HashMap, env, path::PathBuf, sync::Arc, time::Duration};

use anyhow::Result;
use api_types::{
    ChatRequest, ChatResponse, Live2dAnimationPlan, MessageRole, MotionCue, RuntimeEvent,
    RuntimeEventKind, SessionEvent, SessionEventKind, SpeechPlaybackPlan,
};
use app_config::LlmConfig;
use storage::{NewMessageRecord, Storage};
use tokio::sync::{RwLock, broadcast, mpsc::UnboundedSender};
use uuid::Uuid;

pub use runtime_bus::RuntimeBus;

use chat_engine::{ChatEngine, RemoteModelConfig};
// heuristics functions removed — LLM handles mood/fact/sentiment via prompt
use prompt::{build_session_summary, render_system_prompt};
use text::summarize_text;

#[cfg(test)]
use chat_engine::extract_response_text;
#[cfg(test)]
use heuristics::built_in_response;
#[cfg(test)]
use prompt::build_remote_messages;

const DEFAULT_MODEL: &str = "Qwen/Qwen2.5-7B-Instruct";
const DEFAULT_REMOTE_TIMEOUT_MS: u64 = 15_000;
const DEFAULT_REMOTE_FALLBACK_TIMEOUT_MS: u64 = 5_000;
const MAX_HISTORY_MESSAGES: usize = 12;
const MAX_MEMORY_SNIPPETS: usize = 4;
const MAX_REPLY_CHARS: usize = 900;
const DEFAULT_TONE_PROFILE: &str = "balanced";

/// Load persona canon from `MEMORY_SUITE_PERSONA_CANON_PATH` env var or the
/// default repo-relative path. Falls back to an empty canon on any error so
/// the runtime never hard-fails due to a missing file.
fn load_persona_canon() -> persona::PersonaCanon {
    let path = env::var("MEMORY_SUITE_PERSONA_CANON_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            // Resolve relative to the manifest dir at compile time, then fall
            // back to a runtime-relative path for deployed builds.
            let compile_time = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../data/memories/global/PERSONA_CANON.md");
            if compile_time.exists() {
                compile_time
            } else {
                PathBuf::from("data/memories/global/PERSONA_CANON.md")
            }
        });

    match std::fs::read_to_string(&path) {
        Ok(src) => match persona::PersonaCanon::parse(&src) {
            Ok(canon) => {
                tracing::info!(path = %path.display(), "persona canon loaded");
                canon
            }
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "failed to parse persona canon, using defaults");
                persona::PersonaCanon::default()
            }
        },
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "persona canon file not found, using defaults");
            persona::PersonaCanon::default()
        }
    }
}

fn fallback_voice_reply_when_model_silent(request: &ChatRequest) -> Option<String> {
    let user_id = request.user_id.as_deref()?.trim();
    if user_id != "voice" || request.text.trim().is_empty() {
        return None;
    }
    Some("我听到了，但主模型这轮没有给出内容。".into())
}

#[derive(Clone)]
pub struct Orchestrator {
    storage: Storage,
    runtime_bus: RuntimeBus,
    sessions: Arc<RwLock<HashMap<String, broadcast::Sender<SessionEvent>>>>,
    chat_engine: ChatEngine,
    persona_canon: Arc<persona::PersonaCanon>,
}

impl Orchestrator {
    pub fn new(storage: Storage, runtime_bus: RuntimeBus) -> Self {
        let canon = load_persona_canon();
        Self {
            storage,
            runtime_bus,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            chat_engine: ChatEngine::from_env(),
            persona_canon: Arc::new(canon),
        }
    }

    /// Shared persona canon loaded once at startup (respects
    /// `MEMORY_SUITE_PERSONA_CANON_PATH`). Use this instead of re-reading
    /// the canon file from disk.
    pub fn persona_canon(&self) -> Arc<persona::PersonaCanon> {
        self.persona_canon.clone()
    }

    pub fn apply_llm_config(&self, llm: &LlmConfig) {
        self.chat_engine.apply_llm_config(llm);
    }

    pub async fn test_llm_config(&self, llm: &LlmConfig, prompt: &str) -> Result<String> {
        self.chat_engine.test_config(llm, prompt).await
    }

    /// Render the system prompt that would be sent for a given user_id and
    /// input text. Intended for tests and debug tooling only.
    pub async fn debug_render_prompt(&self, user_id: &str, text: &str) -> Result<String> {
        let tone_profile = self
            .storage
            .get_persona_runtime_state()
            .await
            .map(|s| s.tone_profile)
            .unwrap_or_else(|_| DEFAULT_TONE_PROFILE.into());

        let fake_remote = RemoteModelConfig {
            endpoint: String::new(),
            model: DEFAULT_MODEL.into(),
            api_key: None,
            temperature: 0.65,
            max_tokens: 420,
        };
        let fake_request = ChatRequest {
            session_id: None,
            user_id: Some(user_id.into()),
            text: text.into(),
        };
        Ok(render_system_prompt(
            &fake_remote,
            &fake_request,
            &[],
            &self.persona_canon,
            &tone_profile,
            "idle",
            None,
            None,
        ))
    }

    pub async fn handle_chat(&self, request: ChatRequest) -> Result<ChatResponse> {
        self.handle_chat_with_scene(request, None).await
    }

    pub async fn handle_chat_with_scene(
        &self,
        request: ChatRequest,
        scene_hint: Option<String>,
    ) -> Result<ChatResponse> {
        self.handle_chat_inner(request, scene_hint, None).await
    }

    /// Streaming variant: identical turn handling to [`handle_chat_with_scene`]
    /// but the reply is generated over SSE and each completed sentence is sent
    /// to `sentence_tx` as soon as it is ready, so the caller can begin TTS on
    /// sentence 1 while the model is still producing later sentences. The
    /// returned [`ChatResponse`] still carries the full assembled text (for the
    /// transcript/subtitle); the caller owns speech-plan assembly from the
    /// streamed sentences.
    pub async fn handle_chat_with_scene_streaming(
        &self,
        request: ChatRequest,
        scene_hint: Option<String>,
        sentence_tx: UnboundedSender<String>,
    ) -> Result<ChatResponse> {
        self.handle_chat_inner(request, scene_hint, Some(sentence_tx))
            .await
    }

    async fn handle_chat_inner(
        &self,
        request: ChatRequest,
        scene_hint: Option<String>,
        sentence_tx: Option<UnboundedSender<String>>,
    ) -> Result<ChatResponse> {
        let session_id = request
            .session_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let request_preview = request.text.chars().take(60).collect::<String>();
        let handle_started = std::time::Instant::now();

        let persist_user_started = std::time::Instant::now();
        self.storage
            .append_message(NewMessageRecord {
                session_id: session_id.clone(),
                role: MessageRole::User,
                text: request.text.clone(),
            })
            .await?;
        let persist_user_elapsed = persist_user_started.elapsed();

        let load_context_started = std::time::Instant::now();
        let history = self
            .storage
            .list_messages(&session_id)
            .await
            .unwrap_or_default();
        let memory_entries = if let Some(user_id) = request.user_id.as_deref() {
            self.storage
                .list_memory_entries(Some(user_id), MAX_MEMORY_SNIPPETS as u32)
                .await
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let runtime_counts = self.storage.runtime_counts().await.ok();
        let (tone_profile, current_context, current_mood) = self
            .storage
            .get_persona_runtime_state()
            .await
            .map(|s| (s.tone_profile, s.current_context, s.current_mood))
            .unwrap_or_else(|_| (DEFAULT_TONE_PROFILE.into(), "idle".into(), "neutral".into()));

        let (relationship_hint, is_reconnect) = if let Some(user_id) = request.user_id.as_deref() {
            self.prepare_relationship_context(user_id).await
        } else {
            (None, false)
        };

        // Detect long-absence reconnect: if user hasn't chatted in >30 min,
        // prepend a session recap hint to the scene_hint
        let scene_hint = if let Some(user_id) = request.user_id.as_deref() {
            if is_reconnect {
                // Find most recent session summary for this user
                let summaries = self
                    .storage
                    .list_memory_entries(Some(user_id), 3)
                    .await
                    .unwrap_or_default();
                let recap = summaries
                    .iter()
                    .filter(|e| e.entry_type == "session_summary")
                    .next()
                    .and_then(|e| e.payload.get("summary").and_then(|v| v.as_str()))
                    .map(|s| {
                        format!(
                            "User is returning after >30 minutes. Last time you talked about: {}",
                            summarize_text(s, 150)
                        )
                    });
                match (recap, scene_hint) {
                    (Some(r), Some(s)) => Some(format!("{r}\n{s}")),
                    (Some(r), None) => Some(r),
                    (None, s) => s,
                }
            } else {
                scene_hint
            }
        } else {
            scene_hint
        };

        // Check for topic callback: if current input matches a memorable_moment
        let scene_hint = {
            let moments = self
                .storage
                .list_memory_entries(None, 10)
                .await
                .unwrap_or_default();
            let input_words: Vec<&str> = request.text.split_whitespace().take(5).collect();
            let matching_moment = moments.iter()
                .filter(|e| e.entry_type == "memorable_moment")
                .find(|e| {
                    let moment_text = e.payload.get("moment")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    input_words.iter().any(|word| word.chars().count() >= 2 && moment_text.contains(*word))
                })
                .and_then(|e| e.payload.get("moment").and_then(|v| v.as_str()))
                .map(|m| format!("Callback opportunity: this topic relates to a previous memorable exchange: \"{}\". You may naturally reference it if it fits.", m.chars().take(60).collect::<String>()));

            match (matching_moment, scene_hint) {
                (Some(cb), Some(s)) => Some(format!("{s}\n{cb}")),
                (Some(cb), None) => Some(cb),
                (_, s) => s,
            }
        };

        let load_context_elapsed = load_context_started.elapsed();

        let generate_started = std::time::Instant::now();
        let context_arg = format!("{current_context}|mood:{current_mood}");
        let mut response_text = if let Some(ref sentence_tx) = sentence_tx {
            self.chat_engine
                .generate_streaming(
                    &request,
                    &history,
                    &memory_entries,
                    runtime_counts,
                    &self.persona_canon,
                    &tone_profile,
                    &context_arg,
                    relationship_hint.as_deref(),
                    scene_hint.as_deref(),
                    &self.storage,
                    sentence_tx,
                )
                .await?
        } else {
            self.chat_engine
                .generate(
                    &request,
                    &history,
                    &memory_entries,
                    runtime_counts,
                    &self.persona_canon,
                    &tone_profile,
                    &context_arg,
                    relationship_hint.as_deref(),
                    scene_hint.as_deref(),
                    &self.storage,
                )
                .await?
        };
        let generate_elapsed = generate_started.elapsed();

        if response_text.trim().is_empty() {
            if let Some(fallback) = fallback_voice_reply_when_model_silent(&request) {
                // On the streaming path the sender saw nothing (model was
                // silent), so push the spoken fallback through so it still
                // reaches TTS.
                if let Some(ref sentence_tx) = sentence_tx {
                    let _ = sentence_tx.send(fallback.clone());
                }
                response_text = fallback;
            } else {
                return Ok(ChatResponse {
                    session_id,
                    message_id: Uuid::new_v4(),
                    assistant_text: String::new(),
                    created_at: chrono::Utc::now(),
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
                        motion_timeline: Vec::<MotionCue>::new(),
                    },
                    events: Vec::new(),
                    timing: None,
                });
            }
        }

        let persist_assistant_started = std::time::Instant::now();
        let assistant_message = self
            .storage
            .append_message(NewMessageRecord {
                session_id: session_id.clone(),
                role: MessageRole::Assistant,
                text: response_text.clone(),
            })
            .await?;
        let persist_assistant_elapsed = persist_assistant_started.elapsed();
        let handle_elapsed = handle_started.elapsed();

        if handle_elapsed >= Duration::from_millis(250) {
            tracing::warn!(
                session_id = %session_id,
                persist_user_ms = persist_user_elapsed.as_millis(),
                load_context_ms = load_context_elapsed.as_millis(),
                generate_ms = generate_elapsed.as_millis(),
                persist_assistant_ms = persist_assistant_elapsed.as_millis(),
                handle_chat_ms = handle_elapsed.as_millis(),
                history_len = history.len(),
                memory_entries_len = memory_entries.len(),
                text_preview = %request_preview,
                "slow handle_chat breakdown"
            );
        }

        let event = SessionEvent {
            session_id: session_id.clone(),
            kind: SessionEventKind::MessageCreated,
            detail: Some(response_text.clone()),
            created_at: assistant_message.created_at,
        };
        self.publish_event(event.clone()).await;
        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::MessageCreated,
            source: session_id.clone(),
            detail: Some(response_text.clone()),
            created_at: assistant_message.created_at,
        });

        // NOTE: Mood tracking removed — LLM handles mood via prompt context.
        // The persona runtime state mood field is still available for manual
        // updates via the API if needed.

        // Conversation flow detection: emit a hint event if flow is stalling
        if history.len() >= 6 {
            let recent_user: Vec<_> = history
                .iter()
                .rev()
                .filter(|m| matches!(&m.role, MessageRole::User))
                .take(4)
                .collect();
            let stalling = recent_user.iter().all(|m| m.text.chars().count() <= 6);
            if stalling {
                self.runtime_bus.publish(RuntimeEvent {
                    id: Uuid::new_v4(),
                    kind: RuntimeEventKind::ClipCandidate,
                    source: session_id.clone(),
                    detail: Some(
                        "flow:stalling — consider switching segment or prompting user".into(),
                    ),
                    created_at: chrono::Utc::now(),
                });
                tracing::debug!(session_id = %session_id, "conversation flow stalling detected");
            }
        }

        // Periodically generate a session summary and store it as a memory entry.
        // history at this point includes current user message but not yet assistant reply.
        // Trigger when total messages (including just-stored assistant) would be a multiple of 10.
        if (history.len() + 1) % 10 == 0 && history.len() > 0 {
            if let Some(user_id) = request.user_id.as_deref() {
                let summary = build_session_summary(&history, &response_text);
                let _ = self
                    .storage
                    .import_memory_entry(storage::NewMemoryEntryRecord {
                        user_id: user_id.to_string(),
                        entry_type: "session_summary".into(),
                        payload: serde_json::json!({ "summary": summary, "session_id": session_id }),
                        source: "auto_summary".into(),
                    })
                    .await;
                tracing::debug!(
                    user_id,
                    history_len = history.len(),
                    "session summary stored"
                );
            }
        }

        // NOTE: Auto user-fact extraction removed — was using naive keyword
        // matching. LLM can surface user facts naturally via memory system.

        // Every 20 messages: generate a self-reflection via the LLM in the
        // background. Skipped entirely when no remote model is configured —
        // storing a truncated transcript copy as "reflection" would only
        // pollute future prompts.
        if history.len() % 20 == 0 && history.len() >= 20 {
            let recent_summaries = self
                .storage
                .list_memory_entries(None, 6)
                .await
                .unwrap_or_default();
            let summary_texts: Vec<String> = recent_summaries
                .iter()
                .filter(|e| e.entry_type == "session_summary")
                .take(5)
                .map(|e| {
                    e.payload
                        .get("summary")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                })
                .collect();
            if !summary_texts.is_empty() {
                let context: String = summary_texts.join(" | ").chars().take(400).collect();
                let engine = self.chat_engine.clone();
                let storage = self.storage.clone();
                let history_len = history.len();
                tokio::spawn(async move {
                    let prompt = format!(
                        "根据最近的对话记录，用第一人称写一条2句的自我反思：什么问题我回答得好，什么地方可以做得更好。语气是忆的风格。参考：{context}"
                    );
                    match engine.complete_utility_prompt(&prompt).await {
                        Some(reflection) => {
                            let _ = storage
                                .import_memory_entry(storage::NewMemoryEntryRecord {
                                    user_id: "character".into(),
                                    entry_type: "self_reflection".into(),
                                    payload: serde_json::json!({ "reflection": reflection }),
                                    source: "auto_reflect".into(),
                                })
                                .await;
                            tracing::debug!(history_len, "self reflection stored");
                        }
                        None => {
                            tracing::debug!(
                                history_len,
                                "self reflection skipped (no remote model)"
                            );
                        }
                    }
                });
            }
        }

        // NOTE: Persona consistency scoring removed — was keyword counting.
        // Persona enforcement is now handled entirely via the system prompt.

        Ok(ChatResponse {
            session_id,
            message_id: assistant_message.id,
            assistant_text: response_text,
            created_at: assistant_message.created_at,
            speech: SpeechPlaybackPlan {
                request_id: assistant_message.id.to_string(),
                status: "not_requested".into(),
                audio_url: None,
                duration_ms: 0,
                viseme_timeline: Vec::new(),
                error: None,
            },
            animation: Live2dAnimationPlan {
                emotion: "normal".into(),
                subtitle_text: String::new(),
                motion_timeline: Vec::<MotionCue>::new(),
            },
            events: vec![event],
            timing: None,
        })
    }

    async fn prepare_relationship_context(&self, user_id: &str) -> (Option<String>, bool) {
        let existing = self.storage.get_user_relationship(user_id).await.ok();
        let is_reconnect = existing
            .as_ref()
            .and_then(|record| record.last_seen.as_ref().cloned())
            .map(|last_seen| {
                chrono::Utc::now()
                    .signed_duration_since(last_seen)
                    .num_minutes()
                    > 30
            })
            .unwrap_or(false);
        let _ = self.storage.bump_user_interaction(user_id).await;
        let mut relationship = existing.map(|record| record.relationship_type);

        if relationship.as_deref() == Some("unknown") {
            let seeded = match user_id {
                "creator" => Some("creator"),
                "viewer" => Some("viewer"),
                _ => None,
            };
            if let Some(seeded) = seeded {
                let warmth = if seeded == "creator" { 0.8 } else { 0.5 };
                if self
                    .storage
                    .upsert_user_relationship(user_id, seeded, warmth)
                    .await
                    .is_ok()
                {
                    relationship = Some(seeded.to_string());
                }
            }
        }

        (relationship, is_reconnect)
    }

    pub async fn subscribe(&self, session_id: &str) -> broadcast::Receiver<SessionEvent> {
        self.ensure_sender(session_id).await.subscribe()
    }

    async fn publish_event(&self, event: SessionEvent) {
        let sender = self.ensure_sender(&event.session_id).await;
        let _ = sender.send(event);
    }

    async fn ensure_sender(&self, session_id: &str) -> broadcast::Sender<SessionEvent> {
        let mut sessions = self.sessions.write().await;
        sessions
            .entry(session_id.to_string())
            .or_insert_with(|| {
                let (sender, _) = broadcast::channel(128);
                sender
            })
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use chrono::Utc;
    use std::time::Duration;

    use api_types::ChatRequest;
    use serde_json::json;
    use sqlx::SqlitePool;
    use sqlx::sqlite::SqliteConnectOptions;
    use storage::Storage;
    use tempfile::tempdir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::{Orchestrator, RuntimeBus, extract_response_text};

    static LLM_ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvVarGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: String) -> Self {
            let original = std::env::var(key).ok();
            unsafe {
                std::env::set_var(key, value);
            }
            Self { key, original }
        }

        fn remove(key: &'static str) -> Self {
            let original = std::env::var(key).ok();
            unsafe {
                std::env::remove_var(key);
            }
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            unsafe {
                if let Some(value) = &self.original {
                    std::env::set_var(self.key, value);
                } else {
                    std::env::remove_var(self.key);
                }
            }
        }
    }

    #[tokio::test]
    async fn persists_messages_and_broadcasts_session_events() {
        let _llm_guard = LLM_ENV_LOCK.lock().expect("llm env lock");
        let _endpoint_guard = EnvVarGuard::remove("MEMORY_SUITE_LLM_ENDPOINT");
        let _base_url_guard = EnvVarGuard::remove("MEMORY_SUITE_LLM_BASE_URL");
        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("orch.db"))
            .await
            .expect("storage");
        let orchestrator = Orchestrator::new(storage.clone(), RuntimeBus::new());
        let mut events = orchestrator.subscribe("session-test").await;

        let response = orchestrator
            .handle_chat(ChatRequest {
                session_id: Some("session-test".into()),
                user_id: None,
                text: "hello runtime".into(),
            })
            .await
            .expect("chat handled");

        assert_eq!(response.session_id, "session-test");
        assert!(response.assistant_text.trim().is_empty());
        let stored = storage
            .list_messages("session-test")
            .await
            .expect("list messages");
        assert_eq!(stored.len(), 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(120), events.recv())
                .await
                .is_err(),
            "no assistant event should be broadcast when no model reply is available"
        );
    }

    #[tokio::test]
    async fn voice_chat_uses_spoken_fallback_when_model_is_silent() {
        let _llm_guard = LLM_ENV_LOCK.lock().expect("llm env lock");
        let _endpoint_guard = EnvVarGuard::remove("MEMORY_SUITE_LLM_ENDPOINT");
        let _base_url_guard = EnvVarGuard::remove("MEMORY_SUITE_LLM_BASE_URL");
        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("orch.db"))
            .await
            .expect("storage");
        let orchestrator = Orchestrator::new(storage.clone(), RuntimeBus::new());

        let response = orchestrator
            .handle_chat(ChatRequest {
                session_id: Some("voice-session".into()),
                user_id: Some("voice".into()),
                text: "你听得到吗".into(),
            })
            .await
            .expect("chat handled");

        assert_eq!(response.session_id, "voice-session");
        assert!(!response.assistant_text.trim().is_empty());
        assert!(response.assistant_text.contains("主模型"));

        let stored = storage
            .list_messages("voice-session")
            .await
            .expect("list messages");
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[1].text, response.assistant_text);
    }

    #[tokio::test]
    async fn status_command_returns_runtime_snapshot() {
        let _llm_guard = LLM_ENV_LOCK.lock().expect("llm env lock");
        let _endpoint_guard = EnvVarGuard::remove("MEMORY_SUITE_LLM_ENDPOINT");
        let _base_url_guard = EnvVarGuard::remove("MEMORY_SUITE_LLM_BASE_URL");
        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("orch.db"))
            .await
            .expect("storage");
        let orchestrator = Orchestrator::new(storage, RuntimeBus::new());

        let response = orchestrator
            .handle_chat(ChatRequest {
                session_id: Some("ops".into()),
                user_id: Some("operator".into()),
                text: "/status".into(),
            })
            .await
            .expect("status response");

        assert!(response.assistant_text.contains("messages="));
        assert!(!response.assistant_text.contains("jobs="));
    }

    #[tokio::test]
    async fn status_command_skips_remote_llm_and_stays_on_builtin_snapshot() {
        let _llm_guard = LLM_ENV_LOCK.lock().expect("llm env lock");
        let hits = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind llm listener");
        let addr = listener.local_addr().expect("listener addr");
        let hits_for_server = Arc::clone(&hits);
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.expect("accept llm request");
                hits_for_server.fetch_add(1, Ordering::SeqCst);
                let mut buffer = [0u8; 4096];
                let _ = socket.read(&mut buffer).await;
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 76\r\nconnection: close\r\n\r\n{\"choices\":[{\"message\":{\"content\":\"remote should not be used for /status\"}}]}",
                    )
                    .await
                    .expect("write llm response");
            }
        });
        let _endpoint_guard = EnvVarGuard::set(
            "MEMORY_SUITE_LLM_ENDPOINT",
            format!("http://{addr}/v1/chat/completions"),
        );

        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("orch.db"))
            .await
            .expect("storage");
        let orchestrator = Orchestrator::new(storage, RuntimeBus::new());

        let response = orchestrator
            .handle_chat(ChatRequest {
                session_id: Some("ops".into()),
                user_id: Some("operator".into()),
                text: "/status".into(),
            })
            .await
            .expect("status response");

        assert!(response.assistant_text.contains("messages="));
        assert!(!response.assistant_text.contains("jobs="));
        assert!(
            !response
                .assistant_text
                .contains("remote should not be used")
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "/status should not call remote llm when built-in snapshot is available"
        );

        server.abort();
    }

    #[tokio::test]
    async fn general_chat_returns_empty_quickly_when_remote_llm_stalls() {
        let _llm_guard = LLM_ENV_LOCK.lock().expect("llm env lock");
        let hits = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind llm listener");
        let addr = listener.local_addr().expect("listener addr");
        let hits_for_server = Arc::clone(&hits);
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.expect("accept llm request");
                hits_for_server.fetch_add(1, Ordering::SeqCst);
                let mut buffer = [0u8; 4096];
                let _ = socket.read(&mut buffer).await;
                tokio::time::sleep(Duration::from_millis(1_200)).await;
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 57\r\nconnection: close\r\n\r\n{\"choices\":[{\"message\":{\"content\":\"delayed remote\"}}]}",
                    )
                    .await
                    .expect("write llm response");
            }
        });
        let _endpoint_guard = EnvVarGuard::set(
            "MEMORY_SUITE_LLM_ENDPOINT",
            format!("http://{addr}/v1/chat/completions"),
        );
        let _timeout_guard = EnvVarGuard::set("MEMORY_SUITE_LLM_TIMEOUT_MS", "5000".into());
        let _fallback_guard =
            EnvVarGuard::set("MEMORY_SUITE_LLM_FALLBACK_TIMEOUT_MS", "120".into());

        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("orch.db"))
            .await
            .expect("storage");
        let orchestrator = Orchestrator::new(storage, RuntimeBus::new());

        let request = ChatRequest {
            session_id: Some("ops".into()),
            user_id: Some("operator".into()),
            text: "hello".into(),
        };

        let started = tokio::time::Instant::now();
        let response = orchestrator
            .chat_engine
            .generate(
                &request,
                &[],
                &[],
                None,
                &super::persona::PersonaCanon::default(),
                "balanced",
                "idle",
                None,
                None,
                &orchestrator.storage,
            )
            .await
            .expect("chat response");
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_millis(350),
            "general chat should return within the configured fallback budget when the remote model stalls, but took {:?}",
            elapsed
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert_ne!(response.trim(), "delayed remote");
        assert!(response.trim().is_empty());

        server.abort();
    }

    #[tokio::test]
    async fn memory_command_skips_remote_llm_and_returns_builtin_snapshot() {
        let _llm_guard = LLM_ENV_LOCK.lock().expect("llm env lock");
        let hits = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind llm listener");
        let addr = listener.local_addr().expect("listener addr");
        let hits_for_server = Arc::clone(&hits);
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.expect("accept llm request");
                hits_for_server.fetch_add(1, Ordering::SeqCst);
                let mut buffer = [0u8; 4096];
                let _ = socket.read(&mut buffer).await;
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 66\r\nconnection: close\r\n\r\n{\"choices\":[{\"message\":{\"content\":\"remote should not be used\"}}]}",
                    )
                    .await
                    .expect("write llm response");
            }
        });
        let _endpoint_guard = EnvVarGuard::set(
            "MEMORY_SUITE_LLM_ENDPOINT",
            format!("http://{addr}/v1/chat/completions"),
        );

        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("orch.db"))
            .await
            .expect("storage");
        let orchestrator = Orchestrator::new(storage, RuntimeBus::new());

        let response = orchestrator
            .handle_chat(ChatRequest {
                session_id: Some("ops".into()),
                user_id: Some("operator".into()),
                text: "/memory".into(),
            })
            .await
            .expect("memory response");

        assert!(
            response
                .assistant_text
                .contains("No imported memory was found")
                || response.assistant_text.contains("memory snapshot:")
        );
        assert!(
            !response
                .assistant_text
                .contains("remote should not be used")
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "/memory should not call remote llm when built-in snapshot is available"
        );

        server.abort();
    }

    #[tokio::test]
    async fn unknown_slash_command_skips_remote_llm_and_returns_command_help() {
        let _llm_guard = LLM_ENV_LOCK.lock().expect("llm env lock");
        let hits = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind llm listener");
        let addr = listener.local_addr().expect("listener addr");
        let hits_for_server = Arc::clone(&hits);
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.expect("accept llm request");
                hits_for_server.fetch_add(1, Ordering::SeqCst);
                let mut buffer = [0u8; 4096];
                let _ = socket.read(&mut buffer).await;
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 66\r\nconnection: close\r\n\r\n{\"choices\":[{\"message\":{\"content\":\"remote should not be used\"}}]}",
                    )
                    .await
                    .expect("write llm response");
            }
        });
        let _endpoint_guard = EnvVarGuard::set(
            "MEMORY_SUITE_LLM_ENDPOINT",
            format!("http://{addr}/v1/chat/completions"),
        );

        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("orch.db"))
            .await
            .expect("storage");
        let orchestrator = Orchestrator::new(storage, RuntimeBus::new());

        let response = orchestrator
            .handle_chat(ChatRequest {
                session_id: Some("ops".into()),
                user_id: Some("operator".into()),
                text: "/foo".into(),
            })
            .await
            .expect("unknown command response");

        assert!(
            response
                .assistant_text
                .starts_with("Commands: /status, /memory, /help.")
        );
        assert!(
            !response
                .assistant_text
                .contains("remote should not be used")
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "unknown slash commands should not call the remote llm"
        );

        server.abort();
    }

    #[test]
    fn extracts_openai_style_response_content() {
        let payload = json!({
            "choices": [
                {
                    "message": {
                        "content": "ready"
                    }
                }
            ]
        });
        assert_eq!(extract_response_text(&payload).as_deref(), Some("ready"));

        let alt = json!({ "text": "fallback text" });
        assert_eq!(
            extract_response_text(&alt).as_deref(),
            Some("fallback text")
        );
    }

    #[tokio::test]
    async fn render_system_prompt_includes_persona_canon() {
        let _llm_guard = LLM_ENV_LOCK.lock().expect("llm env lock");
        let _endpoint_guard = EnvVarGuard::remove("MEMORY_SUITE_LLM_ENDPOINT");
        let _base_url_guard = EnvVarGuard::remove("MEMORY_SUITE_LLM_BASE_URL");
        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("orch.db"))
            .await
            .expect("storage");
        storage
            .upsert_persona_runtime_config(
                "stream",
                "sharp-playful",
                0.45,
                0.65,
                0.20,
                "explaining",
                "curious",
            )
            .await
            .expect("upsert persona config");

        let orchestrator = Orchestrator::new(storage, RuntimeBus::new());
        let prompt = orchestrator
            .debug_render_prompt("creator", "hello")
            .await
            .expect("render prompt");

        assert!(
            prompt.contains("Persona core"),
            "prompt should contain 'Persona core'"
        );
        assert!(
            prompt.contains("Forbidden drift"),
            "prompt should contain 'Forbidden drift'"
        );
        assert!(
            prompt.contains("sharp-playful"),
            "prompt should contain tone profile"
        );
    }

    #[test]
    fn summarize_text_truncates_multibyte_chinese_without_panic() {
        use super::summarize_text;

        // Regression: the reconnect-recap and reflection paths used raw byte
        // slicing (&s[..150]) which panics mid-codepoint on Chinese text.
        let chinese =
            "这是一个包含很多中文字符的会话总结用来验证截断逻辑不会在字节边界崩溃".repeat(10);
        let truncated = summarize_text(&chinese, 150);
        assert_eq!(truncated.chars().count(), 153); // 150 chars + "..."
        assert!(truncated.ends_with("..."));

        let short = summarize_text("短文本", 150);
        assert_eq!(short, "短文本");
    }

    #[test]
    fn context_explaining_injects_style_hint_into_prompt() {
        use super::{RemoteModelConfig, build_remote_messages, persona::PersonaCanon};

        let canon = PersonaCanon::default();
        let fake_remote = RemoteModelConfig {
            endpoint: String::new(),
            model: "test".into(),
            api_key: None,
            temperature: 0.65,
            max_tokens: 420,
        };
        let request = api_types::ChatRequest {
            session_id: None,
            user_id: Some("user1".into()),
            text: "hello".into(),
        };

        let msgs_explaining = build_remote_messages(
            &fake_remote,
            &request,
            &[],
            &[],
            &canon,
            "balanced",
            "explaining",
            None,
            None,
        );
        let msgs_idle = build_remote_messages(
            &fake_remote,
            &request,
            &[],
            &[],
            &canon,
            "balanced",
            "idle",
            None,
            None,
        );

        let explaining_prompt = msgs_explaining[0]["content"].as_str().unwrap_or("");
        let idle_prompt = msgs_idle[0]["content"].as_str().unwrap_or("");

        assert!(
            explaining_prompt.contains("explaining"),
            "explaining context should inject style hint"
        );
        assert!(
            !idle_prompt.contains("explaining"),
            "idle context should not inject explaining hint"
        );
    }

    #[test]
    fn creator_relationship_injects_cooperation_hint_into_prompt() {
        use super::{RemoteModelConfig, build_remote_messages, persona::PersonaCanon};

        let canon = PersonaCanon::default();
        let fake_remote = RemoteModelConfig {
            endpoint: String::new(),
            model: "test".into(),
            api_key: None,
            temperature: 0.65,
            max_tokens: 420,
        };
        let request = api_types::ChatRequest {
            session_id: None,
            user_id: Some("testuser123".into()),
            text: "hello".into(),
        };

        let msgs_creator = build_remote_messages(
            &fake_remote,
            &request,
            &[],
            &[],
            &canon,
            "balanced",
            "idle",
            Some("creator"),
            None,
        );
        let msgs_viewer = build_remote_messages(
            &fake_remote,
            &request,
            &[],
            &[],
            &canon,
            "balanced",
            "idle",
            Some("viewer"),
            None,
        );
        let msgs_unknown = build_remote_messages(
            &fake_remote,
            &request,
            &[],
            &[],
            &canon,
            "balanced",
            "idle",
            None,
            None,
        );

        let creator_prompt = msgs_creator[0]["content"].as_str().unwrap_or("");
        let viewer_prompt = msgs_viewer[0]["content"].as_str().unwrap_or("");
        let unknown_prompt = msgs_unknown[0]["content"].as_str().unwrap_or("");

        assert!(
            creator_prompt.contains("creator/director"),
            "creator relationship should inject cooperation hint"
        );
        assert!(
            viewer_prompt.contains("viewer"),
            "viewer relationship should inject warmth hint"
        );
        assert!(
            !unknown_prompt.contains("creator/director")
                && !unknown_prompt.contains("Be warm and light"),
            "unknown relationship should not inject relationship hint: {unknown_prompt}"
        );
    }

    #[test]
    fn scene_system_prompt_does_not_force_follow_through_tail() {
        use super::{RemoteModelConfig, build_remote_messages, persona::PersonaCanon};

        let canon = PersonaCanon::default();
        let fake_remote = RemoteModelConfig {
            endpoint: String::new(),
            model: "test".into(),
            api_key: None,
            temperature: 0.65,
            max_tokens: 420,
        };
        let request = api_types::ChatRequest {
            session_id: None,
            user_id: Some("scene-system".into()),
            text: "（场景事件：scene — test）用一句话快速评论一下，不超过20字".into(),
        };

        let msgs = build_remote_messages(
            &fake_remote,
            &request,
            &[],
            &[],
            &canon,
            "balanced",
            "idle",
            None,
            Some("Scene event just happened: scene — test"),
        );
        let prompt = msgs[0]["content"].as_str().unwrap_or("");

        assert!(prompt.contains("Keep replies concise and in-character"));
        assert!(prompt.contains("Return exactly one short line"));
        assert!(!prompt.contains("After answering, only add one short follow-through"));
    }

    #[test]
    fn forbidden_drift_words_absent_from_builtin_responses() {
        let drift_words = [
            "好的，我来帮你",
            "当然可以",
            "作为AI",
            "我很乐意",
            "Of course",
            "I'd be happy to",
        ];

        let test_inputs = ["/status", "/memory", "/help", "/unknown_command"];

        for input in &test_inputs {
            let request = api_types::ChatRequest {
                session_id: None,
                user_id: Some("test".into()),
                text: input.to_string(),
            };
            let reply =
                super::built_in_response(&request, &[], &[], None, None).expect("builtin reply");
            for word in &drift_words {
                assert!(
                    !reply.to_lowercase().contains(&word.to_lowercase()),
                    "builtin response for {input:?} contains drift word {word:?}: {reply:?}"
                );
            }
        }
    }

    #[test]
    fn builtin_normal_reply_does_not_expose_memory_or_operator_scaffolding() {
        let request = api_types::ChatRequest {
            session_id: None,
            user_id: Some("operator".into()),
            text: "快速检查一下当前统一运行时状态。".into(),
        };
        let memories = vec![api_types::MemoryEntryRecord {
            id: uuid::Uuid::new_v4(),
            user_id: "character".into(),
            entry_type: "memorable_moment".into(),
            payload: json!({
                "moment": "punchline: 观众说 operator_acknowledged 这类内部字段不要被念出来",
                "source": "danmaku-batch"
            }),
            source: "clip_detected".into(),
            created_at: Utc::now(),
        }];

        let reply = super::built_in_response(&request, &[], &memories, None, None);

        assert!(reply.is_none());
    }

    #[test]
    fn builtin_danmaku_reply_is_disabled() {
        let request = api_types::ChatRequest {
            session_id: Some("native:test".into()),
            user_id: Some("viewer-1".into()),
            text: "嗯".into(),
        };

        let reply = super::built_in_response(
            &request,
            &[],
            &[],
            None,
            Some("channel=live_danmaku\nspeaker=viewer-1"),
        );

        assert!(reply.is_none());
    }

    #[tokio::test]
    async fn reconnect_detection_uses_last_seen_before_interaction_bump() {
        let _llm_guard = LLM_ENV_LOCK.lock().expect("llm env lock");
        let _endpoint_guard = EnvVarGuard::remove("MEMORY_SUITE_LLM_ENDPOINT");
        let _base_url_guard = EnvVarGuard::remove("MEMORY_SUITE_LLM_BASE_URL");
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("orch.db");
        let storage = Storage::connect(&db_path).await.expect("storage");
        storage
            .upsert_user_relationship("creator", "unknown", 0.5)
            .await
            .expect("seed relationship");

        let db = SqlitePool::connect_with(
            SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true),
        )
        .await
        .expect("secondary sqlite connection");
        sqlx::query(
            "UPDATE user_relationships SET last_seen = ?1, interaction_count = 7 WHERE user_id = ?2",
        )
        .bind((Utc::now() - chrono::Duration::minutes(45)).to_rfc3339())
        .bind("creator")
        .execute(&db)
        .await
        .expect("age relationship record");

        let orchestrator = Orchestrator::new(storage.clone(), RuntimeBus::new());
        let (relationship, is_reconnect) =
            orchestrator.prepare_relationship_context("creator").await;

        assert_eq!(relationship.as_deref(), Some("creator"));
        assert!(
            is_reconnect,
            "stale last_seen should trigger reconnect recap"
        );

        let record = storage
            .get_user_relationship("creator")
            .await
            .expect("load updated relationship");
        assert_eq!(record.relationship_type, "creator");
        assert_eq!(record.interaction_count, 8);
    }

    /// Spawns a one-shot mock LLM that replies with a real `text/event-stream`
    /// body (the raw SSE frames a live OpenAI-compatible endpoint sends), then
    /// closes the connection. `frames` is the exact body written after the
    /// headers. Returns the bound address.
    async fn spawn_sse_mock(frames: &'static str) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind sse listener");
        let addr = listener.local_addr().expect("listener addr");
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept sse request");
            let mut buffer = [0u8; 8192];
            let _ = socket.read(&mut buffer).await;
            let header = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
            socket
                .write_all(header.as_bytes())
                .await
                .expect("write sse header");
            socket
                .write_all(frames.as_bytes())
                .await
                .expect("write sse frames");
            let _ = socket.flush().await;
            // Drop the socket to close the connection so the client sees EOF.
        });
        (addr, handle)
    }

    #[tokio::test]
    async fn streaming_parses_standard_openai_sse_and_emits_sentences() {
        let _llm_guard = LLM_ENV_LOCK.lock().expect("llm env lock");
        let frames = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{\"content\":\"你好呀\"}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{\"content\":\"，今天\"}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{\"content\":\"不错。\"}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{\"content\":\"还有别的\"}}]}\n\n\
                      data: [DONE]\n\n";
        let (addr, server) = spawn_sse_mock(frames).await;
        let _endpoint_guard = EnvVarGuard::set(
            "MEMORY_SUITE_LLM_ENDPOINT",
            format!("http://{addr}/v1/chat/completions"),
        );

        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("orch.db"))
            .await
            .expect("storage");
        let orchestrator = Orchestrator::new(storage.clone(), RuntimeBus::new());

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let request = ChatRequest {
            session_id: Some("stream-session".into()),
            user_id: Some("voice".into()),
            text: "你好".into(),
        };
        let text = orchestrator
            .chat_engine
            .generate_streaming(
                &request,
                &[],
                &[],
                None,
                &super::persona::PersonaCanon::default(),
                "balanced",
                "idle",
                None,
                None,
                &storage,
                &tx,
            )
            .await
            .expect("streaming generate");
        drop(tx);

        let mut sentences = Vec::new();
        while let Some(s) = rx.recv().await {
            sentences.push(s);
        }

        assert_eq!(
            text, "你好呀，今天不错。还有别的",
            "full accumulated reply should be the concatenated deltas"
        );
        assert!(
            !sentences.is_empty(),
            "streaming must emit at least one sentence, got none"
        );
        assert_eq!(
            sentences.first().map(String::as_str),
            Some("你好呀，今天不错。"),
            "first sentence should flush at the first terminator"
        );

        server.abort();
    }

    /// Spawns a mock that accepts connections in a loop and answers every
    /// request with a fixed HTTP status + body. Used to simulate a dead or
    /// unauthorized endpoint (the cloud tier gets hit twice: stream + retry).
    async fn spawn_failing_mock(
        status_line: &'static str,
        body: &'static str,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind failing listener");
        let addr = listener.local_addr().expect("listener addr");
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut buffer = [0u8; 8192];
                let _ = socket.read(&mut buffer).await;
                let response = format!(
                    "HTTP/1.1 {status_line}\r\ncontent-type: application/json\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });
        (addr, handle)
    }

    /// Regression test for the hybrid-router failover: when a "deep" turn routes
    /// to the cloud tier and the cloud endpoint is dead, the turn must degrade to
    /// the local model and still produce a real reply — never the empty voice
    /// fallback ("我听到了，但主模型这轮没有给出内容。").
    #[tokio::test]
    async fn cloud_failure_falls_back_to_local_model() {
        let _llm_guard = LLM_ENV_LOCK.lock().expect("llm env lock");

        // Cloud tier: always 500. Hit twice (stream + non-streaming retry).
        let (cloud_addr, cloud_server) =
            spawn_failing_mock("500 Internal Server Error", "{\"error\":\"channel down\"}").await;
        // Local tier: healthy standard SSE.
        let local_frames = "data: {\"choices\":[{\"delta\":{\"content\":\"本地兜底回答。\"}}]}\n\n\
                            data: [DONE]\n\n";
        let (local_addr, local_server) = spawn_sse_mock(local_frames).await;

        let _endpoint_guard = EnvVarGuard::set(
            "MEMORY_SUITE_LLM_ENDPOINT",
            format!("http://{local_addr}/v1/chat/completions"),
        );
        let _base_url_guard = EnvVarGuard::remove("MEMORY_SUITE_LLM_BASE_URL");
        let _cloud_guard = EnvVarGuard::set(
            "MEMORY_SUITE_LLM_CLOUD_ENDPOINT",
            format!("http://{cloud_addr}/v1/chat/completions"),
        );

        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("orch.db"))
            .await
            .expect("storage");
        let orchestrator = Orchestrator::new(storage.clone(), RuntimeBus::new());

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        // Deep question: contains 为什么/详细/解释/原理 → routes to cloud tier.
        let request = ChatRequest {
            session_id: Some("failover-session".into()),
            user_id: Some("voice".into()),
            text: "为什么天空是蓝色的？请详细解释一下原理".into(),
        };
        let text = orchestrator
            .chat_engine
            .generate_streaming(
                &request,
                &[],
                &[],
                None,
                &super::persona::PersonaCanon::default(),
                "balanced",
                "idle",
                None,
                None,
                &storage,
                &tx,
            )
            .await
            .expect("streaming generate");
        drop(tx);

        let mut sentences = Vec::new();
        while let Some(s) = rx.recv().await {
            sentences.push(s);
        }

        assert_eq!(
            text, "本地兜底回答。",
            "cloud failure must degrade to the local model's reply"
        );
        assert_ne!(
            text, "我听到了，但主模型这轮没有给出内容。",
            "must never strand a deep turn on the empty voice fallback"
        );
        assert_eq!(
            sentences.first().map(String::as_str),
            Some("本地兜底回答。"),
            "local fallback reply must be dispatched to TTS"
        );

        cloud_server.abort();
        local_server.abort();
    }
}
