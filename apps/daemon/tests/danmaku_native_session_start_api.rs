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
use tokio::{net::TcpListener, time::{Duration, Instant, sleep}};
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
async fn starts_native_session_worker_and_reconnects_after_upstream_close() -> Result<()> {
    let ws_listener = TcpListener::bind("127.0.0.1:0").await?;
    let ws_addr = ws_listener.local_addr()?;
    let ws_server = tokio::spawn(async move {
        let (stream, _) = ws_listener.accept().await.expect("accept native session tcp");
        let mut socket = accept_async(stream).await.expect("accept native session ws");

        let _auth = socket.next().await.expect("auth").expect("auth message");
        let _heartbeat = socket.next().await.expect("heartbeat").expect("heartbeat message");

        let heartbeat_reply = {
            let mut packet = Vec::new();
            packet.extend_from_slice(&(20_u32).to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(3_u32).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(&(7777_u32).to_be_bytes());
            packet
        };
        let first_payload = br#"{"cmd":"DANMU_MSG","info":[[0,1,25,16777215,0,0,0,0],"native stream hello",[1000,"viewer-stream",0,0,0,0,0,""],[],0,0,null,{},{}]}"#;
        let first_packet = {
            let mut packet = Vec::new();
            let packet_len = 16 + first_payload.len() as u32;
            packet.extend_from_slice(&packet_len.to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(5_u32).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(first_payload);
            packet
        };
        let second_payload = br#"{"cmd":"DANMU_MSG","info":[[0,1,25,16777215,0,0,0,0],"native stream followup",[1001,"viewer-stream",0,0,0,0,0,""],[],0,0,null,{},{}]}"#;
        let second_packet = {
            let mut packet = Vec::new();
            let packet_len = 16 + second_payload.len() as u32;
            packet.extend_from_slice(&packet_len.to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(5_u32).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(second_payload);
            packet
        };

        let mut first_frame = heartbeat_reply;
        first_frame.extend_from_slice(&first_packet);
        socket
            .send(Message::Binary(first_frame.into()))
            .await
            .expect("send first native frame");
        sleep(Duration::from_millis(120)).await;
        socket
            .send(Message::Binary(second_packet.into()))
            .await
            .expect("send second native frame");
        sleep(Duration::from_millis(300)).await;
        socket.close(None).await.expect("close native session ws");
    });

    let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let http_addr = http_listener.local_addr()?;
    let http_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/room/v1/Room/room_init", get(room_init))
            .route("/xlive/web-room/v1/index/getDanmuInfo", get(get_danmu_info_with_ws));
        serve(http_listener, app)
            .await
            .expect("serve native session mock bilibili http");
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
        std::env::set_var("MEMORY_SUITE_BILIBILI_NATIVE_WS_ADDR", format!("ws://{ws_addr}"));
    }

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18101,
        },
        storage: StorageConfig {
            database_path: runtime_root.join("memory-suite.db").to_string_lossy().to_string(),
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
                        "room_id": "121212",
                        "uid": 9100,
                        "buvid": "native-stream-buvid",
                        "cookie": "SESSDATA=stream;",
                        "signature_mode": "cookie",
                        "connection_mode": "native_websocket"
                    }"#,
                ))?,
        )
        .await?;
    assert_eq!(source.status(), StatusCode::OK);

    let started = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/native-session/start")
                .header("content-type", "application/json")
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(started.status(), StatusCode::OK);

    let body = axum::body::to_bytes(started.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;
    let session_id = payload
        .get("state")
        .and_then(|value| value.get("session_id"))
        .and_then(Value::as_str)
        .expect("worker session_id")
        .to_string();
    assert!(session_id.starts_with("native:"));

    wait_until(Duration::from_secs(20), || {
        let state = state.clone();
        let session_id = session_id.clone();
        async move {
            let messages = state.storage.list_messages(&session_id).await.ok()?;
            (messages.len() >= 4
                && messages
                    .iter()
                    .any(|message| message.text == "native stream followup"))
            .then_some(messages)
        }
    })
    .await?;

    let messages = state.storage.list_messages(&session_id).await?;
    assert_eq!(messages[0].text, "native stream hello");
    assert_eq!(messages[2].text, "native stream followup");

    let live2d = state.live2d.get_state().await?;
    assert_eq!(live2d.subtitle, "native stream followup");

    let connection_state = wait_until(Duration::from_secs(30), || {
        let state = state.clone();
        async move {
            let current = state.storage.get_danmaku_connection_state().await.ok()?;
            ((current.status == "reconnecting"
                || current.status == "connecting"
                || current.status == "connected")
                && current
                    .session_id
                    .as_deref()
                    .map(|value| value.starts_with("native:"))
                    .unwrap_or(false)
                && current.attempt_count >= 2)
            .then_some(current)
        }
    })
    .await?;
    assert!(connection_state.attempt_count >= 2);
    assert!(
        connection_state.status == "reconnecting"
            || connection_state.status == "connecting"
            || connection_state.status == "connected"
    );

    ws_server.await.expect("ws server");
    http_server.abort();
    Ok(())
}

async fn wait_until<T, F, Fut>(timeout: Duration, mut check: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(value) = check().await {
            return Ok(value);
        }
        if Instant::now() >= deadline {
            anyhow::bail!("timed out waiting for native session state");
        }
        sleep(Duration::from_millis(50)).await;
    }
}

async fn room_init(Query(query): Query<RoomInitQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "room_id": if query.id == "121212" { 343434 } else { 0 },
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
            "token": if query.id == "343434" { "stream-token" } else { "" },
            "uid": 9100,
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
