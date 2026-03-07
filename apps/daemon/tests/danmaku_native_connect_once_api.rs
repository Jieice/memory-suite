use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, PythonConfig, ServerConfig, StorageConfig};
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
async fn connects_once_via_native_bilibili_path_and_ingests_decoded_messages() -> Result<()> {
    let ws_listener = TcpListener::bind("127.0.0.1:0").await?;
    let ws_addr = ws_listener.local_addr()?;
    let ws_server = tokio::spawn(async move {
        let (stream, _) = ws_listener
            .accept()
            .await
            .expect("accept native connect tcp");
        let mut socket = accept_async(stream)
            .await
            .expect("accept native connect ws");

        let _auth = socket.next().await.expect("auth").expect("auth message");
        let _heartbeat = socket
            .next()
            .await
            .expect("heartbeat")
            .expect("heartbeat message");

        let heartbeat_reply = {
            let mut packet = Vec::new();
            packet.extend_from_slice(&(20_u32).to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(3_u32).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(&(4096_u32).to_be_bytes());
            packet
        };
        let json_payload = br#"{"cmd":"DANMU_MSG","info":[[0,1,25,16777215,0,0,0,0],"native connect hello",[1000,"viewer-native",0,0,0,0,0,""],[],0,0,null,{},{}]}"#;
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
            .expect("send native connect response");
        socket.close(None).await.expect("close native connect ws");
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
            .expect("serve native connect mock bilibili http");
    });

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
            port: 18100,
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

    let source = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/source")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{
                        "room_id": "778899",
                        "uid": 9002,
                        "buvid": "native-buvid",
                        "cookie": "SESSDATA=native;",
                        "signature_mode": "cookie",
                        "connection_mode": "websocket"
                    }"#,
                ))?,
        )
        .await?;
    assert_eq!(source.status(), StatusCode::OK);

    let connect_once = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/native-connect-once")
                .header("content-type", "application/json")
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(connect_once.status(), StatusCode::OK);

    let body = axum::body::to_bytes(connect_once.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;
    let session_id = payload
        .get("session_id")
        .and_then(Value::as_str)
        .expect("native session_id");
    assert!(session_id.starts_with("native:"));
    assert_eq!(
        payload.get("decoded_packet_count").and_then(Value::as_u64),
        Some(2)
    );
    assert_eq!(
        payload.get("ingested_event_count").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        payload.get("saw_heartbeat_reply").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        payload
            .get("state")
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str),
        Some("connected")
    );

    let messages = state.storage.list_messages(session_id).await?;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].text, "native connect hello");

    let live2d = state.live2d.get_state().await?;
    assert_eq!(live2d.subtitle, "native connect hello");

    ws_server.await.expect("ws server");
    http_server.abort();
    Ok(())
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
            "token": if query.id == "998877" { "native-token" } else { "" },
            "uid": 9002,
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
