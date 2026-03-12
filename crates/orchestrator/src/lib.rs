pub mod persona;
pub mod runtime_bus;

use std::{collections::HashMap, env, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, anyhow};
use api_types::{
    ChatRequest, ChatResponse, Live2dAnimationPlan, MemoryEntryRecord, MessageRole, MotionCue,
    RuntimeEvent, RuntimeEventKind, SessionEvent, SessionEventKind, SpeechPlaybackPlan,
    StoredMessage,
};
use serde_json::{Value, json};
use storage::{NewMemoryEntryRecord, NewMessageRecord, RuntimeCounts, Storage};
use tokio::sync::{RwLock, broadcast};
use uuid::Uuid;

pub use runtime_bus::RuntimeBus;

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
        ))
    }

    pub async fn handle_chat(&self, request: ChatRequest) -> Result<ChatResponse> {
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
        let (tone_profile, current_context) = self
            .storage
            .get_persona_runtime_state()
            .await
            .map(|s| (s.tone_profile, s.current_context))
            .unwrap_or_else(|_| (DEFAULT_TONE_PROFILE.into(), "idle".into()));

        // Load user relationship and bump interaction count
        let relationship_hint = if let Some(user_id) = request.user_id.as_deref() {
            let _ = self.storage.bump_user_interaction(user_id).await;
            self.storage
                .get_user_relationship(user_id)
                .await
                .ok()
                .map(|r| r.relationship_type)
        } else {
            None
        };

        let load_context_elapsed = load_context_started.elapsed();

        let generate_started = std::time::Instant::now();
        let response_text = self
            .chat_engine
            .generate(
                &request,
                &history,
                &memory_entries,
                runtime_counts,
                &self.persona_canon,
                &tone_profile,
                &current_context,
                relationship_hint.as_deref(),
                &self.storage,
            )
            .await?;
        let generate_elapsed = generate_started.elapsed();

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
                tracing::debug!(user_id, history_len = history.len(), "session summary stored");
            }
        }

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
        })
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

#[derive(Debug, Clone)]
struct RemoteModelConfig {
    endpoint: String,
    model: String,
    api_key: Option<String>,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Clone)]
struct ChatEngine {
    client: reqwest::Client,
    remote: Option<RemoteModelConfig>,
    fallback_timeout_ms: u64,
}

