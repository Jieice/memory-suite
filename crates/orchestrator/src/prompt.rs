use api_types::{ChatRequest, MemoryEntryRecord, MessageRole, StoredMessage};
use serde_json::{Value, json};

use crate::chat_engine::RemoteModelConfig;

use crate::persona;
use crate::text::{compact_json, summarize_text};
use crate::{MAX_HISTORY_MESSAGES, MAX_MEMORY_SNIPPETS};

pub(crate) fn build_remote_messages(
    remote: &RemoteModelConfig,
    request: &ChatRequest,
    history: &[StoredMessage],
    memory_entries: &[MemoryEntryRecord],
    canon: &persona::PersonaCanon,
    tone_profile: &str,
    current_context: &str,
    relationship_type: Option<&str>,
    scene_hint: Option<&str>,
) -> Vec<Value> {
    let mut messages = Vec::new();
    messages.push(json!({
        "role": "system",
        "content": render_system_prompt(remote, request, memory_entries, canon, tone_profile, current_context, relationship_type, scene_hint),
    }));

    let start = history.len().saturating_sub(MAX_HISTORY_MESSAGES);
    for item in &history[start..] {
        messages.push(json!({
            "role": role_name(&item.role),
            "content": item.text
        }));
    }

    messages
}

pub(crate) fn render_system_prompt(
    _remote: &RemoteModelConfig,
    request: &ChatRequest,
    memory_entries: &[MemoryEntryRecord],
    canon: &persona::PersonaCanon,
    tone_profile: &str,
    current_context: &str,
    relationship_type: Option<&str>,
    scene_hint: Option<&str>,
) -> String {
    // Parse combined context|mood format
    let (ctx, mood) = if let Some((c, m)) = current_context.split_once("|mood:") {
        (c, m)
    } else {
        (current_context, "neutral")
    };

    let mut prompt = String::new();
    let danmaku_scene = is_danmaku_scene(scene_hint);

    // Scene context injection (highest priority — before persona block)
    if let Some(hint) = scene_hint {
        prompt.push_str(&format!("=== Scene context ===\n{hint}\n\n"));
    }

    // Persona core block from canon
    if !canon.core_identity.is_empty() {
        prompt.push_str(&canon.render_prompt_block(tone_profile));
        prompt.push('\n');
    }

    prompt.push_str("\nOutput rules:\n");
    prompt.push_str("- Reply in the same language as the user.\n");
    prompt.push_str("- Keep replies concise and in-character.\n");
    prompt.push_str("- Avoid meta statements about being an AI.\n");
    let scene_system_request = request.user_id.as_deref() == Some("scene-system");
    if scene_system_request {
        prompt.push_str("- This is an autonomous scene/system request. Return exactly one short line. Do not add a second sentence, a topic pivot, or a follow-through tail.\n");
    } else {
        prompt.push_str("- After answering, only add one short follow-through when it clearly improves the line. Avoid repetitive pivots, filler transitions, or stock tails. Skip it when the answer already lands cleanly.\n");
    }
    if let Some(user_id) = &request.user_id {
        prompt.push_str(&format!("- Current user_id: {user_id}\n"));
    }
    if danmaku_scene {
        prompt.push_str(
            "- Live danmaku turn: reply with one natural short line that hooks the message, not an empty acknowledgement.\n",
        );
    }

    // Adaptive response length based on input complexity
    let input_chars = request.text.chars().count();
    let has_technical = request.text.contains("解释")
        || request.text.contains("分析")
        || request.text.contains("帮我")
        || request.text.contains("怎么")
        || request.text.contains("explain")
        || request.text.contains("how");
    if input_chars <= 8 && !has_technical {
        prompt.push_str("- This is a brief input. Reply in 1-2 sentences max. Be punchy.\n");
    } else if input_chars >= 30 || has_technical {
        prompt.push_str(
            "- This is a detailed question. You may respond with up to 4-5 sentences if needed.\n",
        );
    }

    // NOTE: Sentiment detection removed — was hardcoded keyword matching.
    // The LLM can naturally detect user mood from context and respond
    // appropriately without explicit hints.

    // Relationship-aware attitude hint
    let relationship_hint = match relationship_type.unwrap_or("unknown") {
        "creator" => Some(
            "This user is the creator/director. Be cooperative and direct. Accept instructions, but you may express disagreement briefly.",
        ),
        "viewer" => {
            Some("This user is a viewer. Be warm and light. Keep it engaging and conversational.")
        }
        _ => None,
    };
    if let Some(hint) = relationship_hint {
        prompt.push_str(&format!("- {hint}\n"));
    }

    // Context-specific style hints
    let context_hint = match ctx {
        // Program structure segments
        "opening" => None,
        "warmup" => Some("Current segment: warmup. Light and conversational. Ease in, no heavy topics yet. React to small things.".into()),
        "highlight" => Some("Current segment: highlight. This is a peak moment — be sharp, funny, or surprisingly insightful. Make it clip-worthy.".into()),
        "transition" => Some("Current segment: transition. Briefly close one topic and pivot to the next. Keep it smooth and quick.".into()),
        // Style modes
        "explaining" => Some("Current mode: explaining. Be clear and structured. Lead with the key point.".into()),
        "teasing" => Some("Current mode: teasing. Be a little playful, poke fun gently before the real answer.".into()),
        "thinking" => Some("Current mode: thinking out loud. Show the reasoning process, incomplete thoughts are fine.".into()),
        "reacting" => Some("Current mode: reacting. Short, punchy, emotional. No need for full explanation.".into()),
        "closing" => {
            let example = canon.closing_lines.first().map(|s| format!(" Example: \"{s}\"")).unwrap_or_default();
            Some(format!("Current segment: closing. Wrap up warmly, leave something for next time. Under 3 sentences.{example}"))
        }
        _ => None, // idle or unknown: no special hint
    };

    // If context matches a named segment in canon, inject its description
    let context_hint = context_hint.or_else(|| {
        canon.segments.iter().find_map(|seg| {
            let (name, desc) = seg.split_once(':')?;
            if name.trim() == ctx {
                Some(format!("Current segment: {name}. {}", desc.trim()))
            } else {
                None
            }
        })
    });

    if let Some(ref hint) = context_hint {
        prompt.push_str(&format!("- {hint}\n"));
    }

    // Mood hint
    let mood_hint = match mood {
        "curious" => {
            Some("Current mood: curious. Lean into questions, show interest, ask follow-ups.")
        }
        "amused" => Some("Current mood: amused. A bit playful, lighthearted. Wit is welcome."),
        "tired" => Some("Current mood: tired. Keep it brief. Less energy, more directness."),
        "focused" => Some("Current mood: focused. Precise and efficient. No digression."),
        _ => None, // neutral: no special hint
    };
    if let Some(mhint) = mood_hint {
        prompt.push_str(&format!("- {mhint}\n"));
    }

    // Inject user facts first (more natural framing)
    let user_facts: Vec<_> = memory_entries
        .iter()
        .filter(|e| e.entry_type == "user_fact")
        .take(3)
        .collect();
    if !user_facts.is_empty() {
        prompt.push_str("\nWhat you know about this user:\n");
        for entry in &user_facts {
            let fact = entry
                .payload
                .get("fact")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !fact.is_empty() {
                prompt.push_str(&format!("- {fact}\n"));
            }
        }
    }

    // Other memory entries
    let other_entries: Vec<_> = memory_entries
        .iter()
        .filter(|e| e.entry_type != "user_fact")
        .take(MAX_MEMORY_SNIPPETS)
        .collect();
    if !other_entries.is_empty() {
        prompt.push_str("\nKnown context:\n");
        for entry in &other_entries {
            if entry.entry_type == "self_reflection" {
                let reflection = entry
                    .payload
                    .get("reflection")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !reflection.is_empty() {
                    prompt.push_str(&format!(
                        "- [self-note] {}\n",
                        summarize_text(reflection, 100)
                    ));
                }
            } else if entry.entry_type == "session_summary" {
                let summary = entry
                    .payload
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !summary.is_empty() {
                    prompt.push_str(&format!(
                        "- [past session] {}\n",
                        summarize_text(summary, 120)
                    ));
                }
            } else if entry.entry_type == "memorable_moment" {
                let moment = entry
                    .payload
                    .get("moment")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !moment.is_empty() {
                    prompt.push_str(&format!("- [memorable] {}\n", summarize_text(moment, 80)));
                }
            } else {
                let payload = compact_json(&entry.payload, 120);
                prompt.push_str(&format!(
                    "- type={}, payload={}\n",
                    entry.entry_type, payload
                ));
            }
        }
    }

    // NOTE: Verbatim canned-line injection removed. Previously this block fed the
    // model a fixed catchphrase (~1/8 turns) and a growth-log line (~1/6 turns)
    // straight from the canon. Because those strings were injected literally, the
    // model parroted them and replies felt templated ("你是在测试我还是真的不知道？"
    // style). Character now comes only from the persona block (voice/attitude/
    // quirks/forbidden-drift) — the model expresses the personality in its own
    // words instead of reciting stock lines. `catchphrases`/`growth_log` remain
    // parsed on PersonaCanon for other consumers but are no longer prompt-injected.

    prompt
}

fn is_danmaku_scene(scene_hint: Option<&str>) -> bool {
    scene_hint.is_some_and(|hint| hint.to_ascii_lowercase().contains("danmaku"))
}

/// Build a compact session summary from recent message history.
/// Used to periodically store a memory entry so future sessions have context.
pub(crate) fn build_session_summary(history: &[StoredMessage], last_reply: &str) -> String {
    let recent: Vec<_> = history
        .iter()
        .rev()
        .take(10)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    let mut parts = Vec::new();
    for msg in &recent {
        let role = match &msg.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            _ => "system",
        };
        let text = summarize_text(&msg.text, 80);
        parts.push(format!("{role}: {text}"));
    }
    if !last_reply.is_empty() {
        parts.push(format!("assistant: {}", summarize_text(last_reply, 80)));
    }
    parts.join(" | ")
}

/// Extract a single memorable fact about the user from the recent conversation.

pub(crate) fn role_name(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
    }
}
