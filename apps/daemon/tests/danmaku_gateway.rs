use anyhow::Result;
use api_types::ChatResponse;
use app_config::{
    AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig,
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::build_router;
use tempfile::tempdir;
use tower::ServiceExt;
mod support;
use support::build_test_state;

#[tokio::test]
async fn buffers_danmaku_for_batching_without_mutating_live2d_state() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = build_test_state(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18089,
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
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
    })
    .await?;

    let app = build_router(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/gateway/danmaku")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"session_id":"room-1","user_id":"viewer-7","text":"hello from danmaku"}"#,
                ))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let payload: ChatResponse = serde_json::from_slice(&body)?;
    assert_eq!(payload.session_id, "danmaku-viewer-7");
    assert_eq!(payload.assistant_text, "");
    assert_eq!(payload.speech.status, "buffered");

    let buffered = state.danmaku_buffer.read().await;
    assert_eq!(buffered.len(), 1);
    assert_eq!(buffered[0].0, "viewer-7");
    assert_eq!(buffered[0].1, "hello from danmaku");
    drop(buffered);

    let messages = state.storage.list_messages("room-1").await?;
    assert!(messages.is_empty());

    let live2d = state.live2d.get_state().await?;
    assert_eq!(live2d.subtitle, "");
    assert_eq!(live2d.emotion, "normal");

    Ok(())
}
