use anyhow::Result;
use app_config::{
    AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig,
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, bootstrap_state, build_router};
use serde_json::Value;
use tempfile::{TempDir, tempdir};
use tower::ServiceExt;
mod support;
use support::prepare_placeholder_tts_scripts;

struct ChatTestFixture {
    _dir: TempDir,
    state: AppState,
}

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
                .body(Body::from(
                    r#"{"session_id":"demo","text":"娴嬭瘯缁熶竴鍚庣"}"#,
                ))?,
        )
        .await?;
    assert_eq!(chat.status(), StatusCode::OK);

    Ok(())
}

async fn test_state_for_chat() -> Result<ChatTestFixture> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let python_root = dir.path().join("python");
    prepare_placeholder_tts_scripts(&python_root).await?;
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
            models_root: python_root.to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
        },
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
    })
    .await?;

    Ok(ChatTestFixture { _dir: dir, state })
}

#[tokio::test]
async fn chat_main_path_works_without_prestarted_python_tts_worker() -> Result<()> {
    let fixture = test_state_for_chat().await?;
    let state = fixture.state.clone();
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
        payload.get("assistant_text").and_then(Value::as_str),
        Some("")
    );
    let speech_status = payload
        .get("speech")
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .expect("speech status");
    assert_eq!(speech_status, "not_requested");

    let stored = state.storage.list_messages("rust-only-chat").await?;
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].text, "hello rust main path");

    Ok(())
}

#[tokio::test]
async fn chat_preserves_utf8_chinese_text_in_request_and_storage() -> Result<()> {
    let fixture = test_state_for_chat().await?;
    let state = fixture.state.clone();
    let app = build_router(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/chat")
                .header("content-type", "application/json; charset=utf-8")
                .body(Body::from(
                    serde_json::json!({
                        "session_id": "utf8-chat",
                        "user_id": "operator",
                        "text": "我接下来该做什么？"
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));

    let payload: Value = serde_json::from_slice(&body)?;
    let assistant_text = payload
        .get("assistant_text")
        .and_then(Value::as_str)
        .expect("assistant text");
    assert!(assistant_text.trim().is_empty());

    let stored = state.storage.list_messages("utf8-chat").await?;
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].text, "我接下来该做什么？");

    Ok(())
}
