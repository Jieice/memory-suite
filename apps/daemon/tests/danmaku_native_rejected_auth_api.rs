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
use daemon::{AppState, build_router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
mod support;
use support::{EnvVarGuard, build_test_state, native_env_lock};
use tempfile::tempdir;
use tokio::{
    net::TcpListener,
    time::{Duration, Instant, sleep},
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
async fn rejects_nonzero_auth_reply_in_worker_first_frame() -> Result<()> {
    let _native_env_lock = native_env_lock();

    let ws_listener = TcpListener::bind("127.0.0.1:0").await?;
    let ws_addr = ws_listener.local_addr()?;
    let ws_server = tokio::spawn(async move {
        let (stream, _) = ws_listener
            .accept()
            .await
            .expect("accept rejected-auth native session tcp");
        let mut socket = accept_async(stream)
            .await
            .expect("accept rejected-auth native session ws");

        let auth = socket.next().await.expect("auth").expect("auth message");
        if !matches!(auth, Message::Binary(_)) {
            panic!("expected binary auth, got {auth:?}");
        }

        let auth_reply_payload = br#"{"code":-101,"message":"auth failed"}"#;
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
        socket
            .send(Message::Binary(auth_reply.into()))
            .await
            .expect("send rejected auth reply frame");
        sleep(Duration::from_millis(150)).await;
        socket.close(None).await.expect("close rejected-auth native session ws");
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
            .expect("serve rejected-auth native session mock bilibili http");
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
            port: 18115,
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
                        "uid": 9500,
                        "buvid": "native-reject-auth-buvid",
                        "cookie": "SESSDATA=rejectauth;",
                        "signature_mode": "cookie"
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

    let failed_state = wait_until(Duration::from_secs(30), || {
        let state = state.clone();
        async move {
            let current = state.storage.get_danmaku_connection_state().await.ok()?;
            current.last_error.is_some().then_some(current)
        }
    })
    .await?;
    let last_error = failed_state.last_error.as_deref().unwrap_or_default();
    assert!(
        last_error.contains("auth failed"),
        "expected auth failure detail, got: {last_error}"
    );

    ws_server.await.expect("rejected-auth ws server");
    cleanup_native_session(&state).await;
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

async fn cleanup_native_session(state: &AppState) {
    let _ = state.gateway.disconnect().await;
    sleep(Duration::from_millis(250)).await;
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
