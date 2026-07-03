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
use tokio::time::{Duration, sleep};
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
async fn connect_alias_starts_native_session_without_adapter_run() -> Result<()> {
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
            port: 18093,
        },
        storage: StorageConfig {
            database_path: runtime_root
                .join("memory-suite.db")
                .to_string_lossy()
                .to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: PythonConfig {
            executable: "definitely-missing-runtime".into(),
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

    let update = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/source")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{
                        "room_id": "998877",
                        "uid": 4096,
                        "buvid": "connect-alias-buvid",
                        "cookie": "SESSDATA=connect-alias;",
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

    let connect_body = axum::body::to_bytes(connect.into_body(), usize::MAX).await?;
    let connect_payload: Value = serde_json::from_slice(&connect_body)?;
    assert_eq!(connect_payload.get("ok").and_then(Value::as_bool), Some(true));
    let state_payload = connect_payload.get("state").expect("connect state");
    assert_eq!(
        state_payload.get("status").and_then(Value::as_str),
        Some("connecting")
    );
    assert!(state_payload.get("adapter_id").is_none());
    assert_eq!(
        state_payload
            .get("current_upstream_host")
            .and_then(Value::as_str),
        Some("127.0.0.1")
    );
    let session_id = state_payload
        .get("session_id")
        .and_then(Value::as_str)
        .expect("native session id");
    assert!(session_id.starts_with("native:"));

    let adapters = app
        .oneshot(
            Request::builder()
                .uri("/api/runtime/adapters")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(adapters.status(), StatusCode::OK);

    let adapters_body = axum::body::to_bytes(adapters.into_body(), usize::MAX).await?;
    let adapters_payload: Value = serde_json::from_slice(&adapters_body)?;
    let records = adapters_payload.as_array().expect("adapter list");
    assert!(records.is_empty());

    let _ = state.gateway.disconnect().await;
    sleep(Duration::from_millis(50)).await;
    mock_server.abort();
    Ok(())
}

async fn room_init(Query(query): Query<RoomInitQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "room_id": if query.id == "998877" { 887799 } else { 0 },
            "live_status": 1
        }
    }))
}

async fn get_danmu_info(Query(query): Query<DanmuInfoQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "token": if query.id == "887799" { "connect-token" } else { "" },
            "uid": 4096,
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
