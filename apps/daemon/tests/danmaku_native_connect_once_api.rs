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
use daemon::build_router;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
mod support;
use support::{EnvVarGuard, build_test_state, native_env_lock};
use tempfile::tempdir;
use tokio::{net::TcpListener, time::{sleep, Duration}};
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

#[tokio::test(flavor = "current_thread")]
async fn connects_once_via_native_bilibili_path_and_ingests_decoded_messages() -> Result<()> {
    let _native_env_lock = native_env_lock();

    let ws_listener = TcpListener::bind("127.0.0.1:0").await?;
    let ws_addr = ws_listener.local_addr()?;
    let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let http_addr = http_listener.local_addr()?;
    let _room_init_guard = EnvVarGuard::set(
        "MEMORY_SUITE_BILIBILI_ROOM_INIT_BASE",
        format!("http://{http_addr}"),
    );
    let _danmu_info_guard = EnvVarGuard::set(
        "MEMORY_SUITE_BILIBILI_DANMU_INFO_BASE",
        format!("http://{http_addr}"),
    );

    let ws_server = tokio::spawn(async move {
        let Ok((stream, _)) = ws_listener.accept().await else {
            return;
        };
        let Ok(mut socket) = accept_async(stream).await else {
            return;
        };
        let Some(Ok(Message::Binary(_))) = socket.next().await else {
            return;
        };

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
        let _ = socket.send(Message::Binary(response.into())).await;
        sleep(Duration::from_millis(150)).await;
        let _ = socket.close(None).await;
    });

    let http_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/room/v1/Room/room_init", get(room_init))
            .route(
                "/xlive/web-room/v1/index/getDanmuInfo",
                get(move |query| get_danmu_info_with_ws(query, ws_addr.port())),
            );
        serve(http_listener, app)
            .await
            .expect("serve native connect mock bilibili http");
    });
    sleep(Duration::from_millis(50)).await;

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = build_test_state(AppConfig {
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
                        "room_id": "778899",
                        "uid": 9002,
                        "buvid": "native-buvid",
                        "cookie": "SESSDATA=native;",
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
    let connect_status = connect_once.status();
    let body = match axum::body::to_bytes(connect_once.into_body(), usize::MAX).await {
        Ok(body) => body,
        Err(error) => return Err(error.into()),
    };
    if connect_status != StatusCode::OK {
        let current = state.storage.get_danmaku_connection_state().await?;
        anyhow::bail!(
            "native-connect-once returned {connect_status}; body={}; last_error={:?}; last_close_reason={:?}",
            String::from_utf8_lossy(&body),
            current.last_error,
            current.last_close_reason
        );
    }

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
    let response_status = payload
        .get("state")
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);
    assert!(
        matches!(response_status, Some("connected") | Some("reconnecting")),
        "unexpected one-shot state payload: {payload:#?}"
    );

    let messages = state.storage.list_messages(session_id).await?;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].text, "native connect hello");
    let assistant_text = messages[1].text.clone();
    assert_ne!(assistant_text, "native connect hello");

    let live2d = state.live2d.get_state().await?;
    assert_eq!(live2d.subtitle, "");
    assert_eq!(live2d.emotion, "normal");

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

async fn get_danmu_info_with_ws(Query(query): Query<DanmuInfoQuery>, ws_port: u16) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "token": if query.id == "998877" { "native-token" } else { "" },
            "uid": 9002,
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



