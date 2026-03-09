use std::{fs, path::Path, sync::Mutex};

use anyhow::Result;
use api_types::{
    ChatResponse, Live2dAnimationPlan, Live2dSpeechAckResponse, Live2dSpeechNextResponse,
    Live2dSpeechRecord, Live2dStateRecord, MotionCue, SpeechPlaybackPlan, VisemeCue,
};
use app_config::{AppConfig, FeatureFlags, PythonConfig, ServerConfig, StorageConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    serve,
};
use chrono::Utc;
use daemon::{AppState, build_router};
use serde::de::DeserializeOwned;
use serde_json::json;
use storage::NewTtsRecord;
use tempfile::tempdir;
use tower::ServiceExt;
use uuid::Uuid;

static EDGE_TTS_ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvVarGuard {
    key: &'static str,
    original: Option<String>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: String) -> Self {
        let original = std::env::var(key).ok();
        // Safety: integration tests coordinate env writes with a process-global mutex.
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, original }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        // Safety: integration tests coordinate env writes with a process-global mutex.
        unsafe {
            if let Some(value) = &self.original {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }
}

fn test_config(runtime_root: &Path, python_executable: &str) -> AppConfig {
    AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18120,
        },
        storage: StorageConfig {
            database_path: runtime_root
                .join("memory-suite.db")
                .to_string_lossy()
                .to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: PythonConfig {
            executable: python_executable.into(),
            models_root: runtime_root.join("python").to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
        },
    }
}

async fn parse_json<T: DeserializeOwned>(response: axum::response::Response) -> Result<T> {
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    Ok(serde_json::from_slice(&body)?)
}

fn sample_speech_record(id: &str, session_id: &str) -> Live2dSpeechRecord {
    Live2dSpeechRecord {
        id: id.into(),
        session_id: session_id.into(),
        message_id: Uuid::new_v4(),
        assistant_text: format!("assistant reply {id}"),
        speech: SpeechPlaybackPlan {
            request_id: id.into(),
            status: "ready".into(),
            audio_url: Some(format!("/api/audio/{id}")),
            duration_ms: 1_600,
            viseme_timeline: vec![
                VisemeCue {
                    start_ms: 0,
                    end_ms: 700,
                    viseme: "A".into(),
                    mouth_open: 0.72,
                },
                VisemeCue {
                    start_ms: 700,
                    end_ms: 1_600,
                    viseme: "rest".into(),
                    mouth_open: 0.0,
                },
            ],
            error: None,
        },
        animation: Live2dAnimationPlan {
            emotion: "normal".into(),
            subtitle_text: format!("subtitle {id}"),
            motion_timeline: vec![
                MotionCue {
                    at_ms: 0,
                    duration_ms: 1_600,
                    motion: "Idle".into(),
                },
                MotionCue {
                    at_ms: 850,
                    duration_ms: 900,
                    motion: "Tap".into(),
                },
            ],
        },
        status: "pending".into(),
        created_at: Utc::now(),
    }
}

#[tokio::test]
async fn chat_auto_performance_returns_ready_speech_plan_when_edge_tts_is_available() -> Result<()>
{
    let _edge_tts_guard = EDGE_TTS_ENV_LOCK.lock().expect("edge tts env lock");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mock_addr = listener.local_addr()?;
    let mock_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/voices", get(mock_tts_voices))
            .route("/docs", get(mock_tts_docs))
            .route("/tts", post(mock_tts_speech));
        serve(listener, app).await.expect("serve mock edge tts");
    });
    let _port_guard = EnvVarGuard::set("EDGE_TTS_PORT", mock_addr.port().to_string());

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(test_config(&runtime_root, "powershell")).await?;
    let speech_queue = state.live2d_speech_queue.clone();
    let app = build_router(state);

    let chat_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/chat")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "session_id": "speech-ready-session",
                        "text": "请演示完整自动演出流程"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(chat_response.status(), StatusCode::OK);
    let payload: ChatResponse = parse_json(chat_response).await?;

    assert!(!payload.assistant_text.trim().is_empty());
    assert_eq!(
        payload.speech.status, "ready",
        "speech failed with error: {:?}",
        payload.speech.error
    );
    assert!(payload.speech.audio_url.is_some());
    assert!(payload.speech.duration_ms > 0);
    assert!(!payload.speech.viseme_timeline.is_empty());
    assert_eq!(payload.animation.subtitle_text, payload.assistant_text);
    assert!(!payload.animation.motion_timeline.is_empty());

    let state_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/live2d/state")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(state_response.status(), StatusCode::OK);
    let live2d_state: Live2dStateRecord = parse_json(state_response).await?;
    assert_eq!(live2d_state.subtitle, payload.assistant_text);
    assert_eq!(live2d_state.emotion, payload.animation.emotion);

    assert_eq!(speech_queue.read().await.len(), 1);

    let next_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/live2d/speech/next")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(next_response.status(), StatusCode::OK);
    let next_payload: Live2dSpeechNextResponse = parse_json(next_response).await?;
    let queued = next_payload.item.expect("expected queued speech item");
    assert_eq!(queued.id, payload.speech.request_id);
    assert_eq!(queued.status, "playing");

    let audio_url = payload.speech.audio_url.clone().expect("audio url");
    let audio_response = app
        .clone()
        .oneshot(Request::builder().uri(audio_url).body(Body::empty())?)
        .await?;
    assert_eq!(audio_response.status(), StatusCode::OK);
    let audio_bytes = axum::body::to_bytes(audio_response.into_body(), usize::MAX).await?;
    assert_eq!(audio_bytes.as_ref(), b"mock-edge-tts-audio");

    let ack_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/live2d/speech/{}/ack", queued.id))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "status": "completed",
                        "error": null
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(ack_response.status(), StatusCode::OK);
    let ack_payload: Live2dSpeechAckResponse = parse_json(ack_response).await?;
    assert!(ack_payload.ok);
    assert_eq!(
        ack_payload.item.as_ref().map(|item| item.status.as_str()),
        Some("completed")
    );

    mock_server.abort();
    Ok(())
}

