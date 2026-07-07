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
use serde::Deserialize;
use serde_json::{Value, json};
mod support;
use support::{EnvVarGuard, build_test_state, native_env_lock};
use tempfile::tempdir;
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
async fn resolves_bilibili_bootstrap_and_persists_selected_upstream_host() -> Result<()> {
    let _native_env_lock = native_env_lock();
    let mock_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mock_addr = mock_listener.local_addr()?;
    let mock_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/room/v1/Room/room_init", get(room_init))
            .route("/xlive/web-room/v1/index/getDanmuInfo", get(get_danmu_info));
        serve(mock_listener, app)
            .await
            .expect("serve mock bilibili api");
    });

    let _room_init_guard = EnvVarGuard::set(
        "MEMORY_SUITE_BILIBILI_ROOM_INIT_BASE",
        format!("http://{mock_addr}"),
    );
    let _danmu_info_guard = EnvVarGuard::set(
        "MEMORY_SUITE_BILIBILI_DANMU_INFO_BASE",
        format!("http://{mock_addr}"),
    );

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = build_test_state(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18094,
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

    let app = build_router(state);

    let update = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/source")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{
                        "room_id": "12345",
                        "uid": 2048,
                        "buvid": "bootstrap-buvid",
                        "cookie": "SESSDATA=bootstrap;",
                        "signature_mode": "cookie"
                    }"#,
                ))?,
        )
        .await?;
    assert_eq!(update.status(), StatusCode::OK);

    let bootstrap = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/bootstrap")
                .header("content-type", "application/json")
                .body(Body::from("{}"))?,
        )
        .await?;
    assert_eq!(bootstrap.status(), StatusCode::OK);

    let bootstrap_body = axum::body::to_bytes(bootstrap.into_body(), usize::MAX).await?;
    let bootstrap_payload: Value = serde_json::from_slice(&bootstrap_body)?;
    assert_eq!(
        bootstrap_payload
            .get("requested_room_id")
            .and_then(Value::as_str),
        Some("12345")
    );
    assert_eq!(
        bootstrap_payload
            .get("resolved_room_id")
            .and_then(Value::as_str),
        Some("54321")
    );
    assert_eq!(
        bootstrap_payload.get("live_status").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        bootstrap_payload
            .get("token_ready")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        bootstrap_payload
            .get("selected_upstream_host")
            .and_then(Value::as_str),
        Some("mock-broadcast.example")
    );
    assert_eq!(
        bootstrap_payload
            .get("upstream_hosts")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(2)
    );

    let danmaku_state = app
        .oneshot(
            Request::builder()
                .uri("/api/danmaku/state")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(danmaku_state.status(), StatusCode::OK);

    let state_body = axum::body::to_bytes(danmaku_state.into_body(), usize::MAX).await?;
    let state_payload: Value = serde_json::from_slice(&state_body)?;
    assert_eq!(
        state_payload
            .get("current_upstream_host")
            .and_then(Value::as_str),
        Some("mock-broadcast.example")
    );

    mock_server.abort();
    Ok(())
}

async fn room_init(Query(query): Query<RoomInitQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "room_id": if query.id == "12345" { 54321 } else { 0 },
            "live_status": 1
        }
    }))
}

async fn get_danmu_info(Query(query): Query<DanmuInfoQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "token": if query.id == "54321" { "mock-token" } else { "" },
            "uid": 2048,
            "live_status": 1,
            "host_list": [
                {
                    "host": "mock-broadcast.example",
                    "port": 2243,
                    "wss_port": 443
                },
                {
                    "host": "mock-backup.example",
                    "port": 2243,
                    "wss_port": 443
                }
            ]
        }
    }))
}