impl ChatEngine {
    fn from_env() -> Self {
        let endpoint = env::var("MEMORY_SUITE_LLM_ENDPOINT")
            .ok()
            .or_else(|| {
                env::var("MEMORY_SUITE_LLM_BASE_URL")
                    .ok()
                    .map(endpoint_from_base)
            })
            .map(normalize_chat_endpoint)
            .filter(|value| !value.is_empty());
        let timeout_ms = parse_u64_env("MEMORY_SUITE_LLM_TIMEOUT_MS", DEFAULT_REMOTE_TIMEOUT_MS);
        let fallback_timeout_ms = parse_u64_env(
            "MEMORY_SUITE_LLM_FALLBACK_TIMEOUT_MS",
            DEFAULT_REMOTE_FALLBACK_TIMEOUT_MS,
        );
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .unwrap_or_else(|error| {
                tracing::warn!("failed to build reqwest client with timeout: {error}");
                reqwest::Client::new()
            });

        let remote = endpoint.map(|endpoint| RemoteModelConfig {
            endpoint,
            model: env::var("MEMORY_SUITE_LLM_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()),
            api_key: env::var("MEMORY_SUITE_LLM_API_KEY")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            temperature: parse_f32_env("MEMORY_SUITE_LLM_TEMPERATURE", 0.65),
            max_tokens: parse_u32_env("MEMORY_SUITE_LLM_MAX_TOKENS", 420),
        });

        Self { client, remote, fallback_timeout_ms }
    }

    async fn generate(
        &self,
        request: &ChatRequest,
        history: &[StoredMessage],
        memory_entries: &[MemoryEntryRecord],
        runtime_counts: Option<RuntimeCounts>,
        canon: &persona::PersonaCanon,
        tone_profile: &str,
        current_context: &str,
        relationship_type: Option<&str>,
        storage: &Storage,
    ) -> Result<String> {
        let built_in = built_in_response(request, history, memory_entries, runtime_counts);
        if should_prefer_built_in_response(request) {
            return Ok(built_in);
        }

        // Short-circuit to a persona reaction for brief ack/filler inputs
        if !canon.short_reactions.is_empty() {
            let seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(42) as u64;
            if let Some(reaction) =
                persona::short_reaction_for(&request.text, &canon.short_reactions, seed)
            {
                tracing::debug!("using short reaction for brief input");
                return Ok(reaction);
            }
        }
        if let Some(remote) = &self.remote {
            match tokio::time::timeout(
                Duration::from_millis(self.fallback_timeout_ms),
                self.complete_remote(remote, request, history, memory_entries, canon, tone_profile, current_context, relationship_type),
            )
            .await
            {
                Ok(Ok(text)) if !text.trim().is_empty() => {
                    let _ = storage.bump_fallback_stat("remote").await;
                    return Ok(limit_chars(&text, MAX_REPLY_CHARS));
                }
                Ok(Ok(_)) => {
                    tracing::warn!("remote llm returned empty text, using built-in response path");
                    let _ = storage.bump_fallback_stat("builtin_empty").await;
                }
                Ok(Err(error)) => {
                    tracing::warn!("remote llm failed, using built-in response path: {error}");
                    let _ = storage.bump_fallback_stat("builtin_error").await;
                }
                Err(_) => {
                    tracing::warn!(
                        "remote llm exceeded fallback timeout ({} ms), using built-in response path",
                        self.fallback_timeout_ms
                    );
                    let _ = storage.bump_fallback_stat("builtin_timeout").await;
                }
            }
        }

        Ok(built_in)
    }

    async fn complete_remote(
        &self,
        remote: &RemoteModelConfig,
        request: &ChatRequest,
        history: &[StoredMessage],
        memory_entries: &[MemoryEntryRecord],
        canon: &persona::PersonaCanon,
        tone_profile: &str,
        current_context: &str,
        relationship_type: Option<&str>,
    ) -> Result<String> {
        let payload = json!({
            "model": remote.model,
            "messages": build_remote_messages(remote, request, history, memory_entries, canon, tone_profile, current_context, relationship_type),
            "temperature": remote.temperature,
            "max_tokens": remote.max_tokens,
            "stream": false
        });

        let mut req = self.client.post(&remote.endpoint).json(&payload);
        if let Some(key) = &remote.api_key {
            req = req.bearer_auth(key);
        }
        let response = req.send().await.context("send llm request")?;
        let status = response.status();
        let raw = response.text().await.context("read llm response body")?;
        if !status.is_success() {
            return Err(anyhow!(
                "llm status {status}: {}",
                truncate_for_log(&raw, 260)
            ));
        }

        let parsed: Value = serde_json::from_str(&raw).context("parse llm response json")?;
        extract_response_text(&parsed).ok_or_else(|| anyhow!("llm response has no text content"))
    }
}

fn build_remote_messages(
    remote: &RemoteModelConfig,
    request: &ChatRequest,
    history: &[StoredMessage],
    memory_entries: &[MemoryEntryRecord],
    canon: &persona::PersonaCanon,
    tone_profile: &str,
    current_context: &str,
    relationship_type: Option<&str>,
) -> Vec<Value> {
    let mut messages = Vec::new();
    messages.push(json!({
        "role": "system",
        "content": render_system_prompt(remote, request, memory_entries, canon, tone_profile, current_context, relationship_type),
    }));

    let start = history.len().saturating_sub(MAX_HISTORY_MESSAGES);
    for item in &history[start..] {
        messages.push(json!({
            "role": role_name(&item.role),
            "content": item.text
        }));
    }

    messages
}

fn render_system_prompt(
    _remote: &RemoteModelConfig,
    request: &ChatRequest,
    memory_entries: &[MemoryEntryRecord],
    canon: &persona::PersonaCanon,
    tone_profile: &str,
    current_context: &str,
    relationship_type: Option<&str>,
) -> String {
    let mut prompt = String::new();

    // Persona core block from canon
    if !canon.core_identity.is_empty() {
        prompt.push_str(&canon.render_prompt_block(tone_profile));
        prompt.push('\n');
    }

    prompt.push_str("\nOutput rules:\n");
    prompt.push_str("- Reply in the same language as the user.\n");
    prompt.push_str("- Keep replies concise and in-character.\n");
    prompt.push_str("- Avoid meta statements about being an AI.\n");
    prompt.push_str("- After answering, naturally add one short follow-through: a brief judgment, a light follow-up question, or a scene transition. Do not always do this — skip it when the answer already lands cleanly.\n");
    if let Some(user_id) = &request.user_id {
        prompt.push_str(&format!("- Current user_id: {user_id}\n"));
    }

    // Relationship-aware attitude hint
    let relationship_hint = match relationship_type.unwrap_or("unknown") {
        "creator" => Some("This user is the creator/director. Be cooperative and direct. Accept instructions, but you may express disagreement briefly."),
        "viewer" => Some("This user is a viewer. Be warm and light. Keep it engaging and conversational."),
        _ => None,
    };
    if let Some(hint) = relationship_hint {
        prompt.push_str(&format!("- {hint}\n"));
    }

    // Context-specific style hints
    let context_hint = match current_context {
        // Program structure segments
        "opening" => {
            let example = canon.opening_lines.first().map(|s| format!(" Example: \"{s}\"")).unwrap_or_default();
            Some(format!("Current segment: opening. Start with energy — a short punchy greeting, set the vibe, hint at what's coming. Keep it under 2 sentences.{example}"))
        }
        "warmup" => Some("Current segment: warmup. Light and conversational. Ease in, no heavy topics yet. React to small things.".into()),
        "highlight" => Some("Current segment: highlight. This is a peak moment — be sharp, funny, or surprisingly insightful. Make it clip-worthy.".into()),
        "transition" => Some("Current segment: transition. Briefly close one topic and pivot to the next. Keep it smooth and quick.".into()),
        // Style modes
        "explaining" => Some("Current mode: explaining. Be clear and structured. Lead with the key point.".into()),
        "teasing" => Some("Current mode: teasing. Be a little playful, poke fun gently before the real answer.".into()),
        "thinking" => Some("Current mode: thinking out loud. Show the reasoning process, incomplete thoughts are fine.".into()),
        "reacting" => Some("Current mode: reacting. Short, punchy, emotional. No need for full explanation.".into()),
        "closing" => {
            let example = canon.closing_lines.first().map(|s| format!(" Example: \"{s}\"")).unwrap_or_default();
            Some(format!("Current segment: closing. Wrap up warmly, leave something for next time. Under 3 sentences.{example}"))
        }
        _ => None, // idle or unknown: no special hint
    };

    // If context matches a named segment in canon, inject its description
    let context_hint = context_hint.or_else(|| {
        canon.segments.iter().find_map(|seg| {
            let (name, desc) = seg.split_once(':')?;
            if name.trim() == current_context {
                Some(format!("Current segment: {name}. {}", desc.trim()))
            } else {
                None
            }
        })
    });

    if let Some(ref hint) = context_hint {
        prompt.push_str(&format!("- {hint}\n"));
    }

    if !memory_entries.is_empty() {
        prompt.push_str("\nKnown memory entries:\n");
        for entry in memory_entries.iter().take(MAX_MEMORY_SNIPPETS) {
            let payload = compact_json(&entry.payload, 180);
            prompt.push_str(&format!(
                "- type={}, source={}, payload={}\n",
                entry.entry_type, entry.source, payload
            ));
        }
    }

    prompt
}

/// Build a compact session summary from recent message history.
/// Used to periodically store a memory entry so future sessions have context.
fn build_session_summary(history: &[StoredMessage], last_reply: &str) -> String {
    let recent: Vec<_> = history
        .iter()
        .rev()
        .take(10)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    let mut parts = Vec::new();
    for msg in &recent {
        let role = match &msg.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            _ => "system",
        };
        let text = summarize_text(&msg.text, 80);
        parts.push(format!("{role}: {text}"));
    }
    if !last_reply.is_empty() {
        parts.push(format!("assistant: {}", summarize_text(last_reply, 80)));
    }
    parts.join(" | ")
}

