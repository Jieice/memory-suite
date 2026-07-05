use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use api_types::TtsSpeakRequest;
use axum::{
    Json,
    extract::{Path as AxumPath, State},
    response::IntoResponse,
};

use crate::AppState;
use crate::paths::resolve_runtime_path;

pub(crate) async fn tts_speak(
    State(state): State<Arc<AppState>>,
    Json(request): Json<TtsSpeakRequest>,
) -> Result<Json<api_types::TtsSpeakResponse>, axum::http::StatusCode> {
    let response = state
        .tts
        .enqueue(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn tts_audio_file(
    AxumPath(request_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    let parsed_id =
        uuid::Uuid::parse_str(&request_id).map_err(|_| axum::http::StatusCode::BAD_REQUEST)?;
    let record = state
        .storage
        .get_tts_request(parsed_id)
        .await
        .map_err(|_| axum::http::StatusCode::NOT_FOUND)?;
    let audio_path = record
        .audio_path
        .map(PathBuf::from)
        .ok_or(axum::http::StatusCode::NOT_FOUND)?;

    let data_root = resolve_runtime_path(&state.config.storage.data_root).join("audio-cache");
    let canonical_root =
        fs::canonicalize(&data_root).map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let canonical_audio =
        fs::canonicalize(&audio_path).map_err(|_| axum::http::StatusCode::NOT_FOUND)?;
    if !canonical_audio.starts_with(&canonical_root) {
        return Err(axum::http::StatusCode::FORBIDDEN);
    }

    let audio = tokio::fs::read(&canonical_audio)
        .await
        .map_err(|_| axum::http::StatusCode::NOT_FOUND)?;
    let content_type = mime_from_audio_extension(&canonical_audio);

    Ok(([(axum::http::header::CONTENT_TYPE, content_type)], audio))
}

fn mime_from_audio_extension(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("aac") => "audio/aac",
        Some("flac") => "audio/flac",
        _ => "audio/mpeg",
    }
}
