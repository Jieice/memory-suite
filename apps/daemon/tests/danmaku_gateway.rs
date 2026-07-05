use anyhow::Result;
use api_types::{ChatResponse, MessageRole};
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
async fn injects_gateway_danmaku_through_real_chat_and_tts_chain() -> Result<()> {
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
    assert_eq!(payload.session_id, "room-1");
    assert!(payload.assistant_text.trim().is_empty());
    assert_eq!(payload.speech.status, "not_requested");

    let buffered = state.danmaku_buffer.read().await;
    assert!(buffered.is_empty());
    drop(buffered);

    let messages = state.storage.list_messages("room-1").await?;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].text, "hello from danmaku");
    assert_eq!(messages[0].role, MessageRole::User);

    Ok(())
}
