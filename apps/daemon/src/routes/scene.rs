use std::sync::Arc;

use api_types::{
    ChatRequest, RuntimeEvent, RuntimeEventKind, SceneContextRecord, SceneContextRequest,
    SceneEventRecord, SceneEventRequest, SceneSuggestionResponse,
};
use axum::{Json, extract::State, http::StatusCode};

use crate::AppState;

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

pub(crate) async fn scene_event(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SceneEventRequest>,
) -> Result<Json<SceneEventRecord>, StatusCode> {
    let record = SceneEventRecord {
        id: uuid::Uuid::new_v4().to_string(),
        kind: request.kind.clone(),
        detail: request.detail.clone(),
        created_at: chrono::Utc::now(),
    };

    {
        let mut events = state.scene_events.write().await;
        if events.len() >= 20 {
            events.pop_front();
        }
        events.push_back(record.clone());
    }

    publish_runtime_event(
        &state,
        RuntimeEventKind::MessageCreated,
        format!("scene:{}", request.kind),
        request.detail.clone(),
    );

    Ok(Json(record))
}

pub(crate) async fn scene_context(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SceneContextRequest>,
) -> Result<Json<SceneContextRecord>, StatusCode> {
    let record = SceneContextRecord {
        description: request.description,
        ttl_turns: request.ttl_turns.unwrap_or(5),
        updated_at: chrono::Utc::now(),
    };
    *state.scene_context.write().await = Some(record.clone());
    Ok(Json(record))
}

pub(crate) async fn get_scene_context(
    State(state): State<Arc<AppState>>,
) -> Json<Option<SceneContextRecord>> {
    Json(state.scene_context.read().await.clone())
}

pub(crate) async fn scene_suggest(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SceneSuggestionResponse>, StatusCode> {
    let ctx = state.scene_context.read().await.clone();
    let events = state.scene_events.read().await;
    let recent_events: Vec<_> = events
        .iter()
        .rev()
        .take(5)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    let mut hint_parts = Vec::new();
    if let Some(ref c) = ctx {
        hint_parts.push(format!("Current scene: {}", c.description));
    }
    for e in &recent_events {
        hint_parts.push(format!(
            "Event: {} — {}",
            e.kind,
            e.detail.as_deref().unwrap_or("")
        ));
    }
    let scene_hint = if hint_parts.is_empty() {
        None
    } else {
        Some(hint_parts.join("\n"))
    };

    let prompt = "根据当前场景和事件，用一句话建议接下来角色应该做什么或说什么。直接给出行动建议。"
        .to_string();
    let request = ChatRequest {
        session_id: Some("scene-suggest".into()),
        user_id: Some("scene-system".into()),
        text: prompt,
    };

    let response = state
        .orchestrator
        .handle_chat_with_scene(request, scene_hint.clone())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(SceneSuggestionResponse {
        suggestion: response.assistant_text,
        scene_context: scene_hint,
    }))
}

pub(crate) async fn reaction_event(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let reaction = body
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("heart")
        .to_string();
    let source = body
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("audience")
        .to_string();

    let valid = ["laugh", "surprised", "heart", "clap", "wow"];
    if !valid.contains(&reaction.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let record = SceneEventRecord {
        id: uuid::Uuid::new_v4().to_string(),
        kind: format!("reaction:{reaction}"),
        detail: Some(source.clone()),
        created_at: chrono::Utc::now(),
    };

    {
        let mut events = state.scene_events.write().await;
        if events.len() >= 20 {
            events.pop_front();
        }
        events.push_back(record);
    }

    publish_runtime_event(
        &state,
        RuntimeEventKind::MessageCreated,
        format!("reaction:{reaction}"),
        Some(source),
    );

    Ok(Json(serde_json::json!({ "ok": true, "kind": reaction })))
}