fn extract_response_text(payload: &Value) -> Option<String> {
    if let Some(text) = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        return Some(text.trim().to_string());
    }

    if let Some(content) = payload.pointer("/choices/0/message/content") {
        if let Some(parts) = content.as_array() {
            let text = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }

    for pointer in [
        "/choices/0/text",
        "/output_text",
        "/response",
        "/text",
        "/data/text",
    ] {
        if let Some(text) = payload.pointer(pointer).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

fn should_prefer_built_in_response(request: &ChatRequest) -> bool {
    let text = request.text.trim();
    let lowered = text.to_ascii_lowercase();
    matches!(lowered.as_str(), "/help" | "/status" | "/memory")
        || (text.starts_with('/') && !matches!(lowered.as_str(), "/help" | "/status" | "/memory"))
}

fn built_in_response(
    request: &ChatRequest,
    history: &[StoredMessage],
    memory_entries: &[MemoryEntryRecord],
    runtime_counts: Option<RuntimeCounts>,
) -> String {
    let text = request.text.trim();
    if text.is_empty() {
        return "I received an empty message. Please send a specific task or question.".into();
    }

    let lowered = text.to_ascii_lowercase();
    if lowered == "/help" || (text.starts_with('/') && lowered != "/status" && lowered != "/memory") {
        return "Commands: /status, /memory, /help. For normal chat, send your goal directly."
            .into();
    }
    if lowered == "/status" {
        if let Some(counts) = runtime_counts {
            return format!(
                "runtime ok: messages={}, jobs={}, profiles={}, memories={}, configs={}",
                counts.messages.max(0),
                counts.jobs.max(0),
                counts.user_profiles.max(0),
                counts.memory_entries.max(0),
                counts.config_artifacts.max(0)
            );
        }
        return "runtime status is temporarily unavailable, please retry in a moment.".into();
    }
    if lowered == "/memory" {
        if memory_entries.is_empty() {
            return "No imported memory was found for this user yet.".into();
        }
        let top = memory_entries
            .iter()
            .take(3)
            .map(|entry| {
                format!(
                    "{}: {}",
                    entry.entry_type,
                    compact_json(&entry.payload, 120)
                )
            })
            .collect::<Vec<_>>()
            .join(" | ");
        return format!("memory snapshot: {top}");
    }

    let user = request.user_id.as_deref().unwrap_or("operator");
    let topic = summarize_text(text, 80);
    let question_like = text.contains('?') || text.contains('？');
    let memory_hint = if let Some(entry) = memory_entries.first() {
        format!(
            " I also found prior memory ({}) -> {}.",
            entry.entry_type,
            compact_json(&entry.payload, 120)
        )
    } else {
        " I will remember this context for follow-up turns.".into()
    };
    let continuity_hint = history
        .iter()
        .rev()
        .find(|message| matches!(&message.role, MessageRole::Assistant))
        .map(|message| {
            format!(
                " Last assistant turn was: {}.",
                summarize_text(&message.text, 90)
            )
        })
        .unwrap_or_default();

    if question_like {
        format!(
            "{user}, for \"{topic}\": 1) define the exact outcome, 2) execute the smallest verifiable step, 3) review metrics and iterate.{memory_hint}{continuity_hint}"
        )
    } else {
        format!(
            "{user}, acknowledged: \"{topic}\". Next step: convert it into a concrete action with owner, deadline, and success criteria.{memory_hint}{continuity_hint}"
        )
    }
}

fn role_name(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
    }
}

fn endpoint_from_base(base: String) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    format!("{trimmed}/v1/chat/completions")
}

