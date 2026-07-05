use anyhow::{Context, Result};
use api_types::UserProfileRecord;
use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::Storage;
use crate::util::parse_optional_datetime;

#[derive(Debug, Clone)]
pub struct NewUserProfileRecord {
    pub user_id: String,
    pub preferred_name: Option<String>,
    pub interaction_count: i64,
    pub updated_at: Option<DateTime<Utc>>,
}

impl Storage {
    pub async fn upsert_user_profile(
        &self,
        profile: NewUserProfileRecord,
    ) -> Result<UserProfileRecord> {
        let record = UserProfileRecord {
            user_id: profile.user_id,
            preferred_name: profile.preferred_name,
            interaction_count: profile.interaction_count,
            updated_at: profile.updated_at,
        };

        let updated_at = record.updated_at.map(|value| value.to_rfc3339());
        sqlx::query(
            r#"
            INSERT INTO user_profiles (user_id, preferred_name, interaction_count, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(user_id) DO UPDATE SET
                preferred_name = excluded.preferred_name,
                interaction_count = excluded.interaction_count,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&record.user_id)
        .bind(&record.preferred_name)
        .bind(record.interaction_count)
        .bind(updated_at)
        .execute(&self.pool)
        .await
        .context("failed to upsert user profile")?;

        Ok(record)
    }

    pub async fn list_user_profiles(
        &self,
        query: Option<&str>,
        limit: u32,
    ) -> Result<Vec<UserProfileRecord>> {
        let like = query.map(|value| format!("%{}%", value.trim()));
        let rows = if let Some(like) = like {
            sqlx::query(
                r#"
                SELECT user_id, preferred_name, interaction_count, updated_at
                FROM user_profiles
                WHERE user_id LIKE ?1 OR COALESCE(preferred_name, '') LIKE ?1
                ORDER BY updated_at DESC, interaction_count DESC, user_id ASC
                LIMIT ?2
                "#,
            )
            .bind(like)
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await
            .context("failed to load filtered user profiles")?
        } else {
            sqlx::query(
                r#"
                SELECT user_id, preferred_name, interaction_count, updated_at
                FROM user_profiles
                ORDER BY updated_at DESC, interaction_count DESC, user_id ASC
                LIMIT ?1
                "#,
            )
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await
            .context("failed to load user profiles")?
        };

        rows.into_iter()
            .map(|row| {
                Ok(UserProfileRecord {
                    user_id: row.get::<String, _>("user_id"),
                    preferred_name: row.get::<Option<String>, _>("preferred_name"),
                    interaction_count: row.get::<i64, _>("interaction_count"),
                    updated_at: parse_optional_datetime(&row, "updated_at")?,
                })
            })
            .collect()
    }
}
