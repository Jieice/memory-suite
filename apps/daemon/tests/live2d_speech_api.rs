use std::{
    fs,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use anyhow::Result;
use api_types::{
    ChatRequest, ChatResponse, Live2dAnimationPlan, Live2dSpeechAckResponse,
    Live2dSpeechCancelResponse, Live2dSpeechNextResponse, Live2dSpeechRecord, Live2dStateRecord,
    MotionCue, SpeechPlaybackPlan,
    VisemeCue,
};
use app_config::{
    AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, SttConfig,
    TtsConfig,
};
use axum::body::Bytes;
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    serve,
};
use chrono::Utc;
use daemon::{AppState, build_router};
use futures_util::stream;
use serde::de::DeserializeOwned;
use serde_json::json;
use storage::NewTtsRecord;
use tempfile::tempdir;
use tower::ServiceExt;
use uuid::Uuid;

use tokio::time::{Duration, Instant};
mod support;
use support::prepare_placeholder_tts_scripts;

fn test_config(runtime_root: &Path, python_executable: &str) -> AppConfig {
    test_config_with_tts_endpoint(runtime_root, python_executable, None)
}

fn test_config_with_tts_endpoint(
    runtime_root: &Path,
    python_executable: &str,
    tts_endpoint: Option<String>,
) -> AppConfig {
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
        tts: TtsConfig {
            endpoint: tts_endpoint,
            ..TtsConfig::default()
        },
        stt: SttConfig::default(),
        llm: LlmConfig::default(),
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mock_addr = listener.local_addr()?;
    let mock_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/voices", get(mock_tts_voices))
            .route("/docs", get(mock_tts_docs))
            .route("/tts", post(mock_tts_speech));
        serve(listener, app).await.expect("serve mock edge tts");
    });

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    prepare_placeholder_tts_scripts(&runtime_root.join("python")).await?;
    let state = AppState::from_config(test_config_with_tts_endpoint(
        &runtime_root,
        "python",
        Some(format!("http://{}", mock_addr)),
    ))
    .await?;
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
                        "text": "请演示完整自动表演流程"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(chat_response.status(), StatusCode::OK);
    let payload: ChatResponse = parse_json(chat_response).await?;

    assert!(payload.assistant_text.trim().is_empty());
    assert_eq!(payload.speech.status, "not_requested");
    assert!(payload.speech.audio_url.is_none());
    assert_eq!(payload.speech.duration_ms, 0);
    assert!(payload.speech.viseme_timeline.is_empty());
    assert_eq!(payload.animation.subtitle_text, "");
    assert!(payload.animation.motion_timeline.is_empty());

    let ready_deadline = Instant::now() + Duration::from_millis(5_000);
    while Instant::now() < ready_deadline && speech_queue.is_empty().await {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        speech_queue.is_empty().await,
        "no model reply should keep the live2d speech queue empty"
    );

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
    assert_eq!(live2d_state.subtitle, "");
    assert_eq!(live2d_state.emotion, "normal");

    assert_eq!(speech_queue.len().await, 0);

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
    assert!(next_payload.item.is_none());

    mock_server.abort();
    Ok(())
}

#[tokio::test]
async fn live2d_queue_waits_for_streaming_tts_to_fully_finish_before_exposing_ready_item()
-> Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mock_addr = listener.local_addr()?;
    let mock_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/voices", get(mock_tts_voices))
            .route("/docs", get(mock_tts_docs))
            .route("/tts", post(mock_streaming_tts_speech));
        serve(listener, app)
            .await
            .expect("serve streaming edge tts");
    });

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    prepare_placeholder_tts_scripts(&runtime_root.join("python")).await?;
    let state = AppState::from_config(test_config_with_tts_endpoint(
        &runtime_root,
        "python",
        Some(format!("http://{}", mock_addr)),
    ))
    .await?;
    let speech_queue = state.live2d_speech_queue.clone();
    let app = build_router(state);

    let start = Instant::now();
    let chat_task = {
        let app = app.clone();
        tokio::spawn(async move {
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/chat")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "session_id": "streaming-live2d-session",
                            "text": "请给我一段稍长一些的中文回复，用来验证 live2d 语音队列只会在完整音频下载完成后才变为 ready。"
                        })
                        .to_string(),
                    ))
                    .expect("build chat request"),
            )
            .await
        })
    };

    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        speech_queue.is_empty().await,
        "speech queue should stay empty while streaming audio is still incomplete"
    );

    let next_before_ready = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/live2d/speech/next")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(next_before_ready.status(), StatusCode::OK);
    let next_before_ready_payload: Live2dSpeechNextResponse = parse_json(next_before_ready).await?;
    assert!(next_before_ready_payload.item.is_none());

    let chat_response = chat_task.await??;
    let elapsed = start.elapsed();
    assert_eq!(chat_response.status(), StatusCode::OK);
    let payload: ChatResponse = parse_json(chat_response).await?;

    assert!(payload.assistant_text.trim().is_empty());
    assert_eq!(payload.speech.status, "not_requested");
    assert!(
        elapsed < Duration::from_millis(1100),
        "/api/chat should return early when no model reply is available, but took {:?}",
        elapsed
    );

    assert_eq!(speech_queue.len().await, 0);

    let next_after_ready = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/live2d/speech/next")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(next_after_ready.status(), StatusCode::OK);
    let next_after_ready_payload: Live2dSpeechNextResponse = parse_json(next_after_ready).await?;
    assert!(next_after_ready_payload.item.is_none());

    mock_server.abort();
    Ok(())
}

