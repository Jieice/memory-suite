use anyhow::Result;
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
use daemon::{AppState, build_router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};
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
async fn probes_native_bilibili_websocket_path_from_rust() -> Result<()> {
    let ws_listener = TcpListener::bind("127.0.0.1:0").await?;
    let ws_addr = ws_listener.local_addr()?;
    let ws_server = tokio::spawn(async move {
        let (stream, _) = ws_listener.accept().await.expect("accept probe tcp");
        let mut socket = accept_async(stream).await.expect("accept probe ws");

        let _auth = socket.next().await.expect("auth").expect("auth message");

        let heartbeat_reply = {
            let mut packet = Vec::new();
            packet.extend_from_slice(&(20_u32).to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(3_u32).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(&(2048_u32).to_be_bytes());
            packet
        };
        let json_payload = br#"{"cmd":"DANMU_MSG","info":["x","probe hello"]}"#;
        let json_packet = {
            let mut packet = Vec::new();
            let packet_len = 16 + json_payload.len() as u32;
            packet.extend_from_slice(&packet_len.to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(5_u32).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(json_payload);
            packet
        };

        let mut response = heartbeat_reply;
        response.extend_from_slice(&json_packet);
        socket
            .send(Message::Binary(response.into()))
            .await
            .expect("send probe response");
        socket.close(None).await.expect("close probe ws");
    });

    let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let http_addr = http_listener.local_addr()?;
    let http_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/room/v1/Room/room_init", get(room_init))
            .route(
                "/xlive/web-room/v1/index/getDanmuInfo",
                get(get_danmu_info_with_ws),
            );
        serve(http_listener, app)
            .await
            .expect("serve mock bilibili http");
    });

    // Safety: this integration test owns its process and uses unique mock endpoints.
    unsafe {
        std::env::set_var(
            "MEMORY_SUITE_BILIBILI_ROOM_INIT_BASE",
            format!("http://{http_addr}"),
        );
        std::env::set_var(
            "MEMORY_SUITE_BILIBILI_DANMU_INFO_BASE",
            format!("http://{http_addr}"),
        );
        std::env::set_var(
            "MEMORY_SUITE_BILIBILI_NATIVE_WS_ADDR",
            format!("ws://{ws_addr}"),
        );
    }

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18099,
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
            enable_legacy_import: false,
        },
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
    })
    .await?;

    let app = build_router(state);

    let source = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/source")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{
                        "room_id": "445566",
                        "uid": 9001,
                        "buvid": "probe-buvid",
                        "cookie": "SESSDATA=probe;",
                        "signature_mode": "cookie",
                        "connection_mode": "websocket"
                    }"#,
                ))?,
        )
        .await?;
    assert_eq!(source.status(), StatusCode::OK);

    let probe = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/native-probe")
                .header("content-type", "application/json")
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(probe.status(), StatusCode::OK);

    let body = axum::body::to_bytes(probe.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;
    assert_eq!(
        payload.get("host").and_then(Value::as_str),
        Some("127.0.0.1")
    );
    assert_eq!(
        payload.get("decoded_packet_count").and_then(Value::as_u64),
        Some(2)
    );
    assert_eq!(
        payload.get("saw_heartbeat_reply").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        payload.get("saw_message_frame").and_then(Value::as_bool),
        Some(true)
    );

    ws_server.await.expect("ws server");
    http_server.abort();
    Ok(())
}

async fn room_init(Query(query): Query<RoomInitQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "room_id": if query.id == "445566" { 665544 } else { 0 },
            "live_status": 1
        }
    }))
}

async fn get_danmu_info_with_ws(Query(query): Query<DanmuInfoQuery>) -> impl IntoResponse {
    let ws_addr = std::env::var("MEMORY_SUITE_BILIBILI_NATIVE_WS_ADDR").expect("native ws addr");
    let host = ws_addr
        .trim_start_matches("ws://")
        .split(':')
        .next()
        .unwrap_or("127.0.0.1");
    Json(json!({
        "code": 0,
        "data": {
            "token": if query.id == "665544" { "probe-token" } else { "" },
            "uid": 9001,
            "live_status": 1,
            "host_list": [
                {
                    "host": host,
                    "port": 2243,
                    "wss_port": 443
                }
            ]
        }
    }))
}



