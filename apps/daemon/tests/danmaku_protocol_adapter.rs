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
use serde_json::Value;
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
async fn connect_uses_supervised_protocol_adapter_and_persists_failures() -> Result<()> {
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
                        "room_id": "998877",
                        "uid": 4096,
                        "buvid": "protocol-buvid",
                        "cookie": "SESSDATA=protocol;",
                        "signature_mode": "cookie",
                        "connection_mode": "websocket"
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
    assert_eq!(
        state_payload.get("status").and_then(Value::as_str),
        Some("failed")
    );
    assert_eq!(
        state_payload.get("adapter_id").and_then(Value::as_str),
        Some("danmaku_protocol")
    );
    assert_eq!(
        state_payload
            .get("current_upstream_host")
            .and_then(Value::as_str),
        Some("protocol-broadcast.example")
    );
    assert!(
        state_payload
            .get("last_error")
            .and_then(Value::as_str)
            .is_some()
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
    assert!(!records.is_empty());
    assert!(records.iter().any(|record| {
        record.get("adapter_id").and_then(Value::as_str) == Some("danmaku_protocol")
            && record.get("status").and_then(Value::as_str) == Some("failed")
    }));

    mock_server.abort();
    Ok(())
}

async fn room_init(Query(query): Query<RoomInitQuery>) -> impl IntoResponse {
    Json(serde_json::json!({
        "code": 0,
        "data": {
            "room_id": if query.id == "998877" { 887799 } else { 0 },
            "live_status": 1
        }
    }))
}

async fn get_danmu_info(Query(query): Query<DanmuInfoQuery>) -> impl IntoResponse {
    Json(serde_json::json!({
        "code": 0,
        "data": {
            "token": if query.id == "887799" { "protocol-token" } else { "" },
            "uid": 4096,
            "live_status": 1,
            "host_list": [
                {
                    "host": "protocol-broadcast.example",
                    "port": 2243,
                    "wss_port": 443
                }
            ]
        }
    }))
}
