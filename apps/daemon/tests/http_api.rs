use anyhow::Result;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

use daemon::{bootstrap_state, build_router};

#[tokio::test]
async fn exposes_health_and_chat_endpoints_from_the_single_entrypoint() -> Result<()> {
    let state = bootstrap_state().await?;
    let app = build_router(state);

    let health = app
        .clone()
        .oneshot(Request::builder().uri("/api/health").body(Body::empty())?)
        .await?;
    assert_eq!(health.status(), StatusCode::OK);

    let chat = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/chat")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"session_id":"demo","text":"测试统一后端"}"#))?,
        )
        .await?;
    assert_eq!(chat.status(), StatusCode::OK);

    Ok(())
}
