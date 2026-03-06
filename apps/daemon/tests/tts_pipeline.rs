use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, PythonConfig, ServerConfig, StorageConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use serde_json::Value;
use tempfile::tempdir;
use tokio::time::{Duration, sleep};
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn dispatches_tts_requests_through_the_configured_adapter() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18085,
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
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tts/speak")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "session_id": "tts-session",
                        "text": "dispatch this",
                        "voice": "edge-tts-en"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;
    assert_eq!(payload.get("status").and_then(Value::as_str), Some("queued"));

    let request_id = payload
        .get("request_id")
        .and_then(Value::as_str)
        .expect("tts request id");

    sleep(Duration::from_millis(150)).await;

    let record = state
        .storage
        .get_tts_request(Uuid::parse_str(request_id)?)
        .await?;
    assert_eq!(record.status, "dispatching");
    assert_eq!(record.adapter_id.as_deref(), Some("edge_tts"));

    let adapters = state.storage.list_adapter_runs().await?;
    assert_eq!(adapters.len(), 1);
    assert_eq!(adapters[0].adapter_id, "edge_tts");
    assert_eq!(adapters[0].python_executable, "powershell");

    Ok(())
}
