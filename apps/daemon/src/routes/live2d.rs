use std::sync::Arc;

use api_types::{
    Live2dConfigRequest, Live2dEmotionRequest, Live2dSpeechAckRequest, Live2dSpeechAckResponse,
    Live2dSpeechCancelRequest, Live2dSpeechCancelResponse, Live2dSpeechNextResponse,
    Live2dSubtitleRequest,
};
use axum::{
    Json,
    extract::{Path as AxumPath, State},
};

use crate::AppState;

pub(crate) async fn live2d_state(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::Live2dStateRecord>, axum::http::StatusCode> {
    let response = state
        .live2d
        .get_state()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn live2d_subtitle(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Live2dSubtitleRequest>,
) -> Result<Json<api_types::Live2dStateRecord>, axum::http::StatusCode> {
    let response = state
        .live2d
        .set_subtitle(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn live2d_emotion(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Live2dEmotionRequest>,
) -> Result<Json<api_types::Live2dStateRecord>, axum::http::StatusCode> {
    let response = state
        .live2d
        .set_emotion(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn live2d_config(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Live2dConfigRequest>,
) -> Result<Json<api_types::Live2dStateRecord>, axum::http::StatusCode> {
    let response = state
        .live2d
        .set_config(request)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn next_live2d_speech(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Live2dSpeechNextResponse>, axum::http::StatusCode> {
    Ok(Json(Live2dSpeechNextResponse {
        item: state.live2d_speech_queue.next().await,
    }))
}

pub(crate) async fn get_live2d_speech(
    AxumPath(speech_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Live2dSpeechNextResponse>, axum::http::StatusCode> {
    Ok(Json(Live2dSpeechNextResponse {
        item: state.live2d_speech_queue.get(&speech_id).await,
    }))
}

pub(crate) async fn ack_live2d_speech(
    AxumPath(speech_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<Live2dSpeechAckRequest>,
) -> Result<Json<Live2dSpeechAckResponse>, axum::http::StatusCode> {
    let updated_item = state
        .live2d_speech_queue
        .ack(&speech_id, request)
        .await
        .ok_or(axum::http::StatusCode::NOT_FOUND)?;

    Ok(Json(Live2dSpeechAckResponse {
        ok: true,
        item: Some(updated_item),
    }))
}

pub(crate) async fn cancel_live2d_speech(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Live2dSpeechCancelRequest>,
) -> Result<Json<Live2dSpeechCancelResponse>, axum::http::StatusCode> {
    let cancelled_count = state
        .live2d_speech_queue
        .cancel(request.session_id.as_deref(), request.reason.as_deref())
        .await;

    Ok(Json(Live2dSpeechCancelResponse {
        ok: true,
        cancelled_count: cancelled_count as u32,
    }))
}
