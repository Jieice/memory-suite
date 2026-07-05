use std::sync::Arc;

use axum::{
    extract::{Path as AxumPath, State, WebSocketUpgrade, ws::Message},
    response::IntoResponse,
};

use crate::AppState;

pub(crate) async fn session_ws(
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

pub(crate) async fn runtime_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
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

pub(crate) async fn overlay_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
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