#[tokio::test]
async fn status_command_does_not_wait_for_full_tts_completion_before_returning() -> Result<()> {
    let tts_hits = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mock_addr = listener.local_addr()?;
    let tts_hits_for_server = Arc::clone(&tts_hits);
    let mock_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/voices", get(mock_tts_voices))
            .route("/docs", get(mock_tts_docs))
            .route(
                "/tts",
                post(move || {
                    let tts_hits = Arc::clone(&tts_hits_for_server);
                    async move {
                        tts_hits.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                        mock_tts_speech().await.into_response()
                    }
                }),
            );
        serve(listener, app).await.expect("serve slow edge tts");
    });

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    prepare_placeholder_tts_scripts(&runtime_root.join("python")).await?;
    let state = AppState::from_config(test_config_with_tts_endpoint(
        &runtime_root,
        "python",
        Some(format!("http://{}", mock_addr)),
    ))
    .await?;

    let request = ChatRequest {
        session_id: Some("status-fast-return".into()),
        user_id: None,
        text: "/status".into(),
    };

    let orchestrator_start = Instant::now();
    let response = state.orchestrator.handle_chat(request.clone()).await?;
    let orchestrator_elapsed = orchestrator_start.elapsed();

    let finalize_start = Instant::now();
    let payload = state.chat_response_finalizer.finalize(response, None).await?;
    let finalize_elapsed = finalize_start.elapsed();

    assert!(payload.assistant_text.contains("runtime ok:"));
    assert_eq!(payload.speech.status, "dispatching");
    assert!(
        finalize_elapsed < Duration::from_millis(500),
        "/status finalize should return before slow tts finishes, but took {:?} (orchestrator {:?})",
        finalize_elapsed,
        orchestrator_elapsed
    );

    let tts_hit_deadline = Instant::now() + Duration::from_millis(1_200);
    while Instant::now() < tts_hit_deadline && tts_hits.load(Ordering::SeqCst) == 0 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        tts_hits.load(Ordering::SeqCst) <= 1,
        "background tts dispatch should not hit the adapter more than once during observation window"
    );

    mock_server.abort();
    Ok(())
}

#[tokio::test]
async fn general_chat_fallback_does_not_wait_for_full_tts_completion_before_returning() -> Result<()>
{
    let tts_hits = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mock_addr = listener.local_addr()?;
    let tts_hits_for_server = Arc::clone(&tts_hits);
    let mock_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/voices", get(mock_tts_voices))
            .route("/docs", get(mock_tts_docs))
            .route(
                "/tts",
                post(move || {
                    let tts_hits = Arc::clone(&tts_hits_for_server);
                    async move {
                        tts_hits.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                        mock_tts_speech().await.into_response()
                    }
                }),
            );
        serve(listener, app).await.expect("serve slow edge tts");
    });

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    prepare_placeholder_tts_scripts(&runtime_root.join("python")).await?;
    let state = AppState::from_config(test_config_with_tts_endpoint(
        &runtime_root,
        "python",
        Some(format!("http://{}", mock_addr)),
    ))
    .await?;

    let request = ChatRequest {
        session_id: Some("hello-fast-return".into()),
        user_id: Some("operator".into()),
        text: "hello".into(),
    };

    let response = state.orchestrator.handle_chat(request).await?;
    let finalize_start = Instant::now();
    let payload = state.chat_response_finalizer.finalize(response, None).await?;
    let finalize_elapsed = finalize_start.elapsed();

    assert!(payload.assistant_text.trim().is_empty());
    assert_eq!(payload.speech.status, "not_requested");
    assert!(payload.speech.audio_url.is_none());
    assert!(
        finalize_elapsed < Duration::from_millis(500),
        "general chat without model reply should return immediately, but took {:?}",
        finalize_elapsed
    );

    let tts_hit_deadline = Instant::now() + Duration::from_millis(1_200);
    while Instant::now() < tts_hit_deadline && tts_hits.load(Ordering::SeqCst) == 0 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        tts_hits.load(Ordering::SeqCst) == 0,
        "no model reply should not hit the tts adapter"
    );

    mock_server.abort();
    Ok(())
}

