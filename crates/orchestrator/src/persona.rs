//! Persona canon parser.
//!
//! Reads `PERSONA_CANON.md` and exposes its sections as a typed struct that
//! the orchestrator can embed into system prompts.

#[derive(Debug, Clone, Default)]
pub struct PersonaCanon {
    pub core_identity: Vec<String>,
    pub voice: Vec<String>,
    pub attitude: Vec<String>,
    pub relationship_rules: Vec<String>,
    pub short_reactions: Vec<String>,
    pub short_reactions_surprise: Vec<String>,
    pub short_reactions_hesitation: Vec<String>,
    pub short_reactions_amused: Vec<String>,
    pub short_reactions_teasing: Vec<String>,
    pub short_reactions_transition: Vec<String>,
    pub idle_presence: Vec<String>,
    pub forbidden_drift: Vec<String>,
    pub opening_lines: Vec<String>,
    pub closing_lines: Vec<String>,
    /// Named segments: each entry is "name: description"
    pub segments: Vec<String>,
    pub catchphrases: Vec<String>,
    pub growth_log: Vec<String>,
    pub background: Vec<String>,
    pub preferences: Vec<String>,
    pub quirks: Vec<String>,
    /// Voice variants: each entry is "mood: voice_name (description)"
    pub voice_variants: Vec<String>,
}

impl PersonaCanon {
    /// Parse a markdown string with the required `## Section` headings.
    /// Returns an error if any required section is missing.
    pub fn parse(src: &str) -> Result<Self, String> {
        let required = [
            "Core Identity",
            "Voice",
            "Attitude",
            "Relationship Rules",
            "Short Reactions",
            "Idle Presence",
            "Forbidden Drift",
        ];

        let mut canon = PersonaCanon::default();
        let mut current: Option<&str> = None;
        let mut found: std::collections::HashSet<String> = std::collections::HashSet::new();

        for line in src.lines() {
            let trimmed = line.trim();

            // Skip HTML comments
            if trimmed.starts_with("<!--") {
                continue;
            }

            if let Some(heading) = trimmed.strip_prefix("## ") {
                // Required sections
                if required.iter().any(|r| *r == heading) {
                    current = required.iter().find(|&&r| r == heading).copied();
                    if let Some(h) = current {
                        found.insert(h.to_string());
                    }
                } else {
                    // Optional sections
                    current = match heading {
                        "Opening Lines" => Some("Opening Lines"),
                        "Closing Lines" => Some("Closing Lines"),
                        "Segments" => Some("Segments"),
                        "Catchphrases" => Some("Catchphrases"),
                        "Growth Log" => Some("Growth Log"),
                        "Background" => Some("Background"),
                        "Preferences" => Some("Preferences"),
                        "Quirks" => Some("Quirks"),
                        "Voice Variants" => Some("Voice Variants"),
                        "Short Reactions: Surprise" => Some("Short Reactions: Surprise"),
                        "Short Reactions: Hesitation" => Some("Short Reactions: Hesitation"),
                        "Short Reactions: Amused" => Some("Short Reactions: Amused"),
                        "Short Reactions: Teasing" => Some("Short Reactions: Teasing"),
                        "Short Reactions: Transition" => Some("Short Reactions: Transition"),
                        _ => None,
                    };
                }
                continue;
            }

            if let Some(section) = current {
                if let Some(item) = trimmed.strip_prefix("- ") {
                    let item = item
                        .trim_matches('"')
                        .trim()
                        .to_string();
                    if item.is_empty() {
                        continue;
                    }
                    match section {
                        "Core Identity" => canon.core_identity.push(item),
                        "Voice" => canon.voice.push(item),
                        "Attitude" => canon.attitude.push(item),
                        "Relationship Rules" => canon.relationship_rules.push(item),
                        "Short Reactions" => canon.short_reactions.push(item),
                        "Short Reactions: Surprise" => canon.short_reactions_surprise.push(item),
                        "Short Reactions: Hesitation" => canon.short_reactions_hesitation.push(item),
                        "Short Reactions: Amused" => canon.short_reactions_amused.push(item),
                        "Short Reactions: Teasing" => canon.short_reactions_teasing.push(item),
                        "Short Reactions: Transition" => canon.short_reactions_transition.push(item),
                        "Idle Presence" => canon.idle_presence.push(item),
                        "Forbidden Drift" => canon.forbidden_drift.push(item),
                        "Opening Lines" => canon.opening_lines.push(item),
                        "Closing Lines" => canon.closing_lines.push(item),
                        "Segments" => canon.segments.push(item),
                        "Catchphrases" => canon.catchphrases.push(item),
                        "Growth Log" => canon.growth_log.push(item),
                        "Background" => canon.background.push(item),
                        "Preferences" => canon.preferences.push(item),
                        "Quirks" => canon.quirks.push(item),
                        "Voice Variants" => canon.voice_variants.push(item),
                        _ => {}
                    }
                }
            }
        }

        for section in &required {
            if !found.contains(*section) {
                return Err(format!("PERSONA_CANON.md is missing required section: ## {section}"));
            }
        }

        Ok(canon)
    }

