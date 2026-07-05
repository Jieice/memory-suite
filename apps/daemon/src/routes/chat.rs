use std::sync::Arc;

use api_types::{ChatRequest, ChatTimingRecord, SessionInterruptResponse};
use axum::{
    Json,
    extract::{Path as AxumPath, State},
};
use tokio::time::{Duration, Instant};
use uuid::Uuid;

use crate::AppState;

pub(crate) async fn chat(
    State(state): State<Arc<AppState>>,
    Json(mut request): Json<ChatRequest>,
) -> Result<Json<api_types::ChatResponse>, axum::http::StatusCode> {
    let session_id = request
        .session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    request.session_id = Some(session_id.clone());
    let turn_generation = state.session_turn_guard.begin_turn(&session_id).await;
    let request_preview = request.text.chars().take(60).collect::<String>();
    let chat_started = Instant::now();
    // Update idle presence timer
    if let Ok(mut t) = state.last_chat_at.lock() {
        *t = std::time::Instant::now();
    }
    // Increment session turn counter
    let turn = state
        .session_turns
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        + 1;
    let handle_started = Instant::now();
    // Build scene hint from current context and recent events
    let scene_hint = {
        let ctx = state.scene_context.read().await.clone();
        let events = state.scene_events.read().await;
        let mut parts = Vec::new();
        if let Some(ref c) = ctx {
            parts.push(format!("Screen: {}", c.description));
        }
        let recent: Vec<_> = events.iter().rev().take(3).collect();
        for e in recent.iter().rev() {
            let detail = e.detail.as_deref().unwrap_or("");
            parts.push(format!("Event[{}]: {}", e.kind, detail));
        }
        // Add active audience context
        {
            let audience = state.audience.read().await;
            let now = std::time::Instant::now();
            let active_count = audience
                .values()
                .filter(|(_, _, last)| now.duration_since(*last).as_secs() < 300)
                .count();
            if active_count > 0 {
                parts.push(format!("Active viewers in chat: {active_count}"));
                // Top 3 most active
                let mut top: Vec<_> = audience
                    .iter()
                    .filter(|(_, (_, _, last))| now.duration_since(*last).as_secs() < 300)
                    .collect();
                top.sort_by(|a, b| b.1.0.cmp(&a.1.0));
                for (uid, (count, msg, _)) in top.iter().take(3) {
                    parts.push(format!(
                        "  {uid} ({count} msgs): \"{}\"",
                        msg.chars().take(30).collect::<String>()
                    ));
                }
            }
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts.join("\n"))
        }
    };

    // Add energy level to scene hint
    let scene_hint = {
        let energy = match turn {
            0..=10 => None, // Fresh: no hint needed
            11..=25 => Some("Energy: normal. Still engaged."),
            26..=50 => Some("Energy: getting tired. Keep replies a bit shorter and more direct."),
            _ => Some("Energy: low. Very brief replies. Reserve energy."),
        };
        match (energy, scene_hint) {
            (Some(e), Some(s)) => Some(format!("{s}\n{e}")),
            (Some(e), None) => Some(e.to_string()),
            (_, s) => s,
        }
    };

    let response = state
        .orchestrator
        .handle_chat_with_scene(request.clone(), scene_hint)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let handle_elapsed = handle_started.elapsed();

    // Persona state after generation: drives mood-based TTS voice and the
    // fallback-path label in the timing record.
    let persona_state = state.storage.get_persona_runtime_state().await.ok();

    // Switch TTS voice when the canon maps the current mood to a variant.
    if let Some(ref persona_state) = persona_state {
        let canon = state.orchestrator.persona_canon();
        let voice = canon.voice_for_mood(&persona_state.current_mood);
        if let Some(ref voice) = voice {
            tracing::debug!(mood = %persona_state.current_mood, voice = %voice, "using mood TTS voice");
        }
        state.tts.set_voice_override(voice);
    }

    let finalize_started = Instant::now();
    let response = state
        .chat_response_finalizer
        .finalize(response, Some(turn_generation))
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let finalize_elapsed = finalize_started.elapsed();
    let total_elapsed = chat_started.elapsed();

    if total_elapsed >= Duration::from_millis(250) {
        tracing::warn!(
            session_id = %response.session_id,
            handle_chat_ms = handle_elapsed.as_millis(),
            finalize_ms = finalize_elapsed.as_millis(),
            total_ms = total_elapsed.as_millis(),
            text_preview = %request_preview,
            "slow /api/chat request"
        );
    } else {
        tracing::debug!(
            session_id = %response.session_id,
            handle_chat_ms = handle_elapsed.as_millis(),
            finalize_ms = finalize_elapsed.as_millis(),
            total_ms = total_elapsed.as_millis(),
            "/api/chat timing"
        );
    }

    // Record timing and push to ring buffer
    let path = persona_state
        .map(|s| s.fallback.last_path)
        .unwrap_or_else(|| "unknown".into());
    let timing = ChatTimingRecord {
        handle_ms: handle_elapsed.as_millis() as u64,
        finalize_ms: finalize_elapsed.as_millis() as u64,
        total_ms: total_elapsed.as_millis() as u64,
        path,
    };
    {
        let mut samples = state.chat_latency_samples.write().await;
        if samples.len() >= 20 {
            samples.pop_front();
        }
        samples.push_back(timing.clone());
    }
    let response = api_types::ChatResponse {
        timing: Some(timing),
        ..response
    };

    // Extract topic from user input and track it
    {
        let topic = extract_topic(&request_preview);
        if let Some(t) = topic {
            let mut topics = state.session_topics.write().await;
            // Avoid duplicates (case-insensitive prefix match)
            let already = topics.iter().any(|existing| {
                existing
                    .to_ascii_lowercase()
                    .contains(&t.to_ascii_lowercase())
            });
            if !already {
                if topics.len() >= 20 {
                    topics.pop_front();
                }
                topics.push_back(t);
            }
        }
    }

    Ok(Json(response))
}

pub(crate) async fn interrupt_session(
    AxumPath(session_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<SessionInterruptResponse>, axum::http::StatusCode> {
    let generation = state.session_turn_guard.interrupt(&session_id).await;
    let cancelled_count = state
        .live2d_speech_queue
        .cancel(Some(&session_id), Some("manual interrupt"))
        .await;

    Ok(Json(SessionInterruptResponse {
        ok: true,
        generation,
        cancelled_count: cancelled_count as u32,
    }))
}

pub(crate) async fn get_session_topics(State(state): State<Arc<AppState>>) -> Json<Vec<String>> {
    let topics = state.session_topics.read().await;
    Json(topics.iter().cloned().collect())
}

fn extract_topic(text: &str) -> Option<String> {
    let trimmed = text.trim();
    // Skip slash commands and very short inputs
    if trimmed.starts_with('/') || trimmed.chars().count() < 3 {
        return None;
    }
    // Extract first 20 chars as topic hint
    let topic: String = trimmed.chars().take(20).collect();
    Some(topic)
}
