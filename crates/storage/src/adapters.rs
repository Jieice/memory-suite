use anyhow::{Context, Result};
use api_types::AdapterStatus;
use chrono::{DateTime, Utc};
use sqlx::Row;
use uuid::Uuid;

use crate::Storage;
use crate::util::{parse_datetime, parse_uuid};

#[derive(Debug, Clone)]
pub struct NewAdapterRunRecord {
    pub adapter_id: String,
    pub status: AdapterStatus,
    pub python_executable: String,
    pub args: Vec<String>,
    pub pid: Option<u32>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AdapterRunRecord {
    pub id: Uuid,
    pub adapter_id: String,
    pub status: AdapterStatus,
    pub python_executable: String,
    pub args: Vec<String>,
    pub pid: Option<u32>,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_error: Option<String>,
}

impl Storage {
    pub async fn create_adapter_run(
        &self,
        new_run: NewAdapterRunRecord,
    ) -> Result<AdapterRunRecord> {
        let now = Utc::now();
        let record = AdapterRunRecord {
            id: Uuid::new_v4(),
            adapter_id: new_run.adapter_id,
            status: new_run.status,
            python_executable: new_run.python_executable,
            args: new_run.args,
            pid: new_run.pid,
            started_at: now,
            updated_at: now,
            last_error: new_run.last_error,
        };

        sqlx::query(
            r#"
            INSERT INTO adapter_runs (
                id, adapter_id, status, python_executable, args, pid, started_at, updated_at, last_error
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
        )
        .bind(record.id.to_string())
        .bind(&record.adapter_id)
        .bind(record.status.as_str())
        .bind(&record.python_executable)
        .bind(serde_json::to_string(&record.args).context("failed to serialize adapter args")?)
        .bind(record.pid.map(i64::from))
        .bind(record.started_at.to_rfc3339())
        .bind(record.updated_at.to_rfc3339())
        .bind(&record.last_error)
        .execute(&self.pool)
        .await
        .context("failed to insert adapter run")?;

        Ok(record)
    }

    pub async fn update_adapter_run(
        &self,
        id: Uuid,
        status: AdapterStatus,
        pid: Option<u32>,
        last_error: Option<String>,
    ) -> Result<AdapterRunRecord> {
        let updated_at = Utc::now();
        sqlx::query(
            r#"
            UPDATE adapter_runs
            SET status = ?2, pid = ?3, updated_at = ?4, last_error = ?5
            WHERE id = ?1
            "#,
        )
        .bind(id.to_string())
        .bind(status.as_str())
        .bind(pid.map(i64::from))
        .bind(updated_at.to_rfc3339())
        .bind(&last_error)
        .execute(&self.pool)
        .await
        .context("failed to update adapter run")?;

        self.get_adapter_run(id).await
    }

    pub async fn list_adapter_runs(&self) -> Result<Vec<AdapterRunRecord>> {
        let rows = sqlx::query(
            r#"
            SELECT id, adapter_id, status, python_executable, args, pid, started_at, updated_at, last_error
            FROM adapter_runs
            ORDER BY started_at DESC, rowid DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load adapter runs")?;

        rows.into_iter().map(|row| map_adapter_row(&row)).collect()
    }

    pub async fn get_adapter_run(&self, id: Uuid) -> Result<AdapterRunRecord> {
        let row = sqlx::query(
            r#"
            SELECT id, adapter_id, status, python_executable, args, pid, started_at, updated_at, last_error
            FROM adapter_runs
            WHERE id = ?1
            "#,
        )
        .bind(id.to_string())
        .fetch_one(&self.pool)
        .await
        .context("failed to load adapter run")?;

        map_adapter_row(&row)
    }
}

pub(super) fn map_adapter_row(row: &sqlx::sqlite::SqliteRow) -> Result<AdapterRunRecord> {
    Ok(AdapterRunRecord {
        id: parse_uuid(row, "id")?,
        adapter_id: row.get::<String, _>("adapter_id"),
        status: AdapterStatus::from(row.get::<String, _>("status").as_str()),
        python_executable: row.get::<String, _>("python_executable"),
        args: parse_string_array(row, "args")?,
        pid: row.get::<Option<i64>, _>("pid").map(|value| value as u32),
        started_at: parse_datetime(row, "started_at")?,
        updated_at: parse_datetime(row, "updated_at")?,
        last_error: row.get::<Option<String>, _>("last_error"),
    })
}

pub(super) fn parse_string_array(
    row: &sqlx::sqlite::SqliteRow,
    column: &str,
) -> Result<Vec<String>> {
    let raw = row.get::<String, _>(column);
    serde_json::from_str(&raw).with_context(|| format!("invalid string array in column {column}"))
}
