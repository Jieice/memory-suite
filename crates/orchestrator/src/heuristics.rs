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

/// Deep-question markers that justify paying the cloud tier's extra latency for
/// a higher-quality answer.
const DEEP_QUESTION_KEYWORDS: &[&str] = &[
    "为什么",
    "怎么做",
    "如何",
    "原理",
    "区别",
    "解释",
    "分析",
    "详细",
    "深入",
    "评价",
    "对比",
    "怎么看",
    "什么意思",
    "why",
    "how do",
    "how to",
    "explain",
    "analyze",
    "analyse",
    "difference",
    "compare",
];

/// Explicit requests for a careful/serious answer.
const SERIOUS_REQUEST_KEYWORDS: &[&str] = &["认真", "仔细", "详细讲", "好好", "seriously"];

/// Character count above which an input is treated as a substantial question
/// worth routing to the cloud tier.
const LONG_INPUT_CHARS: usize = 40;
/// Character count above which a question-mark-bearing input counts as a
/// "long question" even if it is under [`LONG_INPUT_CHARS`].
const LONG_QUESTION_CHARS: usize = 20;

/// Decides whether a turn should route to the higher-quality cloud tier instead
/// of the fast local model. Only meaningful when a cloud tier is configured;
/// the caller is responsible for that check.
///
/// A turn routes to the cloud when any of these hold (see hybrid-routing design):
/// - contains a deep-question keyword (why/how/原理/区别/…)
/// - explicitly asks for a serious/careful answer (认真/仔细/…)
/// - is a long input (> [`LONG_INPUT_CHARS`] characters)
/// - is a long question (contains `?`/`？` and > [`LONG_QUESTION_CHARS`] chars)
///
/// Otherwise it stays local for lowest latency (the common case for live chat).
pub(crate) fn route_to_cloud(request: &ChatRequest) -> bool {
    let text = request.text.trim();
    if text.is_empty() {
        return false;
    }
    // Character count (not byte length) so CJK inputs are measured fairly.
    let char_count = text.chars().count();
    if char_count > LONG_INPUT_CHARS {
        return true;
    }

    let lowered = text.to_ascii_lowercase();
    if DEEP_QUESTION_KEYWORDS
        .iter()
        .any(|kw| lowered.contains(kw))
    {
        return true;
    }
    if SERIOUS_REQUEST_KEYWORDS.iter().any(|kw| lowered.contains(kw)) {
        return true;
    }

    let has_question_mark = text.contains('?') || text.contains('？');
    if has_question_mark && char_count > LONG_QUESTION_CHARS {
        return true;
    }

    false
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
            "Commands: /status, /memory, /help. For normal chat, send your goal directly.".into(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn req(text: &str) -> ChatRequest {
        ChatRequest {
            session_id: None,
            user_id: None,
            text: text.into(),
        }
    }

    #[test]
    fn short_chit_chat_stays_local() {
        assert!(!route_to_cloud(&req("你好呀")));
        assert!(!route_to_cloud(&req("哈哈哈笑死")));
        assert!(!route_to_cloud(&req("在吗")));
        assert!(!route_to_cloud(&req("")));
    }

    #[test]
    fn deep_question_keywords_route_to_cloud() {
        assert!(route_to_cloud(&req("为什么天是蓝的")));
        assert!(route_to_cloud(&req("解释一下这个")));
        assert!(route_to_cloud(&req("这两个有什么区别")));
        assert!(route_to_cloud(&req("why is the sky blue")));
        assert!(route_to_cloud(&req("can you explain this")));
    }

    #[test]
    fn serious_request_routes_to_cloud() {
        assert!(route_to_cloud(&req("认真回答我")));
        assert!(route_to_cloud(&req("请仔细讲讲")));
    }

    #[test]
    fn long_input_routes_to_cloud() {
        // 41 CJK chars — over LONG_INPUT_CHARS (40).
        let long = "一".repeat(41);
        assert!(route_to_cloud(&req(&long)));
        // 40 chars exactly — not over the threshold, no other trigger.
        let boundary = "啊".repeat(40);
        assert!(!route_to_cloud(&req(&boundary)));
    }

    #[test]
    fn long_question_routes_to_cloud() {
        // >20 chars with a question mark, but under the 40-char long-input bar.
        let q = format!("{}？", "想问一下这个事情大概是".repeat(2));
        assert!(q.chars().count() > LONG_QUESTION_CHARS);
        assert!(q.chars().count() <= LONG_INPUT_CHARS);
        assert!(route_to_cloud(&req(&q)));
    }

    #[test]
    fn short_question_stays_local() {
        // A question mark alone is not enough under LONG_QUESTION_CHARS.
        assert!(!route_to_cloud(&req("吃了吗？")));
    }
}
