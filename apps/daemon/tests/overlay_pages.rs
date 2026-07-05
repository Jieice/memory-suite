use std::{fs, path::PathBuf};

use anyhow::Result;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

use daemon::{bootstrap_state, build_router};

#[tokio::test]
async fn live2d_overlay_keeps_subtitle_visible_until_playback_ends_and_reveals_it_progressively()
-> Result<()> {
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
    assert!(html.contains("const subtitle = subtitleProgressText("));
    assert!(html.contains("subtitleEl.textContent = subtitle;"));
    assert!(!html.contains("subtitleEl.textContent = fullText || '等待 Live2D 字幕...'"));
    assert!(html.contains(
        "if (!speechState.currentId && !speechState.finishingId && !speechState.blockedItem) {"
    ));
    assert!(html.contains("if (!speechState.currentId && typeof model.motion === 'function')"));
    assert!(html.contains("if (expectedText?.trim() && nextDuration > 0) {"));
    assert!(html.contains("subtitleEl.textContent.trim().length > 0"));
    assert!(html.contains("scheduleSubtitleClear(item.assistant_text, 2000);"));
    assert!(
        !html.contains("scheduleSubtitleClear(item.assistant_text, item?.speech?.duration_ms);")
    );
    assert!(html.contains("const SPEECH_POLL_INTERVAL_MS = 1200;"));
    assert!(html.contains("}, SPEECH_POLL_INTERVAL_MS);"));
    assert!(html.contains("app.ticker.maxFPS = LIVE2D_TARGET_FPS;"));
    assert!(html.contains("app.ticker.minFPS = LIVE2D_MIN_FPS;"));
    assert!(html.contains("resolution: Math.min(window.devicePixelRatio || 1, LIVE2D_MAX_DPR),"));
    assert!(html.contains("antialias: false,"));

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
async fn live2d_overlay_does_not_block_playback_on_audio_context_resume() -> Result<()> {
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

    assert!(html.contains("if (context && context.state === 'suspended')"));
    assert!(html.contains("void context.resume().catch(() => {});"));
    assert!(!html.contains("await context.resume();"));

    Ok(())
}

#[tokio::test]
async fn live2d_overlay_does_not_ack_failed_immediately_when_autoplay_is_blocked() -> Result<()> {
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

    assert!(html.contains("error instanceof Error && error.name === 'NotAllowedError'"));
    assert!(html.contains("setSpeechStatus(`等待交互 ${item.id.slice(0, 8)}`)"));
    assert!(html.contains("startSubtitleLoop(item);"));
    assert!(html.contains("return;"));

    Ok(())
}

#[tokio::test]
async fn live2d_overlay_stops_polling_for_more_speech_while_waiting_for_user_interaction()
-> Result<()> {
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

    assert!(html.contains("speechState.blockedItem = item;"));
    assert!(html.contains("speechState.fetchingNext || speechState.blockedItem"));
    assert!(html.contains("!speechState.blockedItem"));
    assert!(html.contains("void tryResumeBlockedSpeech();"));

    Ok(())
}

#[tokio::test]
async fn live2d_overlay_keeps_subtitle_visible_while_waiting_for_user_interaction() -> Result<()> {
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

    assert!(
        !html.contains("scheduleSubtitleClear(item.assistant_text, item?.speech?.duration_ms);")
    );
    assert!(html.contains("error instanceof Error && error.name === 'NotAllowedError'"));
    assert!(html.contains("speechState.blockedItem = item;"));
    assert!(html.contains("if (clearSubtitleTimer) {"));
    assert!(html.contains("clearTimeout(clearSubtitleTimer);"));
    assert!(html.contains("clearSubtitleTimer = null;"));

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
    assert!(html.contains("if (item.speech?.status !== 'ready' || !item.speech?.audio_url)"));
    assert!(html.contains("await audio.play();"));
    assert!(html.contains("拖动角色可调整位置"));
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
