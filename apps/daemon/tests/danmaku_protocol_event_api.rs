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
async fn normalizes_helper_protocol_events_inside_rust() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18098,
        },
        storage: StorageConfig {
            database_path: runtime_root.join("memory-suite.db").to_string_lossy().to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: PythonConfig {
            executable: "powershell".into(),
            models_root: dir.path().join("python").to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
            enable_legacy_import: true,
        },
    })
    .await?;

    let app = build_router(state.clone());

    let danmaku = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/protocol-event")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{
                        "session_id":"room-raw",
                        "event_type":"danmaku",
                        "username":"viewer-a",
                        "message":"hello native path"
                    }"#,
                ))?,
        )
        .await?;
    assert_eq!(danmaku.status(), StatusCode::OK);

    let gift = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/protocol-event")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{
                        "session_id":"room-raw",
                        "event_type":"gift",
                        "username":"viewer-b",
                        "message":"辣条",
                        "count":3
                    }"#,
                ))?,
        )
        .await?;
    assert_eq!(gift.status(), StatusCode::OK);

    let messages = state.storage.list_messages("room-raw").await?;
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0].text, "hello native path");
    assert!(messages[2].text.contains("viewer-b"));
    assert!(messages[2].text.contains("辣条"));

    let live2d = state.live2d.get_state().await?;
    assert!(live2d.subtitle.contains("辣条"));

    let adapters = app
        .oneshot(Request::builder().uri("/api/runtime/overview").body(Body::empty())?)
        .await?;
    assert_eq!(adapters.status(), StatusCode::OK);

    let body = axum::body::to_bytes(adapters.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;
    assert_eq!(payload.get("message_count").and_then(Value::as_u64), Some(4));

    Ok(())
}
