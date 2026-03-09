use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, PythonConfig, ServerConfig, StorageConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use serde_json::{Value, json};
use tempfile::tempdir;
use tower::ServiceExt;

async fn build_test_app() -> Result<axum::Router> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18090,
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
        },
    })
    .await?;

    Ok(build_router(state))
}

async fn response_json(response: axum::response::Response) -> Result<Value> {
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    Ok(serde_json::from_slice(&body)?)
}

#[tokio::test]
async fn executes_tool_from_manifest_and_returns_structured_result() -> Result<()> {
    let app = build_test_app().await?;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tools/execute")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "tool_id": "echo",
                        "args": { "message": "hello tool execution" }
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    let payload = response_json(response).await?;
    assert_eq!(payload.get("tool_id").and_then(Value::as_str), Some("echo"));
    assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        payload.get("status").and_then(Value::as_str),
        Some("succeeded")
    );
    assert_eq!(payload.get("exit_code").and_then(Value::as_i64), Some(0));
    assert_eq!(
        payload
            .get("output")
            .and_then(|value| value.get("echoed"))
            .and_then(Value::as_str),
        Some("hello tool execution")
    );

    let history = app
        .oneshot(
            Request::builder()
                .uri("/api/tools/executions?limit=5")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(history.status(), StatusCode::OK);
    let history_payload = response_json(history).await?;
    let history_items = history_payload
        .as_array()
        .expect("tool execution history array");
    assert!(!history_items.is_empty());

    Ok(())
}

#[tokio::test]
async fn returns_not_found_for_unknown_tool_id() -> Result<()> {
    let app = build_test_app().await?;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tools/execute")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "tool_id": "missing_tool",
                        "args": {}
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    Ok(())
}

#[tokio::test]
async fn captures_tool_process_failure_without_placeholder_behavior() -> Result<()> {
    let app = build_test_app().await?;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tools/execute")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "tool_id": "manager_control",
                        "args": { "action": "unsupported_action" }
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    let payload = response_json(response).await?;
    assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        payload.get("status").and_then(Value::as_str),
        Some("failed")
    );
    assert_eq!(
        payload.get("timed_out").and_then(Value::as_bool),
        Some(false)
    );
    assert!(
        payload
            .get("output")
            .and_then(|value| value.get("error"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("Unsupported action")
    );

    Ok(())
}

#[tokio::test]
async fn reports_timeout_when_tool_exceeds_runtime_budget() -> Result<()> {
    let app = build_test_app().await?;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tools/execute")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "tool_id": "manager_control",
                        "args": { "action": "mu_live_status" },
                        "timeout_ms": 1
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    let payload = response_json(response).await?;
    assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        payload.get("status").and_then(Value::as_str),
        Some("timeout")
    );
    assert_eq!(
        payload.get("timed_out").and_then(Value::as_bool),
        Some(true)
    );

    Ok(())
}
