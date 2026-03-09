use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, PythonConfig, ServerConfig, StorageConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use serde_json::Value;
use tempfile::tempdir;
use tower::ServiceExt;

#[tokio::test]
async fn persists_helper_session_open_error_and_close_callbacks() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18096,
        },
        storage: StorageConfig {
            database_path: runtime_root
                .join("memory-suite.db")
                .to_string_lossy()
                .to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: PythonConfig {
            executable: "powershell".into(),
            models_root: dir.path().join("python").to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
        },
    })
    .await?;

    let app = build_router(state);

    let open = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/session/open")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"session_id":"sess-42","upstream_host":"ws-primary.example"}"#,
                ))?,
        )
        .await?;
    assert_eq!(open.status(), StatusCode::OK);

    let error = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/session/error")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"session_id":"sess-42","reason":"protocol parse error"}"#,
                ))?,
        )
        .await?;
    assert_eq!(error.status(), StatusCode::OK);

    let close = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/session/close")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"session_id":"sess-42","reason":"normal closure"}"#,
                ))?,
        )
        .await?;
    assert_eq!(close.status(), StatusCode::OK);

    let state_response = app
        .oneshot(
            Request::builder()
                .uri("/api/danmaku/state")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(state_response.status(), StatusCode::OK);

    let state_body = axum::body::to_bytes(state_response.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&state_body)?;
    assert_eq!(
        payload.get("status").and_then(Value::as_str),
        Some("disconnected")
    );
    assert_eq!(
        payload.get("session_id").and_then(Value::as_str),
        Some("sess-42")
    );
    assert_eq!(
        payload.get("current_upstream_host").and_then(Value::as_str),
        Some("ws-primary.example")
    );
    assert_eq!(
        payload.get("last_error").and_then(Value::as_str),
        Some("protocol parse error")
    );
    assert_eq!(
        payload.get("last_close_reason").and_then(Value::as_str),
        Some("normal closure")
    );

    Ok(())
}
