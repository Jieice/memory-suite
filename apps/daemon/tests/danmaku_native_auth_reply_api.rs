use anyhow::Result;
use app_config::{
    AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig,
};
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
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
mod support;
use support::{EnvVarGuard, build_test_state, native_env_lock};
use tempfile::tempdir;
use tokio::{
    net::TcpListener,
    time::{Duration, sleep},
};
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
async fn accepts_auth_reply_first_frame_before_later_message_packets() -> Result<()> {
    let _native_env_lock = native_env_lock();

    let ws_listener = TcpListener::bind("127.0.0.1:0").await?;
    let ws_addr = ws_listener.local_addr()?;
    let ws_server = tokio::spawn(async move {
        let mut socket = loop {
            let (stream, _) = ws_listener
                .accept()
                .await
                .expect("accept auth-reply native session tcp");
            let mut socket = accept_async(stream)
                .await
                .expect("accept auth-reply native session ws");

            let auth = socket.next().await.expect("auth").expect("auth message");
            let auth_bytes = match auth {
                Message::Binary(bytes) => bytes,
                other => panic!("expected binary auth, got {other:?}"),
            };
            let auth_body = std::str::from_utf8(&auth_bytes[16..]).expect("auth utf-8 body");
            if auth_body.contains("\"roomid\":343434")
                && auth_body.contains("\"buvid\":\"native-auth-reply-buvid\"")
                && auth_body.contains("\"key\":\"stream-token\"")
            {
                break socket;
            }

            socket.close(None).await.expect("close unexpected auth-reply ws");
        };

        let auth_reply_payload = br#"{"code":0}"#;
        let auth_reply = {
            let mut packet = Vec::new();
            let packet_len = 16 + auth_reply_payload.len() as u32;
            packet.extend_from_slice(&packet_len.to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(8_u32).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(auth_reply_payload);
            packet
        };
        let payload = br#"{"cmd":"DANMU_MSG","info":[[0,1,25,16777215,0,0,0,0],"auth reply hello",[1003,"viewer-auth-reply",0,0,0,0,0,""],[],0,0,null,{},{}]}"#;
        let message_packet = {
            let mut packet = Vec::new();
            let packet_len = 16 + payload.len() as u32;
            packet.extend_from_slice(&packet_len.to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(5_u32).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(payload);
            packet
        };
        let mut response = auth_reply;
        response.extend_from_slice(&message_packet);
        socket
            .send(Message::Binary(response.into()))
            .await
            .expect("send combined auth-reply frame");
        sleep(Duration::from_secs(2)).await;
        socket.close(None).await.expect("close auth-reply native session ws");
    });

    let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let http_addr = http_listener.local_addr()?;
    let http_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/room/v1/Room/room_init", get(room_init))
            .route(
                "/xlive/web-room/v1/index/getDanmuInfo",
                get(move |query| get_danmu_info_with_ws(query, ws_addr.port())),
            );
        serve(http_listener, app)
            .await
            .expect("serve auth-reply native session mock bilibili http");
    });
    sleep(Duration::from_millis(50)).await;

    let _room_init_guard = EnvVarGuard::set(
        "MEMORY_SUITE_BILIBILI_ROOM_INIT_BASE",
        format!("http://{http_addr}"),
    );
    let _danmu_info_guard = EnvVarGuard::set(
        "MEMORY_SUITE_BILIBILI_DANMU_INFO_BASE",
        format!("http://{http_addr}"),
    );
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = build_test_state(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18114,
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
                        "uid": 9400,
                        "buvid": "native-auth-reply-buvid",
                        "cookie": "SESSDATA=authreply;",
                        "signature_mode": "cookie"
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
    let status = connect_once.status();
    let body = axum::body::to_bytes(connect_once.into_body(), usize::MAX).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "native-connect-once response body: {}",
        String::from_utf8_lossy(&body)
    );
    let payload: Value = serde_json::from_slice(&body)?;
    let session_id = payload
        .get("session_id")
        .and_then(Value::as_str)
        .expect("auth-reply session_id")
        .to_string();
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
        Some(false)
    );

    let messages = state.storage.list_messages(&session_id).await?;
    assert!(
        !messages
            .iter()
            .any(|message| message.role == api_types::MessageRole::Assistant)
    );

    let live2d = state.live2d.get_state().await?;
    assert_eq!(live2d.subtitle, "");
    assert_eq!(live2d.emotion, "normal");

    ws_server.await.expect("auth-reply ws server");
    http_server.abort();
    Ok(())
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

async fn get_danmu_info_with_ws(Query(query): Query<DanmuInfoQuery>, ws_port: u16) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "token": if query.id == "343434" { "stream-token" } else { "" },
            "uid": 9100,
            "live_status": 1,
            "host_list": [
                {
                    "host": "127.0.0.1",
                    "port": ws_port,
                    "wss_port": 0
                }
            ]
        }
    }))
}
