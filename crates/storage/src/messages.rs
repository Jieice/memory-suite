use anyhow::{Context, Result};
use api_types::{MessageRole, StoredMessage};
use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

use crate::Storage;
use crate::util::{parse_datetime, parse_uuid};

#[derive(Debug, Clone)]
pub struct NewMessageRecord {
    pub session_id: String,
    pub role: MessageRole,
    pub text: String,
}

impl Storage {
    pub async fn append_message(&self, new_message: NewMessageRecord) -> Result<StoredMessage> {
        let record = StoredMessage {
            id: Uuid::new_v4(),
            session_id: new_message.session_id,
            role: new_message.role,
            text: new_message.text,
            created_at: Utc::now(),
        };
        let started = std::time::Instant::now();
        let acquire_started = std::time::Instant::now();
        let mut connection = self
            .pool
            .acquire()
            .await
            .context("failed to acquire sqlite connection for message insert")?;
        let acquire_elapsed = acquire_started.elapsed();
        let execute_started = std::time::Instant::now();

        sqlx::query(
            r#"
            INSERT INTO messages (id, session_id, role, text, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
        )
        .bind(record.id.to_string())
        .bind(&record.session_id)
        .bind(record.role.as_str())
        .bind(&record.text)
        .bind(record.created_at.to_rfc3339())
        .execute(&mut *connection)
        .await
        .context("failed to insert message")?;

        let execute_elapsed = execute_started.elapsed();
        let total_elapsed = started.elapsed();
        if total_elapsed >= std::time::Duration::from_millis(250) {
            tracing::warn!(
                session_id = %record.session_id,
                role = record.role.as_str(),
                acquire_connection_ms = acquire_elapsed.as_millis(),
                execute_insert_ms = execute_elapsed.as_millis(),
                append_message_ms = total_elapsed.as_millis(),
                text_len = record.text.chars().count(),
                "slow storage append_message"
            );
        }

        Ok(record)
    }

    pub async fn list_messages(&self, session_id: &str) -> Result<Vec<StoredMessage>> {
        let rows = sqlx::query(
            r#"
            SELECT id, session_id, role, text, created_at
            FROM messages
            WHERE session_id = ?1
            ORDER BY created_at ASC, rowid ASC
            "#,
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await
        .context("failed to load session messages")?;

        rows.into_iter()
            .map(|row| {
                Ok(StoredMessage {
                    id: parse_uuid(&row, "id")?,
                    session_id: row.get::<String, _>("session_id"),
                    role: MessageRole::from(row.get::<String, _>("role").as_str()),
                    text: row.get::<String, _>("text"),
                    created_at: parse_datetime(&row, "created_at")?,
                })
            })
            .collect()
    }
}
