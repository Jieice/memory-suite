use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, PythonConfig, ServerConfig, StorageConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, bootstrap_state, build_router};
use serde_json::Value;
use tempfile::tempdir;
use tower::ServiceExt;

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

#[tokio::test]
async fn chat_main_path_works_without_brainnn_runtime() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18087,
        },
        storage: StorageConfig {
            database_path: runtime_root
                .join("memory-suite.db")
                .to_string_lossy()
                .to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: PythonConfig {
            executable: "python".into(),
            models_root: dir.path().join("python").to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
        },
    })
    .await?;
    let app = build_router(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/chat")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "session_id": "rust-only-chat",
                        "user_id": "operator",
                        "text": "hello rust main path"
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));

    let payload: Value = serde_json::from_slice(&body)?;
    assert_eq!(
        payload.get("session_id").and_then(Value::as_str),
        Some("rust-only-chat")
    );
    assert!(
        payload
            .get("assistant_text")
            .and_then(Value::as_str)
            .is_some()
    );
    assert_eq!(
        payload
            .get("speech")
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str),
        Some("failed")
    );

    let stored = state.storage.list_messages("rust-only-chat").await?;
    assert_eq!(stored.len(), 2);
    assert_eq!(stored[0].text, "hello rust main path");

    Ok(())
}
