use anyhow::{Result, anyhow};
use app_config::{AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig};
use axum::{
    Json,
    body::Body,
    extract::Query,
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::get,
    serve,
};
use daemon::build_router;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
mod support;
use support::{EnvVarGuard, build_test_state, native_env_lock};
use tempfile::tempdir;
use tokio::time::{Duration, sleep, timeout};
use tokio_tungstenite::connect_async;
use tower::ServiceExt;

#[derive(Deserialize)]
struct RoomInitQuery {
    id: String,
}

#[derive(Deserialize)]
struct DanmuInfoQuery {
    id: String,
}

#[tokio::test]
async fn emits_runtime_events_for_danmaku_source_and_connection_lifecycle() -> Result<()> {
    let _native_env_lock = native_env_lock();

    let mock_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mock_addr = mock_listener.local_addr()?;
    let _room_init_guard = EnvVarGuard::set(
        "MEMORY_SUITE_BILIBILI_ROOM_INIT_BASE",
        format!("http://{mock_addr}"),
    );
    let _danmu_info_guard = EnvVarGuard::set(
        "MEMORY_SUITE_BILIBILI_DANMU_INFO_BASE",
        format!("http://{mock_addr}"),
    );
    let mock_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/room/v1/Room/room_init", get(room_init))
            .route("/xlive/web-room/v1/index/getDanmuInfo", get(get_danmu_info));
        serve(mock_listener, app)
            .await
            .expect("serve mock bilibili api");
    });

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = build_test_state(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18092,
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
    let server_app = app.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let server = tokio::spawn(async move {
        serve(listener, server_app).await.expect("serve runtime ws");
    });

    let (mut socket, _) = connect_with_retry(format!("ws://{addr}/ws/runtime")).await?;

    let update = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/source")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{
                        "room_id": "778899",
                        "uid": 2048,
                        "buvid": "runtime-buvid",
                        "cookie": "SESSDATA=runtime;",
                        "signature_mode": "cookie"
                    }"#,
                ))?,
        )
        .await?;
    assert_eq!(update.status(), StatusCode::OK);

    let connect = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/connect")
                .header("content-type", "application/json")
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(connect.status(), StatusCode::OK);

    let disconnect = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/disconnect")
                .header("content-type", "application/json")
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(disconnect.status(), StatusCode::OK);

    let mut saw_source_updated = false;
    let mut saw_connecting = false;
    let mut saw_disconnected = false;
    let mut saw_attempt = false;

    for _ in 0..12 {
        let message = timeout(Duration::from_secs(2), socket.next())
            .await
            .map_err(|_| anyhow!("timed out waiting for runtime websocket event"))?
            .ok_or_else(|| anyhow!("runtime websocket closed"))??;
        if !message.is_text() {
            continue;
        }
        let payload: Value = serde_json::from_str(message.to_text()?)?;
        match payload.get("kind").and_then(Value::as_str) {
            Some("danmaku_source_updated") => saw_source_updated = true,
            Some("danmaku_connection_connecting") => saw_connecting = true,
            Some("danmaku_connect_attempted") => saw_attempt = true,
            Some("danmaku_connection_disconnected") => saw_disconnected = true,
            _ => {}
        }

        if saw_source_updated && saw_connecting && saw_attempt && saw_disconnected {
            break;
        }
    }

    sleep(Duration::from_millis(50)).await;
    let _ = state.gateway.disconnect().await;
    server.abort();
    mock_server.abort();

    assert!(saw_source_updated);
    assert!(saw_connecting);
    assert!(saw_attempt);
    assert!(saw_disconnected);

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

async fn room_init(Query(query): Query<RoomInitQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "room_id": if query.id == "778899" { 998877 } else { 0 },
            "live_status": 1
        }
    }))
}

async fn get_danmu_info(Query(query): Query<DanmuInfoQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "token": if query.id == "998877" { "runtime-token" } else { "" },
            "uid": 2048,
            "live_status": 1,
            "host_list": [
                {
                    "host": "127.0.0.1",
                    "port": 9,
                    "wss_port": 0
                }
            ]
        }
    }))
}
