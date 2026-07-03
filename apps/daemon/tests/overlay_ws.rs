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
use tokio::time::{Duration, sleep};
use tokio_tungstenite::connect_async;
use tower::ServiceExt;

#[tokio::test]
async fn streams_overlay_events_for_subtitle_and_emotion_updates() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18088,
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
        serve(listener, server_app).await.expect("serve overlay ws");
    });

    let (mut socket, _) = connect_with_retry(format!("ws://{addr}/ws/overlay")).await?;

    let subtitle = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/live2d/subtitle")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"text":"overlay push","duration_ms":1800}"#))?,
        )
        .await?;
    assert_eq!(subtitle.status(), StatusCode::OK);

    let emotion = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/live2d/emotion")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"emotion":"excited"}"#))?,
        )
        .await?;
    assert_eq!(emotion.status(), StatusCode::OK);

    let mut event_kinds = Vec::new();
    while event_kinds.len() < 2 {
        let message = socket
            .next()
            .await
            .ok_or_else(|| anyhow!("overlay websocket closed"))??;
        if !message.is_text() {
            continue;
        }
        let payload: Value = serde_json::from_str(message.to_text()?)?;
        if let Some(kind) = payload.get("kind").and_then(Value::as_str) {
            event_kinds.push(kind.to_string());
        }
    }

    server.abort();

    assert!(
        event_kinds
            .iter()
            .any(|kind| kind == "live2d_subtitle_updated")
    );
    assert!(
        event_kinds
            .iter()
            .any(|kind| kind == "live2d_emotion_updated")
    );

    Ok(())
}

#[tokio::test]
async fn streams_danmaku_events_to_overlay_clients() -> Result<()> {
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
        serve(listener, server_app).await.expect("serve overlay ws");
    });

    let (mut socket, _) = connect_with_retry(format!("ws://{addr}/ws/overlay")).await?;

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/gateway/danmaku")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"session_id":"overlay-danmaku","user_id":"viewer","text":"瀹炴椂寮瑰箷娴嬭瘯"}"#,
                ))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    let mut payload = None;
    while payload.is_none() {
        let message = socket
            .next()
            .await
            .ok_or_else(|| anyhow!("overlay websocket closed"))??;
        if !message.is_text() {
            continue;
        }
        let candidate: Value = serde_json::from_str(message.to_text()?)?;
        if candidate.get("kind").and_then(Value::as_str) == Some("danmaku_received") {
            payload = Some(candidate);
        }
    }
    server.abort();

    let payload = payload.expect("danmaku overlay payload");

    assert_eq!(
        payload.get("kind").and_then(Value::as_str),
        Some("danmaku_received")
    );
    assert_eq!(
        payload.get("detail").and_then(Value::as_str),
        Some("瀹炴椂寮瑰箷娴嬭瘯")
    );

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
        "failed to connect overlay websocket: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown error".into())
    ))
}



