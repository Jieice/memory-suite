use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};
use tempfile::{TempDir, tempdir, tempdir_in};
use tower::ServiceExt;
use uuid::Uuid;

static TOOL_FIXTURE_LOCK: Mutex<()> = Mutex::new(());

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

    Ok(build_router(state))
}

async fn response_json(response: axum::response::Response) -> Result<Value> {
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    Ok(serde_json::from_slice(&body)?)
}

fn tool_fixture_lock() -> MutexGuard<'static, ()> {
    TOOL_FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn tools_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("data")
        .join("tools")
}

fn create_test_tool_fixture(script: &str, timeout_ms: u64) -> Result<(TempDir, String)> {
    let root = tools_root();
    fs::create_dir_all(&root)?;

    let dir = tempdir_in(&root)?;
    let tool_id = format!("test_tool_{}", Uuid::new_v4().simple());
    let manifest = json!({
        "id": tool_id,
        "name": "Test Fixture Tool",
        "version": "1.0.0",
        "entry": "index.js",
        "runtime": "node",
        "enabledByDefault": false,
        "confirmationLevel": "auto",
        "accessLevel": "admin",
        "schemas": [
            {
                "name": "fixture",
                "description": "Ephemeral test fixture tool",
                "input": {
                    "type": "object",
                    "properties": {}
                }
            }
        ],
        "timeout": timeout_ms
    });

    fs::write(
        dir.path().join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    fs::write(dir.path().join("index.js"), script)?;

    Ok((dir, tool_id))
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
    let _tool_lock = tool_fixture_lock();
    let (_tool_dir, tool_id) = create_test_tool_fixture(
        r#"console.log(JSON.stringify({ error: "fixture failure" })); process.exit(2);"#,
        5_000,
    )?;
    let app = build_test_app().await?;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tools/execute")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "tool_id": tool_id,
                        "args": {}
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
            .contains("fixture failure")
    );

    Ok(())
}

#[tokio::test]
async fn reports_timeout_when_tool_exceeds_runtime_budget() -> Result<()> {
    let _tool_lock = tool_fixture_lock();
    let (_tool_dir, tool_id) = create_test_tool_fixture(
        r#"setTimeout(() => { console.log(JSON.stringify({ ok: true })); }, 200);"#,
        5_000,
    )?;
    let app = build_test_app().await?;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tools/execute")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "tool_id": tool_id,
                        "args": {},
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
