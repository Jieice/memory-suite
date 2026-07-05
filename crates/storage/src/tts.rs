use anyhow::{Context, Result};
use api_types::TtsRequestRecord;
use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

use crate::Storage;
use crate::util::{parse_datetime, parse_uuid};

#[derive(Debug, Clone)]
pub struct NewTtsRecord {
    pub session_id: String,
    pub text: String,
    pub voice: Option<String>,
}

impl Storage {
    pub async fn enqueue_tts(&self, new_tts: NewTtsRecord) -> Result<TtsRequestRecord> {
        let record = TtsRequestRecord {
            id: Uuid::new_v4(),
            session_id: new_tts.session_id,
            text: new_tts.text,
            voice: new_tts.voice,
            status: "queued".into(),
            adapter_id: None,
            audio_path: None,
            created_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO tts_requests (
                id, session_id, text, voice, status, adapter_id, audio_path, created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
        )
        .bind(record.id.to_string())
        .bind(&record.session_id)
        .bind(&record.text)
        .bind(&record.voice)
        .bind(&record.status)
        .bind(&record.adapter_id)
        .bind(&record.audio_path)
        .bind(record.created_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to enqueue tts")?;

        Ok(record)
    }

    pub async fn get_tts_request(&self, id: Uuid) -> Result<TtsRequestRecord> {
        let row = sqlx::query(
            r#"
            SELECT id, session_id, text, voice, status, adapter_id, audio_path, created_at
            FROM tts_requests
            WHERE id = ?1
            "#,
        )
        .bind(id.to_string())
        .fetch_one(&self.pool)
        .await
        .context("failed to load tts request")?;

        map_tts_row(&row)
    }

    pub async fn update_tts_dispatch(
        &self,
        id: Uuid,
        status: &str,
        adapter_id: Option<&str>,
    ) -> Result<TtsRequestRecord> {
        sqlx::query(
            r#"
            UPDATE tts_requests
            SET status = ?2, adapter_id = ?3
            WHERE id = ?1
            "#,
        )
        .bind(id.to_string())
        .bind(status)
        .bind(adapter_id)
        .execute(&self.pool)
        .await
        .context("failed to update tts dispatch state")?;

        self.get_tts_request(id).await
    }

    pub async fn update_tts_result(
        &self,
        id: Uuid,
        status: &str,
        adapter_id: Option<&str>,
        audio_path: Option<&str>,
    ) -> Result<TtsRequestRecord> {
        sqlx::query(
            r#"
            UPDATE tts_requests
            SET status = ?2, adapter_id = ?3, audio_path = ?4
            WHERE id = ?1
            "#,
        )
        .bind(id.to_string())
        .bind(status)
        .bind(adapter_id)
        .bind(audio_path)
        .execute(&self.pool)
        .await
        .context("failed to update tts result state")?;

        self.get_tts_request(id).await
    }
}

pub(super) fn map_tts_row(row: &sqlx::sqlite::SqliteRow) -> Result<TtsRequestRecord> {
    Ok(TtsRequestRecord {
        id: parse_uuid(row, "id")?,
        session_id: row.get::<String, _>("session_id"),
        text: row.get::<String, _>("text"),
        voice: row.get::<Option<String>, _>("voice"),
        status: row.get::<String, _>("status"),
        adapter_id: row.get::<Option<String>, _>("adapter_id"),
        audio_path: row.get::<Option<String>, _>("audio_path"),
        created_at: parse_datetime(row, "created_at")?,
    })
}
