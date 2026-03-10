use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use serde_json::Value;
use tempfile::tempdir;
use tower::ServiceExt;

#[tokio::test]
async fn persists_danmaku_source_config_and_connection_state_from_rust_endpoints() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18091,
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
            enable_legacy_import: false,
        },
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
    })
    .await?;

    let app = build_router(state);

    let initial_source = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/danmaku/source")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(initial_source.status(), StatusCode::OK);

    let update = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/source")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{
                        "room_id": "556677",
                        "uid": 1024,
                        "buvid": "buvid-test",
                        "cookie": "SESSDATA=redacted;",
                        "signature_mode": "cookie",
                        "connection_mode": "websocket"
                    }"#,
                ))?,
        )
        .await?;
    assert_eq!(update.status(), StatusCode::OK);

    let connect = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/connect")
                .header("content-type", "application/json")
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(connect.status(), StatusCode::OK);

    let state_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/danmaku/state")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(state_response.status(), StatusCode::OK);

    let disconnect = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/disconnect")
                .header("content-type", "application/json")
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(disconnect.status(), StatusCode::OK);

    let source = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/danmaku/source")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(source.status(), StatusCode::OK);

    let source_body = axum::body::to_bytes(source.into_body(), usize::MAX).await?;
    let source_payload: Value = serde_json::from_slice(&source_body)?;
    assert_eq!(
        source_payload.get("room_id").and_then(Value::as_str),
        Some("556677")
    );
    assert_eq!(
        source_payload.get("uid").and_then(Value::as_u64),
        Some(1024)
    );
    assert_eq!(
        source_payload.get("buvid").and_then(Value::as_str),
        Some("buvid-test")
    );
    assert_eq!(
        source_payload.get("signature_mode").and_then(Value::as_str),
        Some("cookie")
    );
    assert_eq!(
        source_payload
            .get("connection_mode")
            .and_then(Value::as_str),
        Some("websocket")
    );
    assert_eq!(
        source_payload.get("has_cookie").and_then(Value::as_bool),
        Some(true)
    );

    let state_check = app
        .oneshot(
            Request::builder()
                .uri("/api/danmaku/state")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(state_check.status(), StatusCode::OK);

    let state_body = axum::body::to_bytes(state_check.into_body(), usize::MAX).await?;
    let state_payload: Value = serde_json::from_slice(&state_body)?;
    let status = state_payload.get("status").and_then(Value::as_str);
    assert!(
        matches!(
            status,
            Some("disconnected") | Some("reconnecting") | Some("connecting") | Some("connected")
        ),
        "unexpected danmaku status after disconnect: {status:?}"
    );
    assert!(
        state_payload
            .get("attempt_count")
            .and_then(Value::as_u64)
            .unwrap_or_default()
            >= 1
    );
    assert!(state_payload.get("last_connect_attempt_at").is_some());
    assert!(state_payload.get("updated_at").is_some());

    Ok(())
}



