use anyhow::Result;
use api_types::AdapterStatus;
use app_config::{AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig};
use axum::{
    body::{Body, Bytes},
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use serde_json::{Value, json};
use storage::NewAdapterRunRecord;
use tempfile::tempdir;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn dispatches_tts_requests_through_a_real_python_worker() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let python_root = dir.path().join("python");
    let tts_root = python_root.join("tts");
    tokio::fs::create_dir_all(&tts_root).await?;
    let worker_script = tts_root.join("edge_tts_server.py");
    tokio::fs::write(
        &worker_script,
        r#"
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 9881

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/voices":
            payload = json.dumps({"voice": "mock", "available": True}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path != "/tts":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if payload.get("voice") != "edge-tts-en":
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"detail": "voice was not forwarded"}).encode("utf-8"))
            return
        audio = b"ID3mock-audio"
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, format, *args):
        return

server = HTTPServer(("127.0.0.1", PORT), Handler)
server.timeout = 10
server.handle_request()
server.handle_request()
"#,
    )
    .await?;

    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18085,
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
            models_root: python_root.to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: false,
        },
        tts: TtsConfig {
            provider: Some("edge_tts".into()),
            endpoint: Some("http://127.0.0.1:9881".into()),
            health_path: Some("/voices".into()),
            chat_voice: Some("edge-tts-en".into()),
            speech_rate: None,
        },
        llm: LlmConfig::default(),
    })
    .await?;

    let app = build_router(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tts/speak")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "session_id": "tts-session",
                        "text": "dispatch this",
                        "voice": "edge-tts-en"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected tts response body: {}",
        String::from_utf8_lossy(&body)
    );

    let payload: Value = serde_json::from_slice(&body)?;
    assert_eq!(
        payload.get("status").and_then(Value::as_str),
        Some("completed")
    );

    let request_id = payload
        .get("request_id")
        .and_then(Value::as_str)
        .expect("tts request id");

    let record = state
        .storage
        .get_tts_request(Uuid::parse_str(request_id)?)
        .await?;
    assert_eq!(record.status, "completed");
    assert_eq!(record.adapter_id.as_deref(), Some("edge_tts"));
    assert!(record.audio_path.is_some());
    assert!(
        record
            .audio_path
            .as_deref()
            .is_some_and(|path| path.ends_with(".wav") || path.ends_with(".mp3")),
        "expected cached audio path, got {:?}",
        record.audio_path
    );

    let adapters = state.storage.list_adapter_runs().await?;
    assert_eq!(adapters.len(), 1);
    assert_eq!(adapters[0].adapter_id, "edge_tts");
    assert_eq!(adapters[0].python_executable, "python");
    Ok(())
}

#[tokio::test]
async fn streaming_tts_waits_for_full_upstream_download_before_marking_request_completed() -> Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mock_addr = listener.local_addr()?;
    let mock_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route(
                "/voices",
                axum::routing::get(|| async { axum::Json(json!({ "voice": "mock", "available": true })) }),
            )
            .route(
                "/tts",
                axum::routing::post(|| async {
                    let stream = futures_util::stream::unfold(0u8, |state| async move {
                        match state {
                            0 => Some((
                                Ok::<Bytes, std::convert::Infallible>(Bytes::from_static(
                                    b"ID3first-playable-chunk",
                                )),
                                1,
                            )),
                            1 => {
                                tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
                                Some((
                                    Ok::<Bytes, std::convert::Infallible>(Bytes::from_static(
                                        b"-second-chunk-after-delay",
                                    )),
                                    2,
                                ))
                            }
                            _ => None,
                        }
                    });

                    (
                        [(axum::http::header::CONTENT_TYPE, "audio/mpeg")],
                        Body::from_stream(stream),
                    )
                }),
            );
        axum::serve(listener, app)
            .await
            .expect("serve streaming tts test worker");
    });

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let python_root = dir.path().join("python");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18088,
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
            models_root: python_root.to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: false,
        },
        tts: TtsConfig {
            provider: Some("edge_tts".into()),
            endpoint: Some(format!("http://{}", mock_addr)),
            health_path: Some("/voices".into()),
            chat_voice: Some("edge-tts-en".into()),
            speech_rate: None,
        },
        llm: LlmConfig::default(),
    })
    .await?;

    let app = build_router(state.clone());

    let warmup_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tts/speak")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "session_id": "tts-streaming-warmup",
                        "text": "warm worker",
                        "voice": "edge-tts-en"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(warmup_response.status(), StatusCode::OK);
    let _warmup_body = axum::body::to_bytes(warmup_response.into_body(), usize::MAX).await?;

    let start = std::time::Instant::now();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tts/speak")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "session_id": "tts-streaming",
                        "text": "stream this",
                        "voice": "edge-tts-en"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    let elapsed = start.elapsed();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected tts response body: {}",
        String::from_utf8_lossy(&body)
    );

    let payload: Value = serde_json::from_slice(&body)?;
    assert_eq!(payload.get("status").and_then(Value::as_str), Some("completed"));
    assert!(
        elapsed >= std::time::Duration::from_millis(1100),
        "streaming dispatch should wait for full upstream completion before becoming ready, but took {:?}",
        elapsed
    );

    let request_id = payload
        .get("request_id")
        .and_then(Value::as_str)
        .expect("tts request id");
    let record = state
        .storage
        .get_tts_request(Uuid::parse_str(request_id)?)
        .await?;
    assert_eq!(record.status, "completed");
    assert!(record.audio_path.is_some());

    mock_server.abort();
    Ok(())
}

