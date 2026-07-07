use std::sync::Arc;

use api_types::{SceneContextRecord, VisionObserveRequest, VisionObserveResponse};
use axum::{Json, extract::State};

use crate::AppState;

/// Describe a captured screen frame with the configured vision model and, when
/// requested, publish the description into scene context so the chat pipeline
/// reacts to what's on screen. Never fails the request hard — capture loops
/// poll this frequently and should keep running through transient errors.
pub(crate) async fn vision_observe(
    State(state): State<Arc<AppState>>,
    Json(request): Json<VisionObserveRequest>,
) -> Json<VisionObserveResponse> {
    if !state.vision.is_enabled() {
        return Json(VisionObserveResponse {
            ok: false,
            description: String::new(),
            latency_ms: None,
            applied: false,
            message: "屏幕识别未启用".into(),
        });
    }

    let config = state.vision.current_config();
    match state.vision.describe(&config, &request).await {
        Ok(mut response) => {
            let apply = request.apply_to_scene.unwrap_or(true);
            if apply && !response.description.trim().is_empty() {
                let ttl_turns = state.vision.ttl_turns();
                let record = SceneContextRecord {
                    description: response.description.clone(),
                    ttl_turns,
                    updated_at: chrono::Utc::now(),
                };
                *state.scene_context.write().await = Some(record);
                response.applied = true;
            }
            Json(response)
        }
        Err(error) => Json(VisionObserveResponse {
            ok: false,
            description: String::new(),
            latency_ms: None,
            applied: false,
            message: error.to_string(),
        }),
    }
}
