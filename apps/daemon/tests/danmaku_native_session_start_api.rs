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
async fn starts_native_session_worker_and_persists_background_session_state() -> Result<()> {
    let _native_env_lock = native_env_lock();

    let ws_listener = TcpListener::bind("127.0.0.1:0").await?;
    let ws_addr = ws_listener.local_addr()?;
    let ws_server = tokio::spawn(async move {
        let (stream, _) = ws_listener
            .accept()
            .await
            .expect("accept native session tcp");
        let mut socket = accept_async(stream)
            .await
            .expect("accept native session ws");

        let _auth = socket.next().await.expect("auth").expect("auth message");

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
            .route(
                "/xlive/web-room/v1/index/getDanmuInfo",
                get(move |query| get_danmu_info_with_ws(query, ws_addr.port())),
            );
        serve(http_listener, app)
            .await
            .expect("serve native session mock bilibili http");
    });

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
            port: 18101,
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
                        "uid": 9100,
                        "buvid": "native-stream-buvid",
                        "cookie": "SESSDATA=stream;",
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

    let body = axum::body::to_bytes(started.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;
    let session_id = payload
        .get("state")
        .and_then(|value| value.get("session_id"))
        .and_then(Value::as_str)
        .expect("worker session_id")
        .to_string();
    assert!(session_id.starts_with("native:"));

    let connection_state = wait_until(Duration::from_secs(30), || {
        let state = state.clone();
        async move {
            let current = state.storage.get_danmaku_connection_state().await.ok()?;
            let observed_worker_activity = current.last_heartbeat_at.is_some()
                || current.next_retry_at.is_some()
                || current.last_error.is_some()
                || current.last_close_reason.is_some();
            observed_worker_activity.then_some(current)
        }
    })
    .await?;
    assert_eq!(
        connection_state.current_upstream_host.as_deref(),
        Some("127.0.0.1")
    );
    assert!(
        connection_state.status == "connecting"
            || connection_state.status == "connected"
            || connection_state.status == "reconnecting"
            || connection_state.status == "disconnected"
    );
    assert!(
        connection_state.last_heartbeat_at.is_some()
            || connection_state.next_retry_at.is_some()
            || connection_state.last_error.is_some()
            || connection_state.last_close_reason.is_some()
    );

    let active_session_id = connection_state
        .session_id
        .clone()
        .expect("worker active session_id");
    let messages = wait_until(Duration::from_secs(30), || {
        let state = state.clone();
        let active_session_id = active_session_id.clone();
        async move {
            let messages = state.storage.list_messages(&active_session_id).await.ok()?;
            (messages.len() >= 2).then_some(messages)
        }
    })
    .await?;
    assert!(
        !messages
            .iter()
            .any(|message| message.role == api_types::MessageRole::Assistant)
    );
    let live2d = state.live2d.get_state().await?;
    assert_eq!(live2d.subtitle, "");
    assert_eq!(live2d.emotion, "normal");

    ws_server.await.expect("ws server");
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

async fn get_danmu_info_with_ws(
    Query(query): Query<DanmuInfoQuery>,
    ws_port: u16,
) -> impl IntoResponse {
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

#[tokio::test]
async fn falls_back_to_next_native_endpoint_when_first_worker_candidate_fails() -> Result<()> {
    let _native_env_lock = native_env_lock();

    let failed_listener = TcpListener::bind("127.0.0.1:0").await?;
    let failed_addr = failed_listener.local_addr()?;
    drop(failed_listener);

    let ws_listener = TcpListener::bind("127.0.0.1:0").await?;
    let ws_addr = ws_listener.local_addr()?;
    let ws_server = tokio::spawn(async move {
        let (stream, _) = ws_listener
            .accept()
            .await
            .expect("accept fallback native session tcp");
        let mut socket = accept_async(stream)
            .await
            .expect("accept fallback native session ws");

        let _auth = socket.next().await.expect("auth").expect("auth message");

        let heartbeat_reply = {
            let mut packet = Vec::new();
            packet.extend_from_slice(&(20_u32).to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(3_u32).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(&(6666_u32).to_be_bytes());
            packet
        };
        let payload = br#"{"cmd":"DANMU_MSG","info":[[0,1,25,16777215,0,0,0,0],"native fallback hello",[1002,"viewer-fallback",0,0,0,0,0,""],[],0,0,null,{},{}]}"#;
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

        let mut frame = heartbeat_reply;
        frame.extend_from_slice(&message_packet);
        socket
            .send(Message::Binary(frame.into()))
            .await
            .expect("send fallback native frame");
        sleep(Duration::from_millis(150)).await;
        socket.close(None).await.expect("close fallback native session ws");
    });

    let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let http_addr = http_listener.local_addr()?;
    let http_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/room/v1/Room/room_init", get(room_init_fallback))
            .route(
                "/xlive/web-room/v1/index/getDanmuInfo",
                get(move |query| get_danmu_info_with_fallback_ws(query, failed_addr.port(), ws_addr.port())),
            );
        serve(http_listener, app)
            .await
            .expect("serve fallback native session mock bilibili http");
    });

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
            port: 18113,
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
                        "room_id": "565656",
                        "uid": 9300,
                        "buvid": "native-fallback-buvid",
                        "cookie": "SESSDATA=fallback;",
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

    let connected_state = wait_until(Duration::from_secs(30), || {
        let state = state.clone();
        async move {
            let current = state.storage.get_danmaku_connection_state().await.ok()?;
            (current.status == "connected" && current.current_upstream_host.as_deref() == Some("localhost"))
                .then_some(current)
        }
    })
    .await?;
    assert_eq!(connected_state.current_upstream_host.as_deref(), Some("localhost"));

    let session_id = connected_state
        .session_id
        .clone()
        .expect("fallback worker session_id");
    let messages = wait_until(Duration::from_secs(30), || {
        let state = state.clone();
        let session_id = session_id.clone();
        async move {
            let messages = state.storage.list_messages(&session_id).await.ok()?;
            (!messages.is_empty()).then_some(messages)
        }
    })
    .await?;
    assert!(
        !messages
            .iter()
            .any(|message| message.role == api_types::MessageRole::Assistant)
    );
    let live2d = state.live2d.get_state().await?;
    assert_eq!(live2d.subtitle, "");
    assert_eq!(live2d.emotion, "normal");

    ws_server.await.expect("fallback ws server");
    cleanup_native_session(&state).await;
    http_server.abort();
    Ok(())
}

#[tokio::test]
async fn repeated_native_session_start_is_skipped_while_existing_session_is_connecting() -> Result<()> {
    let _native_env_lock = native_env_lock();

    let ws_listener = TcpListener::bind("127.0.0.1:0").await?;
    let ws_addr = ws_listener.local_addr()?;
    let ws_server = tokio::spawn(async move {
        let (stream, _) = ws_listener.accept().await.expect("accept duplicate-start native session tcp");
        let mut socket = accept_async(stream)
            .await
            .expect("accept duplicate-start native session ws");

        let _auth = socket.next().await.expect("auth").expect("auth message");

        let heartbeat_reply = {
            let mut packet = Vec::new();
            packet.extend_from_slice(&(20_u32).to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(3_u32).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(&(9999_u32).to_be_bytes());
            packet
        };
        socket
            .send(Message::Binary(heartbeat_reply.into()))
            .await
            .expect("send duplicate-start heartbeat reply");
        sleep(Duration::from_millis(500)).await;
        socket.close(None).await.expect("close duplicate-start native session ws");
    });

    let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let http_addr = http_listener.local_addr()?;
    let http_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/room/v1/Room/room_init", get(room_init_offline))
            .route(
                "/xlive/web-room/v1/index/getDanmuInfo",
                get(move |query| get_danmu_info_offline(query, ws_addr.port())),
            );
        serve(http_listener, app)
            .await
            .expect("serve duplicate-start native session mock bilibili http");
    });

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
            port: 18112,
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
                        "room_id": "404404",
                        "uid": 9200,
                        "buvid": "native-offline-buvid",
                        "cookie": "SESSDATA=stream;",
                        "signature_mode": "cookie"
                    }"#,
                ))?,
        )
        .await?;
    assert_eq!(source.status(), StatusCode::OK);

    let started = app
        .clone()
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
    let _first_session_id = payload
        .get("state")
        .and_then(|value| value.get("session_id"))
        .and_then(Value::as_str)
        .expect("first duplicate-start worker session_id")
        .to_string();

    let skipped = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/native-session/start")
                .header("content-type", "application/json")
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(skipped.status(), StatusCode::OK);
    let skipped_body = axum::body::to_bytes(skipped.into_body(), usize::MAX).await?;
    let skipped_payload: Value = serde_json::from_slice(&skipped_body)?;
    let skipped_state = skipped_payload.get("state").expect("skipped state");
    let skipped_session_id = skipped_state
        .get("session_id")
        .and_then(Value::as_str)
        .expect("skipped session_id");
    assert!(skipped_session_id.starts_with("native:"));
    let skipped_status = skipped_state
        .get("status")
        .and_then(Value::as_str)
        .expect("skipped status");
    assert!(matches!(skipped_status, "connecting" | "connected" | "reconnecting"));

    ws_server.await.expect("duplicate-start ws server task");
    cleanup_native_session(&state).await;
    http_server.abort();
    Ok(())
}

