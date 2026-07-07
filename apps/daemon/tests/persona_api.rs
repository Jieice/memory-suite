use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use serde_json::{Value, json};
use tempfile::tempdir;
use tower::ServiceExt;

async fn test_app() -> Result<(impl tower::Service<Request<Body>, Response = axum::response::Response, Error = std::convert::Infallible> + Clone, tempfile::TempDir)> {
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
            executable: "python".into(),
            models_root: dir.path().join("python").to_string_lossy().to_string(),
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
    Ok((build_router(state), dir))
}

#[tokio::test]
async fn persona_config_round_trips_through_http_api() -> Result<()> {
    let (app, _dir) = test_app().await?;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/persona/config")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "mode": "stream",
                        "tone_profile": "sharp-playful",
                        "warmth": 0.45,
                        "sarcasm": 0.65,
                        "autonomy": 0.20
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;
    assert_eq!(payload["tone_profile"], "sharp-playful");
    assert_eq!(payload["mode"], "stream");

    Ok(())
}

#[tokio::test]
async fn persona_state_returns_defaults_before_any_config() -> Result<()> {
    let (app, _dir) = test_app().await?;

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/persona/state")
                .body(Body::empty())?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;
    assert_eq!(payload["mode"], "stream");
    assert_eq!(payload["tone_profile"], "balanced");
    assert_eq!(payload["fallback"]["last_path"], "none");

    Ok(())
}

#[tokio::test]
async fn persona_config_partial_update_merges_with_existing() -> Result<()> {
    let (app, _dir) = test_app().await?;

    // First: set a full config
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/persona/config")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "mode": "stream",
                        "tone_profile": "sharp-playful",
                        "warmth": 0.45,
                        "sarcasm": 0.65,
                        "autonomy": 0.20
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    // Second: only update tone_profile
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/persona/config")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "tone_profile": "gentle"
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;

    // tone_profile updated, other fields preserved
    assert_eq!(payload["tone_profile"], "gentle");
    assert_eq!(payload["mode"], "stream");

    Ok(())
}