    /// Return the TTS voice name for a given mood, if configured in Voice Variants.
    pub fn voice_for_mood(&self, mood: &str) -> Option<String> {
        for variant in &self.voice_variants {
            if let Some((key, rest)) = variant.split_once(':') {
                if key.trim() == mood {
                    // Extract voice name (first word after colon, before space)
                    let voice = rest.trim().split_whitespace().next()?.to_string();
                    return Some(voice);
                }
            }
        }
        None
    }

    /// Render a compact persona block for inclusion in a system prompt.
    pub fn render_prompt_block(&self, tone_profile: &str) -> String {
        let mut out = String::new();
        out.push_str("=== Persona core ===\n");
        for line in &self.core_identity {
            out.push_str(&format!("- {line}\n"));
        }
        out.push_str(&format!("Tone profile: {tone_profile}\n"));
        out.push_str("\n=== Voice ===\n");
        for line in &self.voice {
            out.push_str(&format!("- {line}\n"));
        }
        out.push_str("\n=== Forbidden drift ===\n");
        for line in &self.forbidden_drift {
            out.push_str(&format!("- {line}\n"));
        }
        if !self.short_reactions.is_empty() {
            out.push_str("\n=== Short reactions (use freely) ===\n");
            let samples: Vec<_> = self.short_reactions.iter().take(5).collect();
            for s in samples {
                out.push_str(&format!("- {s}\n"));
            }
        }
        if !self.preferences.is_empty() {
            out.push_str("\n=== Preferences (background color) ===\n");
            for p in self.preferences.iter().take(4) {
                out.push_str(&format!("- {p}\n"));
            }
        }
        if !self.quirks.is_empty() {
            out.push_str("\n=== Quirks ===\n");
            for q in self.quirks.iter().take(3) {
                out.push_str(&format!("- {q}\n"));
            }
        }
        out
    }
}

/// 短反应触发类别
#[derive(Debug, Clone, PartialEq)]
pub enum ReactionCategory {
    Surprise,
    Hesitation,
    Amused,
    Teasing,
    Transition,
    General,
}

