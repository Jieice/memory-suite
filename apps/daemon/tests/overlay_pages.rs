use anyhow::Result;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

use daemon::{bootstrap_state, build_router};

#[tokio::test]
async fn serves_real_live2d_overlay_page_instead_of_placeholder_html() -> Result<()> {
    let state = bootstrap_state().await?;
    let app = build_router(state);

    let response = app
        .clone()
        .oneshot(Request::builder().uri("/overlay/live2d").body(Body::empty())?)
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let html = String::from_utf8(body.to_vec())?;

    assert!(html.contains("data-overlay=\"live2d\""));
    assert!(html.contains("/api/live2d/state"));
    assert!(html.contains("/ws/overlay"));
    assert!(html.contains("/live2d-assets/hiyori_pro_t11.model3.json"));
    assert!(!html.contains("overlay endpoint is active"));

    Ok(())
}

#[tokio::test]
async fn serves_real_danmaku_overlay_page_instead_of_placeholder_html() -> Result<()> {
    let state = bootstrap_state().await?;
    let app = build_router(state);

    let response = app
        .oneshot(Request::builder().uri("/overlay/danmaku").body(Body::empty())?)
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
