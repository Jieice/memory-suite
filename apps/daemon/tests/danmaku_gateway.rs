use anyhow::{Result, anyhow};
use app_config::{AppConfig, FeatureFlags, PythonConfig, ServerConfig, StorageConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    serve,
};
use daemon::{AppState, build_router};
use futures_util::StreamExt;
use serde_json::Value;
use tempfile::tempdir;
use tokio::time::{Duration, sleep};
use tokio_tungstenite::connect_async;
use tower::ServiceExt;

#[tokio::test]
async fn injects_danmaku_into_runtime_messages_and_live2d_state() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
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
    let server_app = app.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let server = tokio::spawn(async move {
        serve(listener, server_app).await.expect("serve runtime ws");
    });

    let (mut socket, _) = connect_with_retry(format!("ws://{addr}/ws/runtime")).await?;

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

    let mut saw_danmaku_event = false;
    while !saw_danmaku_event {
        let message = socket
            .next()
            .await
            .ok_or_else(|| anyhow!("runtime websocket closed"))??;
        if !message.is_text() {
            continue;
        }
        let payload: Value = serde_json::from_str(message.to_text()?)?;
        if payload.get("kind").and_then(Value::as_str) == Some("danmaku_received") {
            saw_danmaku_event = true;
        }
    }

    sleep(Duration::from_millis(50)).await;

    let messages = state.storage.list_messages("room-1").await?;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].text, "hello from danmaku");

    let live2d = state.live2d.get_state().await?;
    assert_eq!(live2d.subtitle, "hello from danmaku");

    server.abort();

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