/// 根据输入文本判断短反应类别。返回 None 表示不触发短反应。
pub fn classify_short_reaction(input: &str) -> Option<ReactionCategory> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let char_count = trimmed.chars().count();
    let lowered = trimmed.to_ascii_lowercase();

    // 超过20字的输入不走短反应路径
    if char_count > 20 {
        return None;
    }

    // 吐槽/质疑信号（优先于惊讶，避免"真的吗"被误判）
    let teasing_signals = ["真的吗", "确定", "你确定", "这样吗", "是吗", "蛤"];
    if teasing_signals.iter().any(|s| lowered.contains(s)) {
        return Some(ReactionCategory::Teasing);
    }

    // 惊讶信号：感叹、意外词
    let surprise_signals = ["真的", "假的", "不会吧", "啊", "哇", "卧槽", "woc", "seriously", "what", "！", "!"];
    if surprise_signals.iter().any(|s| lowered.contains(s)) && char_count <= 10 {
        return Some(ReactionCategory::Surprise);
    }

    // 犹豫信号（优先于通用 ack，避免"好像"被漏掉）
    let hesitation_signals = ["怎么说", "不确定", "好像", "应该", "可能", "也许", "说不好"];
    if hesitation_signals.iter().any(|s| lowered.contains(s)) {
        return Some(ReactionCategory::Hesitation);
    }

    // 开心/好玩信号（优先于通用 ack，避免"哈哈"走 General）
    let amused_signals = ["哈哈", "lol", "haha", "好玩", "有趣", "有意思", "666", "妙"];
    if amused_signals.iter().any(|s| lowered.contains(s)) && char_count <= 12 {
        return Some(ReactionCategory::Amused);
    }

    // 通用短 ack / filler（≤2字 或 白名单）
    let is_short_ack = char_count <= 2
        || matches!(
            lowered.as_str(),
            "嗯" | "哦" | "哦哦" | "嗯嗯" | "好" | "好的" | "ok" | "okay" | "hmm" | "hm"
                | "哈" | "嗯？" | "哦？" | "继续" | "然后" | "接着" | "好吧"
        );
    if is_short_ack {
        return Some(ReactionCategory::General);
    }

    // 短问句（≤10字，以问号结尾，无空格分隔的长句）
    if char_count <= 10
        && (trimmed.ends_with('？') || trimmed.ends_with('?'))
        && !trimmed.contains(' ')
    {
        return Some(ReactionCategory::General);
    }

    None
}

