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
use serde::Deserialize;
use serde_json::{Value, json};
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
async fn executes_scheduled_reconnects_from_rust_worker() -> Result<()> {
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

    // Safety: this integration test owns its process and uses unique mock endpoints.
    unsafe {
        std::env::set_var(
            "MEMORY_SUITE_BILIBILI_ROOM_INIT_BASE",
            format!("http://{mock_addr}"),
        );
        std::env::set_var(
            "MEMORY_SUITE_BILIBILI_DANMU_INFO_BASE",
            format!("http://{mock_addr}"),
        );
    }

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18097,
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
                    },
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
                        "room_id": "112233",
                        "uid": 8192,
                        "buvid": "worker-buvid",
                        "cookie": "SESSDATA=worker;",
                        "signature_mode": "cookie",
                        "connection_mode": "websocket"
                    }"#,
                ))?,
        )
        .await?;
    assert_eq!(source.status(), StatusCode::OK);

    let disconnect = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/danmaku/report-disconnect")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"reason":"worker retry"}"#))?,
        )
        .await?;
    assert_eq!(disconnect.status(), StatusCode::OK);

    sleep(Duration::from_millis(1400)).await;

    let state_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/danmaku/state")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(state_response.status(), StatusCode::OK);

    let state_body = axum::body::to_bytes(state_response.into_body(), usize::MAX).await?;
    let state_payload: Value = serde_json::from_slice(&state_body)?;
    let status = state_payload.get("status").and_then(Value::as_str);
    assert!(
        matches!(status, Some("connecting") | Some("reconnecting") | Some("failed")),
        "expected reconnect worker to leave state in connecting/reconnecting/failed, got {status:?}"
    );
    let attempt_count = state_payload.get("attempt_count").and_then(Value::as_u64);
    assert!(
        attempt_count.is_some_and(|count| count >= 1),
        "expected reconnect worker to record at least one reconnect attempt, got {attempt_count:?}"
    );
    assert_eq!(
        state_payload
            .get("current_upstream_host")
            .and_then(Value::as_str),
        Some("worker-primary.example")
    );
    assert!(state_payload.get("last_connect_attempt_at").is_some());
    assert!(
        state_payload
            .get("next_retry_at")
            .is_none_or(Value::is_null)
    );

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
    assert!(
        records
            .iter()
            .any(|record| record.get("adapter_id").and_then(Value::as_str)
                == Some("danmaku_protocol"))
    );

    mock_server.abort();
    Ok(())
}

async fn room_init(Query(query): Query<RoomInitQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "room_id": if query.id == "112233" { 332211 } else { 0 },
            "live_status": 1
        }
    }))
}

async fn get_danmu_info(Query(query): Query<DanmuInfoQuery>) -> impl IntoResponse {
    Json(json!({
        "code": 0,
        "data": {
            "token": if query.id == "332211" { "worker-token" } else { "" },
            "uid": 8192,
            "live_status": 1,
            "host_list": [
                {
                    "host": "worker-primary.example",
                    "port": 2243,
                    "wss_port": 443
                }
            ]
        }
    }))
}
