use std::{fs, path::PathBuf};

use anyhow::Result;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

use daemon::{bootstrap_state, build_router};

#[tokio::test]
async fn live2d_overlay_uses_subtitle_duration_to_auto_clear_text() -> Result<()> {
    ensure_live2d_core_runtime_fixture()?;
    let state = bootstrap_state().await?;
    let app = build_router(state);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/overlay/live2d")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let html = String::from_utf8(body.to_vec())?;

    assert!(html.contains("subtitle_duration_ms"));
    assert!(html.contains("clearSubtitleTimer"));
    assert!(html.contains("setTimeout(() => {"));
    assert!(html.contains("subtitleEl.textContent = '等待 Live2D 字幕...'"));
    assert!(html.contains("item?.assistant_text"));
    assert!(html.contains("item?.speech?.duration_ms"));
    assert!(html.contains("function subtitleProgressText(text, elapsedMs, durationMs)"));
    assert!(html.contains("subtitleEl.textContent = subtitleProgressText("));
    assert!(html.contains("if (!speechState.currentId) {"));
    assert!(html.contains("if (!speechState.currentId && typeof model.motion === 'function')"));
    assert!(html.contains("if (expectedText?.trim() && nextDuration > 0 && !speechState.subtitleLoop)"));
    assert!(html.contains("subtitleEl.textContent.trim().length > 0"));

    Ok(())
}

#[tokio::test]
async fn danmaku_overlay_refreshes_status_periodically() -> Result<()> {
    ensure_live2d_core_runtime_fixture()?;
    let state = bootstrap_state().await?;
    let app = build_router(state);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/overlay/danmaku")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let html = String::from_utf8(body.to_vec())?;

    assert!(html.contains("setInterval(() => {"));
    assert!(html.contains("void refreshStatus()"));

    Ok(())
}

#[tokio::test]
async fn danmaku_overlay_keeps_recent_message_stack_instead_of_timed_removal() -> Result<()> {
    ensure_live2d_core_runtime_fixture()?;
    let state = bootstrap_state().await?;
    let app = build_router(state);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/overlay/danmaku")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let html = String::from_utf8(body.to_vec())?;

    assert!(html.contains("while (list.children.length > 6)"));
    assert!(!html.contains("setTimeout(() => item.remove(), 22000)"));

    Ok(())
}

#[tokio::test]
async fn serves_real_live2d_overlay_page_instead_of_placeholder_html() -> Result<()> {
    ensure_live2d_core_runtime_fixture()?;
    let state = bootstrap_state().await?;
    let app = build_router(state);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/overlay/live2d")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let html = String::from_utf8(body.to_vec())?;

    assert!(html.contains("data-overlay=\"live2d\""));
    assert!(html.contains("/api/live2d/state"));
    assert!(html.contains("/api/live2d/config"));
    assert!(html.contains("/api/live2d/speech/next"));
    assert!(html.contains("/api/live2d/speech/"));
    assert!(html.contains("/ws/overlay"));
    assert!(html.contains("/live2d-assets/hiyori_pro_t11.model3.json"));
    assert!(html.contains("/overlay-vendor/live2d-core/live2dcubismcore.min.js"));
    assert!(html.contains("/overlay-vendor/pixi/pixi.min.js"));
    assert!(html.contains("/overlay-vendor/live2d/cubism4.min.js"));
    assert!(html.contains("ParamMouthOpenY"));
    assert!(html.contains("maybePlayNextSpeech"));
    assert!(html.contains("speech-status"));
    assert!(html.contains("drag to reposition"));
    assert!(html.contains("pointerdown"));
    assert!(html.contains("z-index: 0;"));
    assert!(html.contains("z-index: 2;"));
    assert!(!html.contains("overlay endpoint is active"));

    Ok(())
}

#[tokio::test]
async fn serves_real_danmaku_overlay_page_instead_of_placeholder_html() -> Result<()> {
    ensure_live2d_core_runtime_fixture()?;
    let state = bootstrap_state().await?;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/overlay/danmaku")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let html = String::from_utf8(body.to_vec())?;

    assert!(html.contains("data-overlay=\"danmaku\""));
    assert!(html.contains("/ws/overlay"));
    assert!(html.contains("overlay-event-list"));
    assert!(!html.contains("gateway overlay is active"));

    Ok(())
}

#[tokio::test]
async fn serves_live2d_model_assets_from_the_workspace_runtime_directory() -> Result<()> {
    ensure_live2d_core_runtime_fixture()?;
    let state = bootstrap_state().await?;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/live2d-assets/hiyori_pro_t11.model3.json")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let json = String::from_utf8(body.to_vec())?;
    assert!(json.contains("\"Moc\""));
    assert!(json.contains("\"Textures\""));

    Ok(())
}

#[tokio::test]
async fn serves_local_overlay_runtime_vendor_assets() -> Result<()> {
    ensure_live2d_core_runtime_fixture()?;
    let state = bootstrap_state().await?;
    let app = build_router(state);

    let pixi = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/overlay-vendor/pixi/pixi.min.js")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(pixi.status(), StatusCode::OK);

    let live2d = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/overlay-vendor/live2d-core/live2dcubismcore.min.js")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(live2d.status(), StatusCode::OK);

    let cubism = app
        .oneshot(
            Request::builder()
                .uri("/overlay-vendor/live2d/cubism4.min.js")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(cubism.status(), StatusCode::OK);

    Ok(())
}

fn ensure_live2d_core_runtime_fixture() -> Result<()> {
    let runtime_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("runtime")
        .join("overlay-vendor")
        .join("live2d-core");
    fs::create_dir_all(&runtime_dir)?;
    let core_path = runtime_dir.join("live2dcubismcore.min.js");
    if !core_path.exists() {
        fs::write(
            core_path,
            "window.Live2DCubismCore = window.Live2DCubismCore || { _isStarted: false, Logging: {}, Version: {} };",
        )?;
    }
    Ok(())
}