/// Returns a short reaction from the canon if the input looks like a brief
/// acknowledgement, exclamation, or filler — inputs that don't warrant a full
/// LLM round-trip.
///
/// `on_cooldown`: caller passes true if a short reaction was used recently.
/// Returns `None` when the input should go through normal generation.
pub fn short_reaction_for(input: &str, canon: &PersonaCanon, seed: u64, on_cooldown: bool) -> Option<String> {
    if on_cooldown {
        return None;
    }
    let category = classify_short_reaction(input)?;
    let pool: Vec<&String> = match category {
        ReactionCategory::Surprise if !canon.short_reactions_surprise.is_empty() =>
            canon.short_reactions_surprise.iter().collect(),
        ReactionCategory::Hesitation if !canon.short_reactions_hesitation.is_empty() =>
            canon.short_reactions_hesitation.iter().collect(),
        ReactionCategory::Amused if !canon.short_reactions_amused.is_empty() =>
            canon.short_reactions_amused.iter().collect(),
        ReactionCategory::Teasing if !canon.short_reactions_teasing.is_empty() =>
            canon.short_reactions_teasing.iter().collect(),
        ReactionCategory::Transition if !canon.short_reactions_transition.is_empty() =>
            canon.short_reactions_transition.iter().collect(),
        _ => canon.short_reactions.iter().collect(),
    };
    if pool.is_empty() {
        return None;
    }
    let idx = (seed as usize) % pool.len();
    Some(pool[idx].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_persona_canon_sections() {
        let parsed = PersonaCanon::parse(
            r#"
# Persona Canon

## Core Identity
- sharp

## Voice
- concise

## Attitude
- teasing

## Relationship Rules
- creator > trusted

## Short Reactions
- "hmm"

## Idle Presence
- "still here"

## Forbidden Drift
- no generic assistant tone
"#,
        )
        .unwrap();

        assert!(parsed.core_identity.iter().any(|s| s.contains("sharp")));
        assert!(parsed
            .forbidden_drift
            .iter()
            .any(|s| s.contains("generic assistant")));
    }

    #[test]
    fn rejects_missing_section() {
        let result = PersonaCanon::parse(
            r#"
## Core Identity
- sharp
"#,
        );
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("Voice"), "error should name the missing section");
    }

    #[test]
    fn parses_actual_canon_file() {
        let src = include_str!("../../../data/memories/global/PERSONA_CANON.md");
        let canon = PersonaCanon::parse(src).expect("PERSONA_CANON.md should parse without errors");
        assert!(!canon.core_identity.is_empty());
        assert!(!canon.forbidden_drift.is_empty());
    }

    #[test]
    fn render_prompt_block_contains_required_markers() {
        let src = include_str!("../../../data/memories/global/PERSONA_CANON.md");
        let canon = PersonaCanon::parse(src).unwrap();
        let block = canon.render_prompt_block("sharp-playful");
        assert!(block.contains("Persona core"));
        assert!(block.contains("Forbidden drift"));
        assert!(block.contains("sharp-playful"));
    }

    #[test]
    fn short_reaction_triggers_for_ack_inputs() {
        let canon = PersonaCanon {
            short_reactions: vec!["嗯？".into(), "等一下".into(), "继续".into()],
            ..Default::default()
        };
        // 极短输入
        assert!(short_reaction_for("嗯", &canon, 0, false).is_some());
        assert!(short_reaction_for("ok", &canon, 1, false).is_some());
        assert!(short_reaction_for("哦哦", &canon, 2, false).is_some());
        // 短问句
        assert!(short_reaction_for("真的?", &canon, 0, false).is_some());
        // 超长输入不触发
        assert!(short_reaction_for("这个问题我想仔细想一想再回答你", &canon, 0, false).is_none());
        assert!(short_reaction_for("帮我解释一下这段代码", &canon, 0, false).is_none());
    }

    #[test]
    fn short_reaction_returns_none_on_cooldown() {
        let canon = PersonaCanon {
            short_reactions: vec!["嗯？".into()],
            ..Default::default()
        };
        assert!(short_reaction_for("嗯", &canon, 0, true).is_none());
    }

    #[test]
    fn short_reaction_returns_none_for_empty_reactions() {
        let canon = PersonaCanon::default();
        assert!(short_reaction_for("嗯", &canon, 0, false).is_none());
    }

    #[test]
    fn short_reaction_selects_deterministically() {
        let canon = PersonaCanon {
            short_reactions: vec!["a".into(), "b".into(), "c".into()],
            ..Default::default()
        };
        let r0 = short_reaction_for("嗯", &canon, 0, false).unwrap();
        let r1 = short_reaction_for("嗯", &canon, 1, false).unwrap();
        assert_ne!(r0, r1);
    }

    #[test]
    fn classify_surprise_inputs() {
        assert_eq!(classify_short_reaction("真的假的"), Some(ReactionCategory::Surprise));
        assert_eq!(classify_short_reaction("哇"), Some(ReactionCategory::Surprise));
    }

    #[test]
    fn classify_hesitation_inputs() {
        assert_eq!(classify_short_reaction("好像是"), Some(ReactionCategory::Hesitation));
        assert_eq!(classify_short_reaction("可能吧"), Some(ReactionCategory::Hesitation));
    }

    #[test]
    fn classify_amused_inputs() {
        assert_eq!(classify_short_reaction("哈哈"), Some(ReactionCategory::Amused));
        assert_eq!(classify_short_reaction("666"), Some(ReactionCategory::Amused));
    }

    #[test]
    fn classify_teasing_inputs() {
        assert_eq!(classify_short_reaction("你确定"), Some(ReactionCategory::Teasing));
        assert_eq!(classify_short_reaction("真的吗"), Some(ReactionCategory::Teasing));
    }

    #[test]
    fn short_reaction_uses_category_pool_when_available() {
        let canon = PersonaCanon {
            short_reactions: vec!["通用".into()],
            short_reactions_surprise: vec!["惊讶专用".into()],
            ..Default::default()
        };
        // 惊讶输入应选惊讶池
        let r = short_reaction_for("真的假的", &canon, 0, false).unwrap();
        assert_eq!(r, "惊讶专用");
        // 通用输入选通用池
        let r2 = short_reaction_for("嗯", &canon, 0, false).unwrap();
        assert_eq!(r2, "通用");
    }

    #[test]
    fn parses_categorized_short_reactions_from_canon_file() {
        let src = include_str!("../../../data/memories/global/PERSONA_CANON.md");
        let canon = PersonaCanon::parse(src).expect("PERSONA_CANON.md should parse");
        assert!(!canon.short_reactions.is_empty(), "base short reactions should be present");
        assert!(!canon.short_reactions_surprise.is_empty(), "surprise reactions should be present");
        assert!(!canon.short_reactions_hesitation.is_empty(), "hesitation reactions should be present");
        assert!(!canon.short_reactions_amused.is_empty(), "amused reactions should be present");
        assert!(!canon.short_reactions_teasing.is_empty(), "teasing reactions should be present");
        assert!(!canon.short_reactions_transition.is_empty(), "transition reactions should be present");
    }
}
