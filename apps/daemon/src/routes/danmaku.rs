use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
};

use crate::AppState;

pub(crate) async fn gateway_danmaku(
    State(state): State<Arc<AppState>>,
    Json(request): Json<api_types::DanmakuInjectRequest>,
) -> Result<Json<api_types::ChatResponse>, StatusCode> {
    {
        let mut audience = state.audience.write().await;
        let entry = audience.entry(request.user_id.clone()).or_insert((
            0,
            String::new(),
            std::time::Instant::now(),
        ));
        entry.0 += 1;
        entry.1 = request.text.chars().take(40).collect();
        entry.2 = std::time::Instant::now();
    }

    {
        let mut buf = state.danmaku_buffer.write().await;
        buf.push((
            request.user_id.clone(),
            request.text.clone(),
            std::time::Instant::now(),
        ));
    }

    Ok(Json(api_types::ChatResponse {
        session_id: format!("danmaku-{}", request.user_id),
        message_id: uuid::Uuid::new_v4(),
        assistant_text: String::new(),
        created_at: chrono::Utc::now(),
        speech: api_types::SpeechPlaybackPlan {
            request_id: uuid::Uuid::new_v4().to_string(),
            status: "buffered".into(),
            audio_url: None,
            duration_ms: 0,
            viseme_timeline: Vec::new(),
            error: None,
        },
        animation: api_types::Live2dAnimationPlan {
            emotion: "normal".into(),
            subtitle_text: String::new(),
            motion_timeline: Vec::new(),
        },
        events: Vec::new(),
        timing: None,
    }))
}

pub(crate) async fn danmaku_source(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuSourceConfigRecord>, StatusCode> {
    let response = state
        .gateway
        .get_source_config()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn update_danmaku_source(
    State(state): State<Arc<AppState>>,
    Json(request): Json<api_types::DanmakuSourceUpdateRequest>,
) -> Result<Json<api_types::DanmakuSourceConfigRecord>, StatusCode> {
    let response = state
        .gateway
        .update_source_config(request)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn danmaku_state(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuConnectionStateRecord>, StatusCode> {
    let response = state
        .gateway
        .get_connection_state()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn connect_danmaku(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuConnectionActionResponse>, StatusCode> {
    let response = state
        .gateway
        .connect()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn bootstrap_danmaku(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuBootstrapRecord>, StatusCode> {
    let response = state
        .gateway
        .bootstrap()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn danmaku_native_probe(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuNativeProbeResponse>, StatusCode> {
    let response = state
        .gateway
        .native_probe()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn danmaku_native_connect_once(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuNativeConnectResponse>, StatusCode> {
    let response = state
        .gateway
        .native_connect_once()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn danmaku_native_session_start(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuConnectionActionResponse>, StatusCode> {
    let response = state
        .gateway
        .start_native_session("manual_api")
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

pub(crate) async fn disconnect_danmaku(
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::DanmakuConnectionActionResponse>, StatusCode> {
    let response = state
        .gateway
        .disconnect()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}
