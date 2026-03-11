pub mod runtime_bus;

use std::{collections::HashMap, env, sync::Arc, time::Duration};

use anyhow::{Context, Result, anyhow};
use api_types::{
    ChatRequest, ChatResponse, Live2dAnimationPlan, MemoryEntryRecord, MessageRole, MotionCue,
    RuntimeEvent, RuntimeEventKind, SessionEvent, SessionEventKind, SpeechPlaybackPlan,
    StoredMessage,
};
use serde_json::{Value, json};
use storage::{NewMessageRecord, RuntimeCounts, Storage};
use tokio::sync::{RwLock, broadcast};
use uuid::Uuid;

pub use runtime_bus::RuntimeBus;

const DEFAULT_SYSTEM_PROMPT: &str =
    "You are Memory Suite runtime assistant. Be concise, actionable, and context-aware.";
const DEFAULT_MODEL: &str = "Qwen/Qwen2.5-7B-Instruct";
const DEFAULT_REMOTE_TIMEOUT_MS: u64 = 15_000;
const DEFAULT_REMOTE_FALLBACK_TIMEOUT_MS: u64 = 500;
const MAX_HISTORY_MESSAGES: usize = 12;
const MAX_MEMORY_SNIPPETS: usize = 4;
const MAX_REPLY_CHARS: usize = 900;

#[derive(Clone)]
pub struct Orchestrator {
    storage: Storage,
    runtime_bus: RuntimeBus,
    sessions: Arc<RwLock<HashMap<String, broadcast::Sender<SessionEvent>>>>,
    chat_engine: ChatEngine,
}

impl Orchestrator {
    pub fn new(storage: Storage, runtime_bus: RuntimeBus) -> Self {
        Self {
            storage,
            runtime_bus,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            chat_engine: ChatEngine::from_env(),
        }
    }

    pub async fn handle_chat(&self, request: ChatRequest) -> Result<ChatResponse> {
        let session_id = request
            .session_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        self.storage
            .append_message(NewMessageRecord {
                session_id: session_id.clone(),
                role: MessageRole::User,
                text: request.text.clone(),
            })
            .await?;

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

        let response_text = self
            .chat_engine
            .generate(&request, &history, &memory_entries, runtime_counts)
            .await?;

        let assistant_message = self
            .storage
            .append_message(NewMessageRecord {
                session_id: session_id.clone(),
                role: MessageRole::Assistant,
                text: response_text.clone(),
            })
            .await?;

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
    system_prompt: String,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Clone)]
struct ChatEngine {
    client: reqwest::Client,
    remote: Option<RemoteModelConfig>,
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
            system_prompt: env::var("MEMORY_SUITE_LLM_SYSTEM_PROMPT")
                .unwrap_or_else(|_| DEFAULT_SYSTEM_PROMPT.into()),
            temperature: parse_f32_env("MEMORY_SUITE_LLM_TEMPERATURE", 0.65),
            max_tokens: parse_u32_env("MEMORY_SUITE_LLM_MAX_TOKENS", 420),
        });

        Self { client, remote }
    }

    async fn generate(
        &self,
        request: &ChatRequest,
        history: &[StoredMessage],
        memory_entries: &[MemoryEntryRecord],
        runtime_counts: Option<RuntimeCounts>,
    ) -> Result<String> {
        let built_in = built_in_response(request, history, memory_entries, runtime_counts);
        if should_prefer_built_in_response(request) {
            return Ok(built_in);
        }

        if let Some(remote) = &self.remote {
            let fallback_timeout_ms = parse_u64_env(
                "MEMORY_SUITE_LLM_FALLBACK_TIMEOUT_MS",
                DEFAULT_REMOTE_FALLBACK_TIMEOUT_MS,
            );
            match tokio::time::timeout(
                Duration::from_millis(fallback_timeout_ms),
                self.complete_remote(remote, request, history, memory_entries),
            )
            .await
            {
                Ok(Ok(text)) if !text.trim().is_empty() => {
                    return Ok(limit_chars(&text, MAX_REPLY_CHARS));
                }
                Ok(Ok(_)) => {
                    tracing::warn!("remote llm returned empty text, using built-in response path");
                }
                Ok(Err(error)) => {
                    tracing::warn!("remote llm failed, using built-in response path: {error}");
                }
                Err(_) => {
                    tracing::warn!(
                        "remote llm exceeded fallback timeout ({} ms), using built-in response path",
                        fallback_timeout_ms
                    );
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
    ) -> Result<String> {
        let payload = json!({
            "model": remote.model,
            "messages": build_remote_messages(remote, request, history, memory_entries),
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
) -> Vec<Value> {
    let mut messages = Vec::new();
    messages.push(json!({
        "role": "system",
        "content": render_system_prompt(remote, request, memory_entries),
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
    remote: &RemoteModelConfig,
    request: &ChatRequest,
    memory_entries: &[MemoryEntryRecord],
) -> String {
    let mut prompt = String::new();
    prompt.push_str(&remote.system_prompt);
    prompt.push_str("\n\nOutput rules:\n");
    prompt.push_str("- Keep it practical and concise.\n");
    prompt.push_str("- Avoid meta statements about being an AI.\n");
    prompt.push_str("- Prefer a short plan when user asks for action.\n");
    if let Some(user_id) = &request.user_id {
        prompt.push_str(&format!("- Current user_id: {user_id}\n"));
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
    matches!(
        request.text.trim().to_ascii_lowercase().as_str(),
        "/help" | "/status" | "/memory"
    )
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
    if lowered == "/help" {
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
        let _fallback_timeout_guard =
            EnvVarGuard::set("MEMORY_SUITE_LLM_FALLBACK_TIMEOUT_MS", "500".into());

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
            .generate(&request, &[], &[], None)
            .await
            .expect("chat response");
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_millis(800),
            "general chat should fall back before a stalled remote response blocks the runtime, but took {:?}",
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
}
