use anyhow::{Context, Result};
use api_types::{FallbackStatsRecord, PersonaRuntimeStateRecord};
use sqlx::Row;

use crate::Storage;

impl Storage {
    pub async fn upsert_persona_runtime_config(
        &self,
        mode: &str,
        tone_profile: &str,
        warmth: f32,
        sarcasm: f32,
        autonomy: f32,
        current_context: &str,
        current_mood: &str,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO persona_runtime_config (id, mode, tone_profile, warmth, sarcasm, autonomy, current_context, current_mood)
            VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                mode = excluded.mode,
                tone_profile = excluded.tone_profile,
                warmth = excluded.warmth,
                sarcasm = excluded.sarcasm,
                autonomy = excluded.autonomy,
                current_context = excluded.current_context,
                current_mood = excluded.current_mood
            "#,
        )
        .bind(mode)
        .bind(tone_profile)
        .bind(warmth as f64)
        .bind(sarcasm as f64)
        .bind(autonomy as f64)
        .bind(current_context)
        .bind(current_mood)
        .execute(&self.pool)
        .await
        .context("failed to upsert persona runtime config")?;
        Ok(())
    }

    pub async fn get_persona_runtime_state(&self) -> Result<PersonaRuntimeStateRecord> {
        // Ensure a default row exists
        sqlx::query(
            r#"
            INSERT OR IGNORE INTO persona_runtime_config (
                id, mode, tone_profile, warmth, sarcasm, autonomy, current_context, current_mood
            )
            VALUES (1, 'stream', 'balanced', 0.5, 0.5, 0.2, 'idle', 'neutral')
            "#,
        )
        .execute(&self.pool)
        .await
        .context("failed to ensure default persona config")?;

        sqlx::query(
            r#"INSERT OR IGNORE INTO fallback_stats (id, remote_successes, remote_timeouts, builtin_fallbacks, last_path)
            VALUES (1, 0, 0, 0, 'none')"#,
        )
        .execute(&self.pool)
        .await
        .context("failed to ensure default fallback stats")?;

        let config = sqlx::query(
            "SELECT mode, tone_profile, warmth, sarcasm, autonomy, current_context, current_mood FROM persona_runtime_config WHERE id = 1",
        )
        .fetch_one(&self.pool)
        .await
        .context("failed to load persona runtime config")?;

        let stats = sqlx::query(
            "SELECT remote_successes, remote_timeouts, builtin_fallbacks, last_path FROM fallback_stats WHERE id = 1",
        )
        .fetch_one(&self.pool)
        .await
        .context("failed to load fallback stats")?;

        Ok(PersonaRuntimeStateRecord {
            mode: config.get::<String, _>("mode"),
            tone_profile: config.get::<String, _>("tone_profile"),
            warmth: config.get::<f64, _>("warmth") as f32,
            sarcasm: config.get::<f64, _>("sarcasm") as f32,
            autonomy: config.get::<f64, _>("autonomy") as f32,
            current_context: config.get::<String, _>("current_context"),
            current_mood: config.get::<String, _>("current_mood"),
            fallback: FallbackStatsRecord {
                remote_successes: stats.get::<i64, _>("remote_successes").max(0) as u32,
                remote_timeouts: stats.get::<i64, _>("remote_timeouts").max(0) as u32,
                builtin_fallbacks: stats.get::<i64, _>("builtin_fallbacks").max(0) as u32,
                last_path: stats.get::<String, _>("last_path"),
            },
        })
    }

    pub async fn bump_fallback_stat(&self, path: &str) -> Result<()> {
        sqlx::query(
            r#"INSERT OR IGNORE INTO fallback_stats (id, remote_successes, remote_timeouts, builtin_fallbacks, last_path)
            VALUES (1, 0, 0, 0, 'none')"#,
        )
        .execute(&self.pool)
        .await
        .context("failed to ensure fallback stats row")?;

        let column = match path {
            "remote" => "remote_successes",
            "remote_timeout" | "builtin_timeout" => "remote_timeouts",
            _ => "builtin_fallbacks",
        };

        sqlx::query(&format!(
            "UPDATE fallback_stats SET {column} = {column} + 1, last_path = ?1 WHERE id = 1"
        ))
        .bind(path)
        .execute(&self.pool)
        .await
        .context("failed to bump fallback stat")?;
        Ok(())
    }
}