#[tokio::test]
async fn tts_dispatch_fails_when_edge_tts_is_marked_running_but_worker_is_gone() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let python_root = dir.path().join("python");
    let stale_port = std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port();

    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18086,
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
            models_root: python_root.to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: false,
        },
        tts: TtsConfig {
            provider: Some("edge_tts".into()),
            endpoint: Some(format!("http://127.0.0.1:{stale_port}")),
            health_path: Some("/voices".into()),
            chat_voice: Some("edge-tts-en".into()),
            speech_rate: None,
        },
        llm: LlmConfig::default(),
    })
    .await?;

    state
        .storage
        .create_adapter_run(NewAdapterRunRecord {
            adapter_id: "edge_tts".into(),
            status: AdapterStatus::Running,
            python_executable: "python".into(),
            args: vec!["tts/edge_tts_server.py".into()],
            pid: Some(999_999),
            last_error: None,
        })
        .await?;

    let app = build_router(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tts/speak")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "session_id": "tts-stale",
                        "text": "revive worker",
                        "voice": "edge-tts-en"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "unexpected tts response body: {}",
        String::from_utf8_lossy(&body)
    );

    let error_body = String::from_utf8_lossy(&body);
    let adapters = state.storage.list_adapter_runs().await?;
    assert!(adapters.iter().any(|record| {
        record.adapter_id == "edge_tts"
            && record.pid == Some(999_999)
            && record.status == AdapterStatus::Failed
            && record
                .last_error
                .as_deref()
                .is_some_and(|error| error.contains("stale adapter run"))
    }));

    assert!(body.is_empty(), "unexpected tts failure body: {error_body}");

    Ok(())
}

#[tokio::test]
async fn tts_dispatch_falls_back_to_mock_when_worker_is_unreachable() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let python_root = dir.path().join("python");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18087,
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
            models_root: python_root.to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
        },
        tts: TtsConfig {
            provider: Some("sovits".into()),
            endpoint: Some("http://127.0.0.1:29982".into()),
            health_path: Some("/docs".into()),
            chat_voice: None,
            speech_rate: None,
        },
        llm: LlmConfig::default(),
    })
    .await?;

    let app = build_router(state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/tts/speak")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "session_id": "tts-mock",
                        "text": "fallback to mock"
                    })
                    .to_string(),
                ))?,
        )
        .await?;

    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));

    let payload: Value = serde_json::from_slice(&body)?;
    assert_eq!(payload.get("status").and_then(Value::as_str), Some("mocked"));

    let request_id = payload
        .get("request_id")
        .and_then(Value::as_str)
        .expect("tts request id");
    let record = state
        .storage
        .get_tts_request(Uuid::parse_str(request_id)?)
        .await?;
    assert_eq!(record.status, "mocked");
    assert_eq!(record.adapter_id.as_deref(), Some("sovits"));
    assert!(record.audio_path.is_none());

    Ok(())
}
