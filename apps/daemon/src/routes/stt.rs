use std::sync::Arc;

use api_types::{SttTranscribeRequest, SttTranscribeResponse};
use axum::{Json, extract::State};

use crate::AppState;

pub(crate) async fn stt_transcribe(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SttTranscribeRequest>,
) -> Json<SttTranscribeResponse> {
    match state.stt.transcribe(request).await {
        Ok(response) => Json(response),
        Err(error) => {
            let config = state.stt.current_config();
            Json(SttTranscribeResponse {
                ok: false,
                provider: config.provider.unwrap_or_else(|| "faster-whisper".into()),
                endpoint: config.endpoint.unwrap_or_default(),
                text: String::new(),
                detected_language: None,
                latency_ms: None,
                message: error.to_string(),
            })
        }
    }
}
