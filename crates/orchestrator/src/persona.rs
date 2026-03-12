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

/// Returns a short reaction from the canon if the input looks like a brief
/// acknowledgement, exclamation, or filler — inputs that don't warrant a full
/// LLM round-trip.
///
/// Returns `None` when the input should go through normal generation.
pub fn short_reaction_for(input: &str, reactions: &[String], seed: u64) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() || reactions.is_empty() {
        return None;
    }
    // Only trigger for very short inputs or common ack/filler patterns
    let char_count = trimmed.chars().count();
    let lowered = trimmed.to_ascii_lowercase();
    let is_short_ack = char_count <= 4
        || matches!(
            lowered.as_str(),
            "嗯" | "哦" | "哦哦" | "嗯嗯" | "好" | "好的" | "ok" | "okay" | "hmm" | "hm"
                | "哈" | "哈哈" | "lol" | "哇" | "嗯？" | "哦？" | "啊"
        )
        || (char_count <= 8
            && (trimmed.ends_with('？')
                || trimmed.ends_with('?')
                || trimmed.ends_with('！')
                || trimmed.ends_with('!'))
            && !trimmed.contains(' '));
    if !is_short_ack {
        return None;
    }
    // Deterministic-ish selection based on seed (avoids pulling in rand crate)
    let idx = (seed as usize) % reactions.len();
    Some(reactions[idx].clone())
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
        let reactions = vec!["嗯？".into(), "等一下".into(), "继续".into()];
        // Very short input
        assert!(short_reaction_for("嗯", &reactions, 0).is_some());
        assert!(short_reaction_for("ok", &reactions, 1).is_some());
        assert!(short_reaction_for("哦哦", &reactions, 2).is_some());
        // Short question
        assert!(short_reaction_for("真的?", &reactions, 0).is_some());
        // Normal length input should NOT trigger
        assert!(short_reaction_for("这个问题我想仔细想一想再回答你", &reactions, 0).is_none());
        assert!(short_reaction_for("帮我解释一下这段代码", &reactions, 0).is_none());
    }

    #[test]
    fn short_reaction_returns_none_for_empty_reactions() {
        assert!(short_reaction_for("嗯", &[], 0).is_none());
    }

    #[test]
    fn short_reaction_selects_deterministically() {
        let reactions = vec!["a".into(), "b".into(), "c".into()];
        let r0 = short_reaction_for("嗯", &reactions, 0).unwrap();
        let r1 = short_reaction_for("嗯", &reactions, 1).unwrap();
        assert_ne!(r0, r1);
    }
}
