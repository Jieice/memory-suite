use anyhow::{Context, Result};
use api_types::UserRelationshipRecord;
use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::Storage;

impl Storage {
    /// Get or create a relationship record for a user.
    pub async fn get_user_relationship(&self, user_id: &str) -> Result<UserRelationshipRecord> {
        sqlx::query(
            r#"INSERT OR IGNORE INTO user_relationships (user_id, relationship_type, warmth_level, interaction_count, last_seen)
            VALUES (?1, 'unknown', 0.5, 0, NULL)"#,
        )
        .bind(user_id)
        .execute(&self.pool)
        .await
        .context("failed to ensure user relationship row")?;

        let row = sqlx::query(
            "SELECT user_id, relationship_type, warmth_level, interaction_count, last_seen FROM user_relationships WHERE user_id = ?1",
        )
        .bind(user_id)
        .fetch_one(&self.pool)
        .await
        .context("failed to load user relationship")?;

        let last_seen = row
            .get::<Option<String>, _>("last_seen")
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|dt| dt.with_timezone(&Utc));

        Ok(UserRelationshipRecord {
            user_id: row.get::<String, _>("user_id"),
            relationship_type: row.get::<String, _>("relationship_type"),
            warmth_level: row.get::<f64, _>("warmth_level") as f32,
            interaction_count: row.get::<i64, _>("interaction_count").max(0) as u32,
            last_seen,
        })
    }

    /// Upsert a user relationship (e.g. to set creator status).
    pub async fn upsert_user_relationship(
        &self,
        user_id: &str,
        relationship_type: &str,
        warmth_level: f32,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO user_relationships (user_id, relationship_type, warmth_level, interaction_count, last_seen)
            VALUES (?1, ?2, ?3, 0, ?4)
            ON CONFLICT(user_id) DO UPDATE SET
                relationship_type = excluded.relationship_type,
                warmth_level = excluded.warmth_level,
                last_seen = excluded.last_seen
            "#,
        )
        .bind(user_id)
        .bind(relationship_type)
        .bind(warmth_level as f64)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to upsert user relationship")?;
        Ok(())
    }

    /// Bump interaction count and update last_seen for a user.
    pub async fn bump_user_interaction(&self, user_id: &str) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO user_relationships (user_id, relationship_type, warmth_level, interaction_count, last_seen)
            VALUES (?1, 'unknown', 0.5, 1, ?2)
            ON CONFLICT(user_id) DO UPDATE SET
                interaction_count = interaction_count + 1,
                last_seen = ?2"#,
        )
        .bind(user_id)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to bump user interaction")?;
        Ok(())
    }
}
