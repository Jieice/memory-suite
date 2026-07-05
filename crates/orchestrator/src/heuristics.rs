use api_types::{ChatRequest, MemoryEntryRecord, StoredMessage};
use storage::RuntimeCounts;

use crate::text::summarize_text;


// NOTE: extract_user_fact, infer_mood_shift, compute_persona_consistency_score,
// and detect_user_sentiment were removed. These hardcoded keyword-matching
// heuristics are now handled by the LLM itself via prompt instructions.

pub(crate) fn should_prefer_built_in_response(request: &ChatRequest) -> bool {
    let text = request.text.trim();
    let lowered = text.to_ascii_lowercase();
    matches!(lowered.as_str(), "/help" | "/status" | "/memory")
        || (text.starts_with('/') && !matches!(lowered.as_str(), "/help" | "/status" | "/memory"))
}

pub(crate) fn built_in_response(
    request: &ChatRequest,
    _history: &[StoredMessage],
    memory_entries: &[MemoryEntryRecord],
    runtime_counts: Option<RuntimeCounts>,
    _scene_hint: Option<&str>,
) -> Option<String> {
    let text = request.text.trim();
    if text.is_empty() {
        return None;
    }

    let lowered = text.to_ascii_lowercase();
    if lowered == "/help" || (text.starts_with('/') && lowered != "/status" && lowered != "/memory")
    {
        return Some(
            "Commands: /status, /memory, /help. For normal chat, send your goal directly."
                .into(),
        );
    }
    if lowered == "/status" {
        if let Some(counts) = runtime_counts {
            return Some(format!(
                "runtime ok: messages={}, profiles={}, memories={}, configs={}",
                counts.messages.max(0),
                counts.user_profiles.max(0),
                counts.memory_entries.max(0),
                counts.config_artifacts.max(0)
            ));
        }
        return Some("runtime status is temporarily unavailable, please retry in a moment.".into());
    }
    if lowered == "/memory" {
        if memory_entries.is_empty() {
            return Some("No imported memory was found for this user yet.".into());
        }
        let top = memory_entries
            .iter()
            .take(3)
            .map(|entry| {
                let snippet = memory_payload_spoken_summary(&entry.payload, 120);
                if snippet.is_empty() {
                    entry.entry_type.clone()
                } else {
                    format!("{}: {}", entry.entry_type, snippet)
                }
            })
            .collect::<Vec<_>>()
            .join(" | ");
        return Some(format!("memory snapshot: {top}"));
    }

    None
}

fn memory_payload_spoken_summary(payload: &serde_json::Value, max_chars: usize) -> String {
    let preferred_keys = [
        "moment",
        "summary",
        "fact",
        "reflection",
        "content",
        "text",
        "title",
        "note",
    ];

    for key in preferred_keys {
        if let Some(value) = payload
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return summarize_text(value, max_chars);
        }
    }

    if let Some(value) = payload
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return summarize_text(value, max_chars);
    }

    if let Some(object) = payload.as_object() {
        if let Some(value) = object
            .values()
            .filter_map(serde_json::Value::as_str)
            .map(str::trim)
            .find(|value| !value.is_empty())
        {
            return summarize_text(value, max_chars);
        }
    }

    String::new()
}