#[tokio::test]
async fn memory_command_does_not_wait_for_full_tts_completion_before_returning() -> Result<()> {
    let tts_hits = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mock_addr = listener.local_addr()?;
    let tts_hits_for_server = Arc::clone(&tts_hits);
    let mock_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/voices", get(mock_tts_voices))
            .route("/docs", get(mock_tts_docs))
            .route(
                "/tts",
                post(move || {
                    let tts_hits = Arc::clone(&tts_hits_for_server);
                    async move {
                        tts_hits.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                        mock_tts_speech().await.into_response()
                    }
                }),
            );
        serve(listener, app).await.expect("serve slow edge tts");
    });

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    prepare_placeholder_tts_scripts(&runtime_root.join("python")).await?;
    let state = AppState::from_config(test_config_with_tts_endpoint(
        &runtime_root,
        "python",
        Some(format!("http://{}", mock_addr)),
    ))
    .await?;

    let request = ChatRequest {
        session_id: Some("memory-fast-return".into()),
        user_id: Some("operator".into()),
        text: "/memory".into(),
    };

    let response = state.orchestrator.handle_chat(request).await?;
    let finalize_start = Instant::now();
    let payload = state.chat_response_finalizer.finalize(response, None).await?;
    let finalize_elapsed = finalize_start.elapsed();

    assert!(
        payload
            .assistant_text
            .contains("No imported memory was found")
            || payload.assistant_text.contains("memory snapshot:")
    );
    assert_eq!(payload.speech.status, "dispatching");
    assert!(
        finalize_elapsed < Duration::from_millis(500),
        "/memory finalize should return before slow tts finishes, but took {:?}",
        finalize_elapsed
    );

    let tts_hit_deadline = Instant::now() + Duration::from_millis(1_200);
    while Instant::now() < tts_hit_deadline && tts_hits.load(Ordering::SeqCst) == 0 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        tts_hits.load(Ordering::SeqCst) <= 1,
        "background tts dispatch should not hit the adapter more than once during observation window"
    );

    mock_server.abort();
    Ok(())
}

