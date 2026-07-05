use std::sync::Arc;

use api_types::{PersonaRuntimeConfigUpdateRequest, PersonaRuntimeStateRecord};
use axum::{Json, extract::State, http::StatusCode};

use crate::AppState;

pub(crate) async fn persona_state(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PersonaRuntimeStateRecord>, StatusCode> {
    state
        .storage
        .get_persona_runtime_state()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn persona_config(
    State(state): State<Arc<AppState>>,
    Json(request): Json<PersonaRuntimeConfigUpdateRequest>,
) -> Result<Json<PersonaRuntimeStateRecord>, StatusCode> {
    let current = state
        .storage
        .get_persona_runtime_state()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mode = request.mode.unwrap_or(current.mode);
    let tone_profile = request.tone_profile.unwrap_or(current.tone_profile);
    let warmth = request.warmth.unwrap_or(current.warmth);
    let sarcasm = request.sarcasm.unwrap_or(current.sarcasm);
    let autonomy = request.autonomy.unwrap_or(current.autonomy);
    let current_context = request.current_context.unwrap_or(current.current_context);
    let current_mood = request.current_mood.unwrap_or(current.current_mood);

    state
        .storage
        .upsert_persona_runtime_config(
            &mode,
            &tone_profile,
            warmth,
            sarcasm,
            autonomy,
            &current_context,
            &current_mood,
        )
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    state
        .storage
        .get_persona_runtime_state()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
