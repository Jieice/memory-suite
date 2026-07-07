use anyhow::Result;
use app_config::{
    AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig,
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{build_router, AppState};
use serde_json::Value;
use tempfile::tempdir;
use tower::ServiceExt;
mod support;
use support::prepare_placeholder_tts_scripts;

#[tokio::test]
async fn starts_and_lists_supervised_tts_adapter_runs() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let python_root = dir.path().join("python");
    prepare_placeholder_tts_scripts(&python_root).await?;
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18083,
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
            models_root: python_root.to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
        },
        tts: TtsConfig::default(),
        stt: app_config::SttConfig {
            provider: Some("openai-compatible".into()),
            ..app_config::SttConfig::default()
        },
        llm: LlmConfig::default(),
        vision: app_config::VisionConfig::default(),
    })
    .await?;

    let app = build_router(state);

    let start = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/runtime/adapters/edge_tts/start")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(start.status(), StatusCode::OK);
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;

    let adapters = app
        .oneshot(
            Request::builder()
                .uri("/api/runtime/adapters")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(adapters.status(), StatusCode::OK);

    let body = axum::body::to_bytes(adapters.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;
    let records = payload.as_array().expect("adapter list");
    assert_eq!(records.len(), 1);

    let adapter = &records[0];
    assert_eq!(
        adapter.get("adapter_id").and_then(Value::as_str),
        Some("edge_tts")
    );
    assert_eq!(
        adapter.get("status").and_then(Value::as_str),
        Some("running")
    );
    assert!(adapter.get("python_executable").is_none());
    assert!(adapter.get("args").is_none());
    assert!(adapter.get("pid").is_none());

    Ok(())
}

#[tokio::test]
async fn rejects_unsupported_adapter_ids_instead_of_starting_placeholders() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let python_root = dir.path().join("python");
    prepare_placeholder_tts_scripts(&python_root).await?;
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18084,
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
            models_root: python_root.to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
        },
        tts: TtsConfig::default(),
        stt: app_config::SttConfig {
            provider: Some("openai-compatible".into()),
            ..app_config::SttConfig::default()
        },
        llm: LlmConfig::default(),
        vision: app_config::VisionConfig::default(),
    })
    .await?;

    let app = build_router(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/runtime/adapters/tts/start")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let text = String::from_utf8_lossy(&body);
    assert!(text.is_empty());

    let records = state.storage.list_adapter_runs().await?;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].adapter_id, "tts");
    assert_eq!(records[0].status, api_types::AdapterStatus::Failed);
    assert!(records[0]
        .last_error
        .as_deref()
        .is_some_and(|value| value.contains("supported adapters")));

    Ok(())
}