fn normalize_chat_endpoint(endpoint: String) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.ends_with("/v1/chat/completions") {
        trimmed.to_string()
    } else if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1/chat/completions")
    }
}

fn summarize_text(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in text.chars().take(max_chars) {
        out.push(ch);
    }
    if text.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

fn compact_json(value: &Value, max_chars: usize) -> String {
    let rendered = serde_json::to_string(value).unwrap_or_else(|_| "<invalid-json>".into());
    summarize_text(&rendered, max_chars)
}

fn truncate_for_log(text: &str, max_chars: usize) -> String {
    summarize_text(&text.replace('\n', " "), max_chars)
}

fn limit_chars(text: &str, max_chars: usize) -> String {
    summarize_text(text.trim(), max_chars)
}

fn parse_u64_env(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(fallback)
}

fn parse_u32_env(name: &str, fallback: u32) -> u32 {
    env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<u32>().ok())
        .unwrap_or(fallback)
}

fn parse_f32_env(name: &str, fallback: f32) -> f32 {
    env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<f32>().ok())
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    use std::time::Duration;

    use api_types::ChatRequest;
    use serde_json::json;
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
        let stored = storage
            .list_messages("session-test")
            .await
            .expect("list messages");
        assert_eq!(stored.len(), 2);

        let event = events.recv().await.expect("event");
        assert_eq!(event.session_id, "session-test");
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
        assert!(response.assistant_text.contains("jobs="));
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
        assert!(response.assistant_text.contains("jobs="));
        assert!(!response.assistant_text.contains("remote should not be used"));
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "/status should not call remote llm when built-in snapshot is available"
        );

        server.abort();
    }

    #[tokio::test]
    async fn general_chat_falls_back_quickly_when_remote_llm_stalls() {
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
        let _fallback_guard = EnvVarGuard::set("MEMORY_SUITE_LLM_FALLBACK_TIMEOUT_MS", "120".into());

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
            .generate(&request, &[], &[], None, &super::persona::PersonaCanon::default(), "balanced", "idle", None, &orchestrator.storage)
            .await
            .expect("chat response");
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_millis(350),
            "general chat should fall back within the configured fallback budget when the remote model stalls, but took {:?}",
            elapsed
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert_ne!(response.trim(), "delayed remote");
        assert!(response.contains("acknowledged") || response.contains("你好"));

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

        assert!(response.assistant_text.contains("No imported memory was found") || response.assistant_text.contains("memory snapshot:"));
        assert!(!response.assistant_text.contains("remote should not be used"));
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

        assert!(response.assistant_text.starts_with("Commands: /status, /memory, /help."));
        assert!(!response.assistant_text.contains("remote should not be used"));
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
            .upsert_persona_runtime_config("stream", "sharp-playful", 0.45, 0.65, 0.20, "explaining")
            .await
            .expect("upsert persona config");

        let orchestrator = Orchestrator::new(storage, RuntimeBus::new());
        let prompt = orchestrator
            .debug_render_prompt("creator", "hello")
            .await
            .expect("render prompt");

        assert!(prompt.contains("Persona core"), "prompt should contain 'Persona core'");
        assert!(prompt.contains("Forbidden drift"), "prompt should contain 'Forbidden drift'");
        assert!(prompt.contains("sharp-playful"), "prompt should contain tone profile");
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
            &fake_remote, &request, &[], &[], &canon, "balanced", "explaining", None,
        );
        let msgs_idle = build_remote_messages(
            &fake_remote, &request, &[], &[], &canon, "balanced", "idle", None,
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
            &fake_remote, &request, &[], &[], &canon, "balanced", "idle", Some("creator"),
        );
        let msgs_viewer = build_remote_messages(
            &fake_remote, &request, &[], &[], &canon, "balanced", "idle", Some("viewer"),
        );
        let msgs_unknown = build_remote_messages(
            &fake_remote, &request, &[], &[], &canon, "balanced", "idle", None,
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
            !unknown_prompt.contains("creator/director") && !unknown_prompt.contains("Be warm and light"),
            "unknown relationship should not inject relationship hint: {unknown_prompt}"
        );
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

        let test_inputs = [
            "/status",
            "/memory",
            "/help",
            "/unknown_command",
        ];

        for input in &test_inputs {
            let request = api_types::ChatRequest {
                session_id: None,
                user_id: Some("test".into()),
                text: input.to_string(),
            };
            let reply = super::built_in_response(&request, &[], &[], None);
            for word in &drift_words {
                assert!(
                    !reply.to_lowercase().contains(&word.to_lowercase()),
                    "builtin response for {input:?} contains drift word {word:?}: {reply:?}"
                );
            }
        }
    }
}
