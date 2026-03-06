use std::path::Path;

use anyhow::{Context, Result};
use api_types::{
    AdapterRecord, AdapterStatus, ConfigArtifactRecord, JobKind, JobRecord, LegacyEventRecord,
    MemoryEntryRecord, MessageRole, StoredMessage, TtsRequestRecord, UserProfileRecord,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct Storage {
    pool: SqlitePool,
}

#[derive(Debug, Clone)]
pub struct NewMessageRecord {
    pub session_id: String,
    pub role: MessageRole,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct NewJobRecord {
    pub kind: JobKind,
    pub input: Option<String>,
    pub profile: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewTtsRecord {
    pub session_id: String,
    pub text: String,
    pub voice: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewUserProfileRecord {
    pub user_id: String,
    pub preferred_name: Option<String>,
    pub interaction_count: i64,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct NewMemoryEntryRecord {
    pub user_id: String,
    pub entry_type: String,
    pub payload: Value,
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct NewLegacyEventRecord {
    pub source_path: String,
    pub source_type: String,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct NewConfigArtifactRecord {
    pub path: String,
    pub kind: String,
    pub payload: Value,
    pub copied_to: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewAdapterRunRecord {
    pub adapter_id: String,
    pub status: AdapterStatus,
    pub python_executable: String,
    pub args: Vec<String>,
    pub pid: Option<u32>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportCounts {
    pub user_profiles: i64,
    pub memory_entries: i64,
    pub legacy_events: i64,
    pub config_artifacts: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeCounts {
    pub messages: i64,
    pub jobs: i64,
    pub user_profiles: i64,
    pub memory_entries: i64,
    pub legacy_events: i64,
    pub config_artifacts: i64,
}

impl Storage {
    pub async fn connect(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("failed to create runtime directory {}", parent.display()))?;
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .with_context(|| format!("failed to open sqlite database at {}", path.display()))?;

        let storage = Self { pool };
        storage.initialize_schema().await?;
        Ok(storage)
    }

    pub async fn health_check(&self) -> Result<bool> {
        let value: i64 = sqlx::query_scalar("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .context("health check query failed")?;
        Ok(value == 1)
    }

    pub async fn append_message(&self, new_message: NewMessageRecord) -> Result<StoredMessage> {
        let record = StoredMessage {
            id: Uuid::new_v4(),
            session_id: new_message.session_id,
            role: new_message.role,
            text: new_message.text,
            created_at: Utc::now(),
        };

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
        .execute(&self.pool)
        .await
        .context("failed to insert message")?;

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

    pub async fn create_job(&self, new_job: NewJobRecord) -> Result<JobRecord> {
        let record = JobRecord {
            id: Uuid::new_v4(),
            kind: new_job.kind,
            status: "queued".into(),
            input: new_job.input,
            profile: new_job.profile,
            adapter_id: None,
            started_at: None,
            finished_at: None,
            last_error: None,
            created_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO jobs (
                id, kind, status, input, profile, adapter_id, started_at, finished_at, last_error, created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
        )
        .bind(record.id.to_string())
        .bind(record.kind.as_str())
        .bind(&record.status)
        .bind(&record.input)
        .bind(&record.profile)
        .bind(&record.adapter_id)
        .bind(record.started_at.map(|value| value.to_rfc3339()))
        .bind(record.finished_at.map(|value| value.to_rfc3339()))
        .bind(&record.last_error)
        .bind(record.created_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to insert job")?;

        Ok(record)
    }

    pub async fn update_job_state(
        &self,
        id: Uuid,
        status: &str,
        adapter_id: Option<&str>,
        started_at: Option<DateTime<Utc>>,
        finished_at: Option<DateTime<Utc>>,
        last_error: Option<&str>,
    ) -> Result<JobRecord> {
        sqlx::query(
            r#"
            UPDATE jobs
            SET
                status = ?2,
                adapter_id = ?3,
                started_at = ?4,
                finished_at = ?5,
                last_error = ?6
            WHERE id = ?1
            "#,
        )
        .bind(id.to_string())
        .bind(status)
        .bind(adapter_id)
        .bind(started_at.map(|value| value.to_rfc3339()))
        .bind(finished_at.map(|value| value.to_rfc3339()))
        .bind(last_error)
        .execute(&self.pool)
        .await
        .context("failed to update job state")?;

        self.get_job(id).await
    }

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

    pub async fn upsert_user_profile(&self, profile: NewUserProfileRecord) -> Result<UserProfileRecord> {
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

    pub async fn import_memory_entry(&self, entry: NewMemoryEntryRecord) -> Result<MemoryEntryRecord> {
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

    pub async fn import_legacy_event(&self, event: NewLegacyEventRecord) -> Result<LegacyEventRecord> {
        let record = LegacyEventRecord {
            id: Uuid::new_v4(),
            source_path: event.source_path,
            source_type: event.source_type,
            payload: event.payload,
            created_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO legacy_events (id, source_path, source_type, payload, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
        )
        .bind(record.id.to_string())
        .bind(&record.source_path)
        .bind(&record.source_type)
        .bind(record.payload.to_string())
        .bind(record.created_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to import legacy event")?;

        Ok(record)
    }

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

    pub async fn import_counts(&self) -> Result<ImportCounts> {
        Ok(ImportCounts {
            user_profiles: count_table(&self.pool, "user_profiles").await?,
            memory_entries: count_table(&self.pool, "memory_entries").await?,
            legacy_events: count_table(&self.pool, "legacy_events").await?,
            config_artifacts: count_table(&self.pool, "config_artifacts").await?,
        })
    }

    pub async fn runtime_counts(&self) -> Result<RuntimeCounts> {
        Ok(RuntimeCounts {
            messages: count_table(&self.pool, "messages").await?,
            jobs: count_table(&self.pool, "jobs").await?,
            user_profiles: count_table(&self.pool, "user_profiles").await?,
            memory_entries: count_table(&self.pool, "memory_entries").await?,
            legacy_events: count_table(&self.pool, "legacy_events").await?,
            config_artifacts: count_table(&self.pool, "config_artifacts").await?,
        })
    }

    pub async fn list_jobs(&self) -> Result<Vec<JobRecord>> {
        let rows = sqlx::query(
            r#"
            SELECT
                id, kind, status, input, profile, adapter_id, started_at, finished_at, last_error, created_at
            FROM jobs
            ORDER BY created_at DESC, rowid DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load jobs")?;

        rows.into_iter()
            .map(|row| {
                Ok(JobRecord {
                    id: parse_uuid(&row, "id")?,
                    kind: JobKind::from(row.get::<String, _>("kind").as_str()),
                    status: row.get::<String, _>("status"),
                    input: row.get::<Option<String>, _>("input"),
                    profile: row.get::<Option<String>, _>("profile"),
                    adapter_id: row.get::<Option<String>, _>("adapter_id"),
                    started_at: parse_optional_datetime(&row, "started_at")?,
                    finished_at: parse_optional_datetime(&row, "finished_at")?,
                    last_error: row.get::<Option<String>, _>("last_error"),
                    created_at: parse_datetime(&row, "created_at")?,
                })
            })
            .collect()
    }

    pub async fn get_job(&self, id: Uuid) -> Result<JobRecord> {
        let row = sqlx::query(
            r#"
            SELECT
                id, kind, status, input, profile, adapter_id, started_at, finished_at, last_error, created_at
            FROM jobs
            WHERE id = ?1
            "#,
        )
        .bind(id.to_string())
        .fetch_one(&self.pool)
        .await
        .context("failed to load job")?;

        Ok(JobRecord {
            id: parse_uuid(&row, "id")?,
            kind: JobKind::from(row.get::<String, _>("kind").as_str()),
            status: row.get::<String, _>("status"),
            input: row.get::<Option<String>, _>("input"),
            profile: row.get::<Option<String>, _>("profile"),
            adapter_id: row.get::<Option<String>, _>("adapter_id"),
            started_at: parse_optional_datetime(&row, "started_at")?,
            finished_at: parse_optional_datetime(&row, "finished_at")?,
            last_error: row.get::<Option<String>, _>("last_error"),
            created_at: parse_datetime(&row, "created_at")?,
        })
    }

    pub async fn create_adapter_run(&self, new_run: NewAdapterRunRecord) -> Result<AdapterRecord> {
        let now = Utc::now();
        let record = AdapterRecord {
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
    ) -> Result<AdapterRecord> {
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

    pub async fn list_adapter_runs(&self) -> Result<Vec<AdapterRecord>> {
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

    pub async fn get_adapter_run(&self, id: Uuid) -> Result<AdapterRecord> {
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

    async fn initialize_schema(&self) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                input TEXT,
                profile TEXT,
                adapter_id TEXT,
                started_at TEXT,
                finished_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tts_requests (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                text TEXT NOT NULL,
                voice TEXT,
                status TEXT NOT NULL,
                adapter_id TEXT,
                audio_path TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_profiles (
                user_id TEXT PRIMARY KEY,
                preferred_name TEXT,
                interaction_count INTEGER NOT NULL,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS memory_entries (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                entry_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS legacy_events (
                id TEXT PRIMARY KEY,
                source_path TEXT NOT NULL,
                source_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS config_artifacts (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                copied_to TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS adapter_runs (
                id TEXT PRIMARY KEY,
                adapter_id TEXT NOT NULL,
                status TEXT NOT NULL,
                python_executable TEXT NOT NULL,
                args TEXT NOT NULL,
                pid INTEGER,
                started_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_error TEXT
            );
            "#,
        )
        .execute(&self.pool)
        .await
        .context("failed to initialize schema")?;
        add_column_if_missing(&self.pool, "jobs", "adapter_id TEXT").await?;
        add_column_if_missing(&self.pool, "jobs", "started_at TEXT").await?;
        add_column_if_missing(&self.pool, "jobs", "finished_at TEXT").await?;
        add_column_if_missing(&self.pool, "jobs", "last_error TEXT").await?;
        add_column_if_missing(&self.pool, "tts_requests", "adapter_id TEXT").await?;

        Ok(())
    }
}

fn parse_uuid(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Uuid> {
    let raw = row.get::<String, _>(column);
    Uuid::parse_str(&raw).with_context(|| format!("invalid uuid in column {column}: {raw}"))
}

fn parse_datetime(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<DateTime<Utc>> {
    let raw = row.get::<String, _>(column);
    DateTime::parse_from_rfc3339(&raw)
        .map(|value| value.with_timezone(&Utc))
        .with_context(|| format!("invalid timestamp in column {column}: {raw}"))
}

fn parse_optional_datetime(
    row: &sqlx::sqlite::SqliteRow,
    column: &str,
) -> Result<Option<DateTime<Utc>>> {
    match row.get::<Option<String>, _>(column) {
        Some(raw) => DateTime::parse_from_rfc3339(&raw)
            .map(|value| Some(value.with_timezone(&Utc)))
            .with_context(|| format!("invalid timestamp in column {column}: {raw}")),
        None => Ok(None),
    }
}

async fn count_table(pool: &SqlitePool, table: &str) -> Result<i64> {
    let sql = format!("SELECT COUNT(*) as count FROM {table}");
    sqlx::query_scalar::<_, i64>(&sql)
        .fetch_one(pool)
        .await
        .with_context(|| format!("failed to count rows in {table}"))
}

fn map_adapter_row(row: &sqlx::sqlite::SqliteRow) -> Result<AdapterRecord> {
    Ok(AdapterRecord {
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

fn parse_string_array(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Vec<String>> {
    let raw = row.get::<String, _>(column);
    serde_json::from_str(&raw).with_context(|| format!("invalid string array in column {column}"))
}

fn map_tts_row(row: &sqlx::sqlite::SqliteRow) -> Result<TtsRequestRecord> {
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

async fn add_column_if_missing(pool: &SqlitePool, table: &str, column_definition: &str) -> Result<()> {
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column_definition}");
    match sqlx::query(&sql).execute(pool).await {
        Ok(_) => Ok(()),
        Err(error) if error.to_string().contains("duplicate column name") => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to add column {column_definition} to {table}")),
    }
}
