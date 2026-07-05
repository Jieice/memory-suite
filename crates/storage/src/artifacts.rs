use anyhow::{Context, Result};
use api_types::ConfigArtifactRecord;
use chrono::Utc;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::Storage;
use crate::util::{parse_datetime, parse_json, parse_uuid};

#[derive(Debug, Clone)]
pub struct NewConfigArtifactRecord {
    pub path: String,
    pub kind: String,
    pub payload: Value,
    pub copied_to: Option<String>,
}

impl Storage {
    pub async fn import_config_artifact(
        &self,
        artifact: NewConfigArtifactRecord,
    ) -> Result<ConfigArtifactRecord> {
        let record = ConfigArtifactRecord {
            id: Uuid::new_v4(),
            path: artifact.path,
            kind: artifact.kind,
            payload: artifact.payload,
            copied_to: artifact.copied_to,
            created_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO config_artifacts (id, path, kind, payload, copied_to, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
        )
        .bind(record.id.to_string())
        .bind(&record.path)
        .bind(&record.kind)
        .bind(record.payload.to_string())
        .bind(&record.copied_to)
        .bind(record.created_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to import config artifact")?;

        Ok(record)
    }

    pub async fn list_config_artifacts(
        &self,
        query: Option<&str>,
        limit: u32,
    ) -> Result<Vec<ConfigArtifactRecord>> {
        let like = query.map(|value| format!("%{}%", value.trim()));
        let rows = if let Some(like) = like {
            sqlx::query(
                r#"
                SELECT id, path, kind, payload, copied_to, created_at
                FROM config_artifacts
                WHERE path LIKE ?1 OR kind LIKE ?1 OR payload LIKE ?1 OR COALESCE(copied_to, '') LIKE ?1
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?2
                "#,
            )
            .bind(like)
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await
            .context("failed to load filtered config artifacts")?
        } else {
            sqlx::query(
                r#"
                SELECT id, path, kind, payload, copied_to, created_at
                FROM config_artifacts
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?1
                "#,
            )
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await
            .context("failed to load config artifacts")?
        };

        rows.into_iter()
            .map(|row| {
                Ok(ConfigArtifactRecord {
                    id: parse_uuid(&row, "id")?,
                    path: row.get::<String, _>("path"),
                    kind: row.get::<String, _>("kind"),
                    payload: parse_json(&row, "payload")?,
                    copied_to: row.get::<Option<String>, _>("copied_to"),
                    created_at: parse_datetime(&row, "created_at")?,
                })
            })
            .collect()
    }
}