#[tokio::test]
async fn chat_auto_performance_degrades_to_failed_speech_without_breaking_text_response()
-> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(test_config(&runtime_root, "__missing_python__")).await?;
    let speech_queue = state.live2d_speech_queue.clone();
    let app = build_router(state);

    let chat_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/chat")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "session_id": "speech-failed-session",
                        "text": "这个链路在 tts 不可用时也要回文本"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(chat_response.status(), StatusCode::OK);
    let payload: ChatResponse = parse_json(chat_response).await?;

    assert!(!payload.assistant_text.trim().is_empty());
    assert_eq!(payload.speech.status, "failed");
    assert!(payload.speech.audio_url.is_none());
    assert!(payload.speech.error.is_some());
    assert_eq!(payload.animation.subtitle_text, payload.assistant_text);
    assert!(!payload.animation.motion_timeline.is_empty());

    let state_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/live2d/state")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(state_response.status(), StatusCode::OK);
    let live2d_state: Live2dStateRecord = parse_json(state_response).await?;
    assert_eq!(live2d_state.subtitle, payload.assistant_text);
    assert_eq!(live2d_state.emotion, payload.animation.emotion);

    assert_eq!(speech_queue.read().await.len(), 0);
    Ok(())
}

#[tokio::test]
async fn live2d_speech_next_and_ack_preserve_order_and_resume_playing_item() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(test_config(&runtime_root, "powershell")).await?;
    let speech_queue = state.live2d_speech_queue.clone();
    {
        let mut queue = speech_queue.write().await;
        queue.push_back(sample_speech_record("speech-1", "queue-session"));
        queue.push_back(sample_speech_record("speech-2", "queue-session"));
    }
    let app = build_router(state);

    let next1 = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/live2d/speech/next")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(next1.status(), StatusCode::OK);
    let payload1: Live2dSpeechNextResponse = parse_json(next1).await?;
    let first = payload1.item.expect("first queued item missing");
    assert_eq!(first.id, "speech-1");
    assert_eq!(first.status, "playing");

    let next2 = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/live2d/speech/next")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(next2.status(), StatusCode::OK);
    let payload2: Live2dSpeechNextResponse = parse_json(next2).await?;
    let still_first = payload2.item.expect("playing item should be resumable");
    assert_eq!(still_first.id, "speech-1");
    assert_eq!(still_first.status, "playing");

    let ack1 = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/live2d/speech/speech-1/ack")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "status": "completed",
                        "error": null
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(ack1.status(), StatusCode::OK);

    let next3 = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/live2d/speech/next")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(next3.status(), StatusCode::OK);
    let payload3: Live2dSpeechNextResponse = parse_json(next3).await?;
    let second = payload3.item.expect("second queued item missing");
    assert_eq!(second.id, "speech-2");
    assert_eq!(second.status, "playing");

    let ack2 = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/live2d/speech/speech-2/ack")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "status": "failed",
                        "error": "overlay playback error"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(ack2.status(), StatusCode::OK);
    let ack2_payload: Live2dSpeechAckResponse = parse_json(ack2).await?;
    assert!(ack2_payload.ok);
    assert_eq!(
        ack2_payload.item.as_ref().map(|item| item.status.as_str()),
        Some("failed")
    );
    assert_eq!(
        ack2_payload
            .item
            .as_ref()
            .and_then(|item| item.speech.error.as_deref()),
        Some("overlay playback error")
    );

    let next4 = app
        .oneshot(
            Request::builder()
                .uri("/api/live2d/speech/next")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(next4.status(), StatusCode::OK);
    let payload4: Live2dSpeechNextResponse = parse_json(next4).await?;
    assert!(payload4.item.is_none());

    Ok(())
}

#[tokio::test]
async fn audio_endpoint_streams_cached_tts_audio_by_request_id() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let audio_cache_dir = runtime_root.join("audio-cache");
    fs::create_dir_all(&audio_cache_dir)?;
    let state = AppState::from_config(test_config(&runtime_root, "powershell")).await?;
    let storage = state.storage.clone();
    let app = build_router(state);

    let queued = storage
        .enqueue_tts(NewTtsRecord {
            session_id: "audio-session".into(),
            text: "cached audio".into(),
            voice: Some("edge-tts-zh".into()),
        })
        .await?;
    let audio_path = audio_cache_dir.join(format!("{}.wav", queued.id));
    fs::write(&audio_path, b"RIFFmockwave")?;
    storage
        .update_tts_result(
            queued.id,
            "completed",
            Some("edge_tts"),
            Some(&audio_path.to_string_lossy()),
        )
        .await?;

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/audio/{}", queued.id))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("audio/wav")
    );
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(body.as_ref(), b"RIFFmockwave");

    Ok(())
}

async fn mock_tts_voices() -> impl IntoResponse {
    axum::Json(json!({
        "voices": ["edge-tts-zh"]
    }))
}

async fn mock_tts_docs() -> impl IntoResponse {
    axum::Json(json!({
        "ok": true
    }))
}

async fn mock_tts_speech() -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "audio/mpeg")],
        "mock-edge-tts-audio".as_bytes().to_vec(),
    )
}
