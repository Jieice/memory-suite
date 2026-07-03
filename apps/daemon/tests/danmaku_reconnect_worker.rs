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
use daemon::{AppStateOptions, build_router};
use serde::Deserialize;
use serde_json::{Value, json};
mod support;
use support::{EnvVarGuard, build_test_state_with_options, native_env_lock};
use tempfile::tempdir;
use tokio::time::{Duration, Instant, sleep};
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
async fn executes_scheduled_reconnects_from_native_worker() -> Result<()> {
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
    let state = build_test_state_with_options(
        AppConfig {
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
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
        },
        AppStateOptions {
            spawn_danmaku_reconnect_worker: true,
            ..AppStateOptions::isolated()
        },
    )
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
                        "room_id": "112233",
                        "uid": 8192,
                        "buvid": "worker-buvid",
                        "cookie": "SESSDATA=worker;",
                        "signature_mode": "cookie"
                    }"#,
                ))?,
        )
        .await?;
    assert_eq!(source.status(), StatusCode::OK);

    state
        .gateway
        .report_disconnect("worker retry".into())
        .await?;

    let connection_state = wait_until(Duration::from_secs(5), || {
        let state = state.clone();
        async move {
            let current = state.storage.get_danmaku_connection_state().await.ok()?;
            (current.attempt_count >= 1 && current.last_connect_attempt_at.is_some())
                .then_some(current)
        }
    })
    .await?;

    assert_eq!(
        connection_state.current_upstream_host.as_deref(),
        Some("127.0.0.1")
    );
    assert!(matches!(
        connection_state.status.as_str(),
        "connecting" | "reconnecting" | "failed"
    ));

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
            anyhow::bail!("timed out waiting for native reconnect worker");
        }
        sleep(Duration::from_millis(50)).await;
    }
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
                    "host": "127.0.0.1",
                    "port": 9,
                    "wss_port": 0
                }
            ]
        }
    }))
}