#[tokio::test]
async fn empty_message_does_not_wait_for_full_tts_completion_before_returning() -> Result<()> {
    let tts_hits = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mock_addr = listener.local_addr()?;
    let tts_hits_for_server = Arc::clone(&tts_hits);
    let mock_server = tokio::spawn(async move {
        let app = axum::Router::new()
            .route("/voices", get(mock_tts_voices))
            .route("/docs", get(mock_tts_docs))
            .route(
                "/tts",
                post(move || {
                    let tts_hits = Arc::clone(&tts_hits_for_server);
                    async move {
                        tts_hits.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                        mock_tts_speech().await.into_response()
                    }
                }),
            );
        serve(listener, app).await.expect("serve slow edge tts");
    });

    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    prepare_placeholder_tts_scripts(&runtime_root.join("python")).await?;
    let state = AppState::from_config(test_config_with_tts_endpoint(
        &runtime_root,
        "python",
        Some(format!("http://{}", mock_addr)),
    ))
    .await?;

    let request = ChatRequest {
        session_id: Some("empty-fast-return".into()),
        user_id: Some("operator".into()),
        text: "".into(),
    };

    let response = state.orchestrator.handle_chat(request).await?;
    let finalize_start = Instant::now();
    let payload = state.chat_response_finalizer.finalize(response, None).await?;
    let finalize_elapsed = finalize_start.elapsed();

    assert!(payload.assistant_text.trim().is_empty());
    assert_eq!(payload.speech.status, "not_requested");
    assert!(
        finalize_elapsed < Duration::from_millis(500),
        "empty-message finalize should return before slow tts finishes, but took {:?}",
        finalize_elapsed
    );

    let tts_hit_deadline = Instant::now() + Duration::from_millis(1_200);
    while Instant::now() < tts_hit_deadline && tts_hits.load(Ordering::SeqCst) == 0 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        tts_hits.load(Ordering::SeqCst) == 0,
        "empty message without model reply should not hit the tts adapter"
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
                        "text": "这个链路在 tts 不可用时也要回文本吗"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(chat_response.status(), StatusCode::OK);
    let payload: ChatResponse = parse_json(chat_response).await?;

    assert!(payload.assistant_text.trim().is_empty());
    assert_eq!(payload.speech.status, "not_requested");
    assert!(payload.speech.audio_url.is_none());
    assert!(payload.speech.error.is_none());
    assert_eq!(payload.animation.subtitle_text, "");
    assert!(payload.animation.motion_timeline.is_empty());

    let failure_deadline = Instant::now() + Duration::from_millis(1_200);
    while Instant::now() < failure_deadline && speech_queue.is_empty().await {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(speech_queue.len().await, 0);

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
    assert_eq!(live2d_state.subtitle, "");
    assert_eq!(live2d_state.emotion, "normal");

    assert_eq!(speech_queue.len().await, 0);
    Ok(())
}

#[tokio::test]
async fn live2d_speech_next_and_ack_preserve_order_and_resume_playing_item() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(test_config(&runtime_root, "python")).await?;
    let speech_queue = state.live2d_speech_queue.clone();
    speech_queue
        .enqueue(sample_speech_record("speech-1", "queue-session"))
        .await;
    speech_queue
        .enqueue(sample_speech_record("speech-2", "queue-session"))
        .await;
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
async fn live2d_speech_get_and_cancel_expose_failed_status_for_active_item() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(test_config(&runtime_root, "python")).await?;
    let speech_queue = state.live2d_speech_queue.clone();
    speech_queue
        .enqueue(sample_speech_record("speech-probe", "probe-session"))
        .await;
    let app = build_router(state);

    let claim = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/live2d/speech/next")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(claim.status(), StatusCode::OK);
    let claim_payload: Live2dSpeechNextResponse = parse_json(claim).await?;
    let claimed = claim_payload.item.expect("queued speech should be claimable");
    assert_eq!(claimed.id, "speech-probe");
    assert_eq!(claimed.status, "playing");

    let cancel = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/live2d/speech/cancel")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "session_id": "probe-session",
                        "reason": "manual interrupt"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(cancel.status(), StatusCode::OK);
    let cancel_payload: Live2dSpeechCancelResponse = parse_json(cancel).await?;
    assert!(cancel_payload.ok);
    assert_eq!(cancel_payload.cancelled_count, 1);

    let get_after_cancel = app
        .oneshot(
            Request::builder()
                .uri("/api/live2d/speech/speech-probe")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(get_after_cancel.status(), StatusCode::OK);
    let probe_payload: Live2dSpeechNextResponse = parse_json(get_after_cancel).await?;
    let probed = probe_payload
        .item
        .expect("cancelled speech should remain queryable for overlay probe");
    assert_eq!(probed.id, "speech-probe");
    assert_eq!(probed.status, "failed");
    assert_eq!(probed.speech.error.as_deref(), Some("manual interrupt"));

    Ok(())
}

#[tokio::test]
async fn audio_endpoint_streams_cached_tts_audio_by_request_id() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let audio_cache_dir = runtime_root.join("audio-cache");
    fs::create_dir_all(&audio_cache_dir)?;
    let state = AppState::from_config(test_config(&runtime_root, "python")).await?;
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

async fn mock_streaming_tts_speech() -> impl IntoResponse {
    let stream = stream::unfold(0u8, |state| async move {
        match state {
            0 => Some((
                Ok::<Bytes, std::convert::Infallible>(Bytes::from_static(
                    b"ID3first-playable-chunk",
                )),
                1,
            )),
            1 => {
                tokio::time::sleep(Duration::from_millis(1200)).await;
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
}
