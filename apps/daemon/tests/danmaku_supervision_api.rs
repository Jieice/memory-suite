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
async fn updates_heartbeat_and_reconnect_schedule_under_rust_control() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18095,
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
            enable_legacy_import: true,
        },
    })
    .await?;

    let app = build_router(state);

    let heartbeat = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/heartbeat")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"upstream_host":"heartbeat.example"}"#))?,
        )
        .await?;
    assert_eq!(heartbeat.status(), StatusCode::OK);

    let heartbeat_body = axum::body::to_bytes(heartbeat.into_body(), usize::MAX).await?;
    let heartbeat_payload: Value = serde_json::from_slice(&heartbeat_body)?;
    assert_eq!(
        heartbeat_payload.get("status").and_then(Value::as_str),
        Some("connected")
    );
    assert_eq!(
        heartbeat_payload
            .get("current_upstream_host")
            .and_then(Value::as_str),
        Some("heartbeat.example")
    );
    assert_eq!(
        heartbeat_payload
            .get("consecutive_failures")
            .and_then(Value::as_u64),
        Some(0)
    );
    assert!(heartbeat_payload.get("last_heartbeat_at").is_some());

    let disconnect_one = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/report-disconnect")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"reason":"heartbeat timeout"}"#))?,
        )
        .await?;
    assert_eq!(disconnect_one.status(), StatusCode::OK);

    let disconnect_one_body = axum::body::to_bytes(disconnect_one.into_body(), usize::MAX).await?;
    let disconnect_one_payload: Value = serde_json::from_slice(&disconnect_one_body)?;
    assert_eq!(
        disconnect_one_payload.get("status").and_then(Value::as_str),
        Some("reconnecting")
    );
    assert_eq!(
        disconnect_one_payload
            .get("consecutive_failures")
            .and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        disconnect_one_payload
            .get("retry_delay_ms")
            .and_then(Value::as_u64),
        Some(1000)
    );
    assert!(disconnect_one_payload.get("next_retry_at").is_some());

    let disconnect_two = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/report-disconnect")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"reason":"socket closed"}"#))?,
        )
        .await?;
    assert_eq!(disconnect_two.status(), StatusCode::OK);

    let disconnect_two_body = axum::body::to_bytes(disconnect_two.into_body(), usize::MAX).await?;
    let disconnect_two_payload: Value = serde_json::from_slice(&disconnect_two_body)?;
    assert_eq!(
        disconnect_two_payload
            .get("consecutive_failures")
            .and_then(Value::as_u64),
        Some(2)
    );
    assert_eq!(
        disconnect_two_payload
            .get("retry_delay_ms")
            .and_then(Value::as_u64),
        Some(2000)
    );

    Ok(())
}
