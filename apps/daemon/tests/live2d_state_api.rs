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
async fn persists_and_reads_live2d_runtime_state_from_rust_endpoints() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18087,
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

    let app = build_router(state);

    let subtitle = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/live2d/subtitle")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"text":"hello overlay","duration_ms":2200}"#))?,
        )
        .await?;
    assert_eq!(subtitle.status(), StatusCode::OK);

    let emotion = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/live2d/emotion")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"emotion":"happy"}"#))?,
        )
        .await?;
    assert_eq!(emotion.status(), StatusCode::OK);

    let config = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/live2d/config")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"scale":0.42,"x":0.25,"y":0.61}"#))?,
        )
        .await?;
    assert_eq!(config.status(), StatusCode::OK);

    let state_response = app
        .oneshot(Request::builder().uri("/api/live2d/state").body(Body::empty())?)
        .await?;
    assert_eq!(state_response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(state_response.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;

    assert_eq!(payload.get("subtitle").and_then(Value::as_str), Some("hello overlay"));
    assert_eq!(payload.get("emotion").and_then(Value::as_str), Some("happy"));
    assert_eq!(payload.get("subtitle_duration_ms").and_then(Value::as_u64), Some(2200));
    assert_eq!(
        payload
            .get("config")
            .and_then(|value| value.get("scale"))
            .and_then(Value::as_f64),
        Some(0.42)
    );

    Ok(())
}
