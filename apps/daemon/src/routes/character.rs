use std::sync::Arc;

use api_types::{
    CharacterThoughtsResponse, ChatRequest, DiaryEntryRecord, DiaryListResponse,
    HighlightReelResponse, RuntimeEvent, ShortContentResponse,
};
use axum::{Json, extract::State, http::StatusCode};

use crate::AppState;

pub(crate) async fn get_character_diary(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DiaryListResponse>, StatusCode> {
    let entries = state
        .storage
        .list_memory_entries(None, 10)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let diary_entries: Vec<DiaryEntryRecord> = entries
        .into_iter()
        .filter(|e| e.entry_type == "diary")
        .map(|e| {
            let content = e
                .payload
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            DiaryEntryRecord {
                id: e.id.to_string(),
                content,
                created_at: e.created_at,
            }
        })
        .collect();

    Ok(Json(DiaryListResponse {
        entries: diary_entries,
    }))
}

pub(crate) async fn generate_diary_entry(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DiaryEntryRecord>, StatusCode> {
    // Get recent session summaries to base the diary on
    let memories = state
        .storage
        .list_memory_entries(None, 5)
        .await
        .unwrap_or_default();

    let summaries: Vec<String> = memories
        .iter()
        .filter(|e| e.entry_type == "session_summary")
        .take(3)
        .map(|e| {
            e.payload
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect();

    let context = if summaries.is_empty() {
        "今天的对话".to_string()
    } else {
        summaries.join(" | ")
    };

    let prompt = format!(
        "根据最近的对话记录，用第一人称写一条2-3句的角色日记。语气要符合忆的性格（敏锐、略有傲娇、直接）。不要用助手腔。参考内容：{}",
        context.chars().take(200).collect::<String>()
    );

    let request = ChatRequest {
        session_id: Some("diary-generation".into()),
        user_id: Some("system".into()),
        text: prompt,
    };

    let response = state
        .orchestrator
        .handle_chat_with_scene(request, None)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let content = response.assistant_text.clone();
    let now = chrono::Utc::now();

    // Store as memory entry
    let _ = state
        .storage
        .import_memory_entry(storage::NewMemoryEntryRecord {
            user_id: "character".into(),
            entry_type: "diary".into(),
            payload: serde_json::json!({ "content": content, "created_at": now.to_rfc3339() }),
            source: "auto_diary".into(),
        })
        .await;

    Ok(Json(DiaryEntryRecord {
        id: uuid::Uuid::new_v4().to_string(),
        content,
        created_at: now,
    }))
}

pub(crate) async fn get_character_thoughts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CharacterThoughtsResponse>, StatusCode> {
    // Gather recent diary entries and session summaries
    let memories = state
        .storage
        .list_memory_entries(None, 8)
        .await
        .unwrap_or_default();

    let diary_bits: Vec<String> = memories
        .iter()
        .filter(|e| e.entry_type == "diary")
        .take(2)
        .map(|e| {
            e.payload
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect();

    let summary_bits: Vec<String> = memories
        .iter()
        .filter(|e| e.entry_type == "session_summary")
        .take(3)
        .map(|e| {
            e.payload
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect();

    let context = [diary_bits, summary_bits].concat().join(" / ");
    let context_trimmed: String = context.chars().take(300).collect();

    let prompt = format!(
        "用第一人称写一段3-5句的角色内心独白或思考片段。语气是忆的风格：敏锐、不废话、偶尔带点自嘲。不要总结，要像在想事情。参考背景：{}",
        if context_trimmed.is_empty() {
            "最近发生了一些对话".to_string()
        } else {
            context_trimmed
        }
    );

    let request = ChatRequest {
        session_id: Some("character-thoughts".into()),
        user_id: Some("system".into()),
        text: prompt,
    };

    let response = state
        .orchestrator
        .handle_chat_with_scene(request, None)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(CharacterThoughtsResponse {
        thoughts: response.assistant_text,
        generated_at: chrono::Utc::now(),
    }))
}

pub(crate) async fn get_character_clips(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<RuntimeEvent>> {
    let clips = state.clip_candidates.read().await;
    Json(clips.iter().cloned().collect())
}

pub(crate) async fn generate_short_content(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ShortContentResponse>, StatusCode> {
    // Base on recent clips and diary for inspiration
    let clips: Vec<String> = {
        let q = state.clip_candidates.read().await;
        q.iter()
            .rev()
            .take(3)
            .filter_map(|e| e.detail.clone())
            .collect()
    };

    let memories = state
        .storage
        .list_memory_entries(None, 5)
        .await
        .unwrap_or_default();
    let diary_bits: Vec<String> = memories
        .iter()
        .filter(|e| e.entry_type == "diary")
        .take(2)
        .map(|e| {
            e.payload
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect();

    let inspiration: String = [clips, diary_bits]
        .concat()
        .join(" / ")
        .chars()
        .take(250)
        .collect();

    let prompt = format!(
        "写一条2-3句的独立短内容，适合发布到社交媒体。风格是忆的语气：直接、有趣、不废话。可以是观察、吐槽、或者一个有趣的想法。不要用引号包裹。参考灵感（可以忽略）：{}",
        if inspiration.is_empty() {
            "随便想一个有趣的观察".to_string()
        } else {
            inspiration
        }
    );

    let request = ChatRequest {
        session_id: Some("short-content".into()),
        user_id: Some("system".into()),
        text: prompt,
    };

    let response = state
        .orchestrator
        .handle_chat_with_scene(request, None)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(ShortContentResponse {
        content: response.assistant_text,
        generated_at: chrono::Utc::now(),
    }))
}

pub(crate) async fn get_character_mood(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let s = state
        .storage
        .get_persona_runtime_state()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "mood": s.current_mood })))
}

pub(crate) async fn set_character_mood(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let mood = body
        .get("mood")
        .and_then(|v| v.as_str())
        .unwrap_or("neutral")
        .to_string();
    let valid = ["neutral", "curious", "amused", "tired", "focused"];
    if !valid.contains(&mood.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let s = state
        .storage
        .get_persona_runtime_state()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    state
        .storage
        .upsert_persona_runtime_config(
            &s.mode,
            &s.tone_profile,
            s.warmth,
            s.sarcasm,
            s.autonomy,
            &s.current_context,
            &mood,
        )
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "mood": mood })))
}

pub(crate) async fn get_character_energy(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let turn = state
        .session_turns
        .load(std::sync::atomic::Ordering::Relaxed);
    let level = match turn {
        0..=10 => "fresh",
        11..=25 => "normal",
        26..=50 => "tired",
        _ => "low",
    };
    Json(serde_json::json!({ "turn": turn, "level": level }))
}

pub(crate) async fn generate_highlight_reel(
    State(state): State<Arc<AppState>>,
) -> Result<Json<HighlightReelResponse>, StatusCode> {
    let topics: Vec<String> = {
        let t = state.session_topics.read().await;
        t.iter().cloned().collect()
    };
    let clip_count = state.clip_candidates.read().await.len() as u32;
    let top_clips: Vec<String> = {
        let q = state.clip_candidates.read().await;
        q.iter()
            .rev()
            .take(3)
            .filter_map(|e| e.detail.clone())
            .collect()
    };

    let topics_str = if topics.is_empty() {
        "各种话题".to_string()
    } else {
        topics
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join("、")
    };
    let clips_str = if top_clips.is_empty() {
        String::new()
    } else {
        format!(
            "精彩片段：{}",
            top_clips
                .iter()
                .map(|c| c.chars().take(40).collect::<String>())
                .collect::<Vec<_>>()
                .join(" / ")
        )
    };

    let prompt = format!(
        "用忆的语气，写一段今天直播的精彩回顾（3-5句）。今天聊了：{}。{}\n格式：先给一个整体评价，再提1-2个具体亮点，最后一句收尾。",
        topics_str, clips_str
    );

    let request = ChatRequest {
        session_id: Some("highlight-reel".into()),
        user_id: Some("system".into()),
        text: prompt,
    };

    let response = state
        .orchestrator
        .handle_chat_with_scene(request, None)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(HighlightReelResponse {
        content: response.assistant_text,
        topics,
        clip_count,
        generated_at: chrono::Utc::now(),
    }))
}
