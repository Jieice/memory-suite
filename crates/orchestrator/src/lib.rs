pub mod runtime_bus;

use std::{collections::HashMap, sync::Arc};

use anyhow::Result;
use api_types::{
    ChatRequest, ChatResponse, MessageRole, RuntimeEvent, RuntimeEventKind, SessionEvent,
    SessionEventKind,
};
use storage::{NewMessageRecord, Storage};
use tokio::sync::{RwLock, broadcast};
use uuid::Uuid;

pub use runtime_bus::RuntimeBus;

#[derive(Clone)]
pub struct Orchestrator {
    storage: Storage,
    runtime_bus: RuntimeBus,
    sessions: Arc<RwLock<HashMap<String, broadcast::Sender<SessionEvent>>>>,
}

impl Orchestrator {
    pub fn new(storage: Storage, runtime_bus: RuntimeBus) -> Self {
        Self {
            storage,
            runtime_bus,
            sessions: Arc::new(RwLock::new(HashMap::new())),
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

        let response_text = format!("Rust unified daemon received: {}", request.text);
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
            response_text,
            created_at: assistant_message.created_at,
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

#[cfg(test)]
mod tests {
    use api_types::ChatRequest;
    use storage::Storage;
    use tempfile::tempdir;

    use super::{Orchestrator, RuntimeBus};

    #[tokio::test]
    async fn persists_messages_and_broadcasts_session_events() {
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
                text: "统一编排".into(),
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
}
