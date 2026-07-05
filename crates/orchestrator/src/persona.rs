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
                    let item = item.trim_matches('"').trim().to_string();
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
                        "Short Reactions: Hesitation" => {
                            canon.short_reactions_hesitation.push(item)
                        }
                        "Short Reactions: Amused" => canon.short_reactions_amused.push(item),
                        "Short Reactions: Teasing" => canon.short_reactions_teasing.push(item),
                        "Short Reactions: Transition" => {
                            canon.short_reactions_transition.push(item)
                        }
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
                return Err(format!(
                    "PERSONA_CANON.md is missing required section: ## {section}"
                ));
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
        assert!(
            parsed
                .forbidden_drift
                .iter()
                .any(|s| s.contains("generic assistant"))
        );
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
        assert!(
            msg.contains("Voice"),
            "error should name the missing section"
        );
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
    fn parses_categorized_short_reactions_from_canon_file() {
        let src = include_str!("../../../data/memories/global/PERSONA_CANON.md");
        let canon = PersonaCanon::parse(src).expect("PERSONA_CANON.md should parse");
        assert!(
            !canon.short_reactions.is_empty(),
            "base short reactions should be present"
        );
        assert!(
            !canon.short_reactions_surprise.is_empty(),
            "surprise reactions should be present"
        );
        assert!(
            !canon.short_reactions_hesitation.is_empty(),
            "hesitation reactions should be present"
        );
        assert!(
            !canon.short_reactions_amused.is_empty(),
            "amused reactions should be present"
        );
        assert!(
            !canon.short_reactions_teasing.is_empty(),
            "teasing reactions should be present"
        );
        assert!(
            !canon.short_reactions_transition.is_empty(),
            "transition reactions should be present"
        );
    }
}
