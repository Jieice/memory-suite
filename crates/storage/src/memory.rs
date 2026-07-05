use anyhow::{Context, Result};
use api_types::MemoryEntryRecord;
use chrono::Utc;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::Storage;
use crate::util::{parse_datetime, parse_json, parse_uuid};

#[derive(Debug, Clone)]
pub struct NewMemoryEntryRecord {
    pub user_id: String,
    pub entry_type: String,
    pub payload: Value,
    pub source: String,
}

impl Storage {
    pub async fn import_memory_entry(
        &self,
        entry: NewMemoryEntryRecord,
    ) -> Result<MemoryEntryRecord> {
        let record = MemoryEntryRecord {
            id: Uuid::new_v4(),
            user_id: entry.user_id,
            entry_type: entry.entry_type,
            payload: entry.payload,
            source: entry.source,
            created_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO memory_entries (id, user_id, entry_type, payload, source, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
        )
        .bind(record.id.to_string())
        .bind(&record.user_id)
        .bind(&record.entry_type)
        .bind(record.payload.to_string())
        .bind(&record.source)
        .bind(record.created_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to import memory entry")?;

        Ok(record)
    }

    pub async fn list_memory_entries(
        &self,
        query: Option<&str>,
        limit: u32,
    ) -> Result<Vec<MemoryEntryRecord>> {
        let like = query.map(|value| format!("%{}%", value.trim()));
        let rows = if let Some(like) = like {
            sqlx::query(
                r#"
                SELECT id, user_id, entry_type, payload, source, created_at
                FROM memory_entries
                WHERE user_id LIKE ?1 OR entry_type LIKE ?1 OR source LIKE ?1 OR payload LIKE ?1
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?2
                "#,
            )
            .bind(like)
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await
            .context("failed to load filtered memory entries")?
        } else {
            sqlx::query(
                r#"
                SELECT id, user_id, entry_type, payload, source, created_at
                FROM memory_entries
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?1
                "#,
            )
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await
            .context("failed to load memory entries")?
        };

        rows.into_iter()
            .map(|row| {
                Ok(MemoryEntryRecord {
                    id: parse_uuid(&row, "id")?,
                    user_id: row.get::<String, _>("user_id"),
                    entry_type: row.get::<String, _>("entry_type"),
                    payload: parse_json(&row, "payload")?,
                    source: row.get::<String, _>("source"),
                    created_at: parse_datetime(&row, "created_at")?,
                })
            })
            .collect()
    }
}
