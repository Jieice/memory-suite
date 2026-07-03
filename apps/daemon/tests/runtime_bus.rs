use anyhow::{Result, anyhow};
use app_config::{AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    serve,
};
use daemon::{AppState, build_router};
use futures_util::StreamExt;
use serde_json::Value;
use tempfile::tempdir;
use tokio::time::{Duration, Instant, sleep};
use tokio_tungstenite::connect_async;
use tower::ServiceExt;

#[tokio::test]
async fn streams_runtime_events_for_chat_and_adapter_activity() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
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
            executable: "powershell".into(),
            models_root: dir.path().join("python").to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
        },
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
    })
    .await?;

    let app = build_router(state);
    let server_app = app.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let server = tokio::spawn(async move {
        serve(listener, server_app)
            .await
            .expect("serve runtime bus");
    });

    let (mut socket, _) = connect_with_retry(format!("ws://{addr}/ws/runtime")).await?;

    let chat_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/chat")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"session_id":"runtime-bus","text":"runtime bus"}"#,
                ))?,
        )
        .await?;
    assert_eq!(chat_response.status(), StatusCode::OK);

    let adapter_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/runtime/adapters/edge_tts/start")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "args": ["-NoProfile", "-Command", "Start-Sleep -Seconds 5"]
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(adapter_response.status(), StatusCode::OK);

    let mut event_kinds = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if event_kinds.iter().any(|kind| kind == "message_created")
            && event_kinds.iter().any(|kind| kind == "adapter_started")
        {
            break;
        }

        let next = tokio::time::timeout(Duration::from_millis(700), socket.next()).await;
        let Ok(Some(message)) = next else {
            continue;
        };
        let message = message?;
        if !message.is_text() {
            continue;
        }
        let payload: Value = serde_json::from_str(message.to_text()?)?;
        if let Some(kind) = payload.get("kind").and_then(Value::as_str) {
            event_kinds.push(kind.to_string());
        }
    }

    server.abort();

    assert!(event_kinds.iter().any(|kind| kind == "message_created"));
    assert!(event_kinds.iter().any(|kind| kind == "adapter_started"));
    assert!(event_kinds.iter().any(|kind| {
        matches!(
            kind.as_str(),
            "speech_queued"
                | "speech_ready"
                | "speech_started"
                | "speech_completed"
                | "speech_failed"
        )
    }));

    Ok(())
}

async fn connect_with_retry(
    url: String,
) -> Result<(
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::handshake::client::Response,
)> {
    let mut last_error = None;
    for _ in 0..10 {
        match connect_async(&url).await {
            Ok(connection) => return Ok(connection),
            Err(error) => {
                last_error = Some(error);
                sleep(Duration::from_millis(50)).await;
            }
        }
    }

    Err(anyhow!(
        "failed to connect runtime websocket: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown error".into())
    ))
}