#[tokio::test]
async fn starts_native_session_even_when_room_init_reports_offline() -> Result<()> {
    let _native_env_lock = native_env_lock();

    let ws_listener = TcpListener::bind("127.0.0.1:0").await?;
    let ws_addr = ws_listener.local_addr()?;
    let ws_server = tokio::spawn(async move {
        let (stream, _) = ws_listener.accept().await.expect("accept offline-compatible native session tcp");
        let mut socket = accept_async(stream)
            .await
            .expect("accept offline-compatible native session ws");

        let _auth = socket.next().await.expect("auth").expect("auth message");

        let heartbeat_reply = {
            let mut packet = Vec::new();
            packet.extend_from_slice(&(20_u32).to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(3_u32).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(&(8888_u32).to_be_bytes());
            packet
        };
        socket
            .send(Message::Binary(heartbeat_reply.into()))
            .await
            .expect("send offline-compatible native frame");
        sleep(Duration::from_secs(2)).await;
        socket.close(None).await.expect("close offline-compatible native session ws");
    });

    let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let http_addr = http_listener.local_addr()?;
    let http_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/room/v1/Room/room_init", get(room_init_offline))
            .route(
                "/xlive/web-room/v1/index/getDanmuInfo",
                get(move |query| get_danmu_info_offline(query, ws_addr.port())),
            );
        serve(http_listener, app)
            .await
            .expect("serve offline-compatible native session mock bilibili http");
    });

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
            port: 18111,
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
                        "room_id": "404404",
                        "uid": 9200,
                        "buvid": "native-offline-buvid",
                        "cookie": "SESSDATA=stream;",
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

    let body = axum::body::to_bytes(started.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;
    assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
    let session_id = payload
        .get("state")
        .and_then(|value| value.get("session_id"))
        .and_then(Value::as_str)
        .expect("offline-compatible worker session_id");
    assert!(session_id.starts_with("native:"));

    let current = wait_until(Duration::from_secs(30), || {
        let state = state.clone();
        async move {
            let current = state.storage.get_danmaku_connection_state().await.ok()?;
            (current.last_heartbeat_at.is_some()
                || current.status == "connected"
                || current.last_error.is_some())
                .then_some(current)
        }
    })
    .await?;
    assert!(current.session_id.as_deref().unwrap_or_default().starts_with("native:"));
    assert_ne!(current.last_error.as_deref(), Some("room_offline"));

    ws_server.await.expect("offline-compatible ws server task");
    cleanup_native_session(&state).await;
    http_server.abort();
    Ok(())
}

async fn room_init_offline(Query(query): Query<RoomInitQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "room_id": if query.id == "404404" { 404404 } else { 0 },
            "live_status": 0
        }
    }))
}

async fn get_danmu_info_offline(
    Query(query): Query<DanmuInfoQuery>,
    ws_port: u16,
) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "token": if query.id == "404404" { "offline-token" } else { "" },
            "uid": 9200,
            "live_status": 0,
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

async fn room_init_fallback(Query(query): Query<RoomInitQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "room_id": if query.id == "565656" { 787878 } else { 0 },
            "live_status": 1
        }
    }))
}

async fn get_danmu_info_with_fallback_ws(
    Query(query): Query<DanmuInfoQuery>,
    failed_port: u16,
    working_port: u16,
) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "token": if query.id == "787878" { "fallback-token" } else { "" },
            "uid": 9300,
            "live_status": 1,
            "host_list": [
                {
                    "host": "127.0.0.1",
                    "port": failed_port,
                    "wss_port": 0
                },
                {
                    "host": "localhost",
                    "port": working_port,
                    "wss_port": 0
                }
            ]
        }
    }))
}



