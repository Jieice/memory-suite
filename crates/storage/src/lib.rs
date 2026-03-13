use std::path::Path;

use anyhow::{Context, Result};
use api_types::{
    AdapterRecord, AdapterStatus, ConfigArtifactRecord, DanmakuBootstrapRecord,
    DanmakuConnectionStateRecord, DanmakuHostRecord, DanmakuSourceConfigRecord,
    FallbackStatsRecord, JobKind, JobRecord, JobStatus, Live2dConfigRecord, Live2dStateRecord,
    MemoryEntryRecord, MessageRole, PersonaRuntimeStateRecord, StoredMessage, TtsRequestRecord,
    UserProfileRecord, UserRelationshipRecord,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
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

#[derive(Debug, Clone)]
pub struct NewLive2dStateRecord {
    pub subtitle: String,
    pub subtitle_duration_ms: u64,
    pub emotion: String,
}

#[derive(Debug, Clone)]
pub struct NewLive2dConfigRecord {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone)]
pub struct NewDanmakuSourceConfigRecord {
    pub room_id: String,
    pub uid: u64,
    pub buvid: String,
    pub cookie: Option<String>,
    pub signature_mode: String,
    pub connection_mode: String,
}

#[derive(Debug, Clone)]
pub struct DanmakuSourceSecretRecord {
    pub room_id: String,
    pub uid: u64,
    pub buvid: String,
    pub cookie: Option<String>,
    pub signature_mode: String,
    pub connection_mode: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewDanmakuConnectionStateRecord {
    pub status: String,
    pub attempt_count: u32,
    pub consecutive_failures: u32,
    pub retry_delay_ms: u32,
    pub session_id: Option<String>,
    pub current_upstream_host: Option<String>,
    pub last_connect_attempt_at: Option<DateTime<Utc>>,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
    pub next_retry_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub last_close_reason: Option<String>,
    pub adapter_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewDanmakuBootstrapRecord {
    pub requested_room_id: String,
    pub resolved_room_id: String,
    pub live_status: u32,
    pub token: String,
    pub upstream_hosts: Vec<DanmakuHostRecord>,
    pub selected_upstream_host: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportCounts {
    pub user_profiles: i64,
    pub memory_entries: i64,
    pub config_artifacts: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeCounts {
    pub messages: i64,
    pub jobs: i64,
    pub user_profiles: i64,
    pub memory_entries: i64,
    pub config_artifacts: i64,
}

impl Storage {
    pub async fn connect(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.with_context(|| {
                format!("failed to create runtime directory {}", parent.display())
            })?;
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal);
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

    pub async fn sqlite_runtime_settings(&self) -> Result<(String, i64)> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .context("failed to acquire sqlite connection for pragma snapshot")?;
        let journal_mode = sqlx::query("PRAGMA journal_mode;")
            .fetch_one(&mut *connection)
            .await
            .context("failed to read sqlite journal_mode")?
            .get::<String, _>(0);
        let synchronous = sqlx::query("PRAGMA synchronous;")
            .fetch_one(&mut *connection)
            .await
            .context("failed to read sqlite synchronous")?
            .get::<i64, _>(0);
        Ok((journal_mode, synchronous))
    }

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

    pub async fn create_job(&self, new_job: NewJobRecord) -> Result<JobRecord> {
        let record = JobRecord {
            id: Uuid::new_v4(),
            kind: new_job.kind,
            status: JobStatus::Queued,
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
        .bind(record.status.as_str())
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
        status: JobStatus,
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
        .bind(status.as_str())
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
            config_artifacts: count_table(&self.pool, "config_artifacts").await?,
        })
    }

    pub async fn runtime_counts(&self) -> Result<RuntimeCounts> {
        Ok(RuntimeCounts {
            messages: count_table(&self.pool, "messages").await?,
            jobs: count_table(&self.pool, "jobs").await?,
            user_profiles: count_table(&self.pool, "user_profiles").await?,
            memory_entries: count_table(&self.pool, "memory_entries").await?,
            config_artifacts: count_table(&self.pool, "config_artifacts").await?,
        })
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
                    status: JobStatus::from(row.get::<String, _>("status").as_str()),
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
            status: JobStatus::from(row.get::<String, _>("status").as_str()),
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

    pub async fn upsert_live2d_config(
        &self,
        config: NewLive2dConfigRecord,
    ) -> Result<Live2dConfigRecord> {
        let record = Live2dConfigRecord {
            scale: config.scale,
            x: config.x,
            y: config.y,
            updated_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO live2d_config (id, scale, x, y, updated_at)
            VALUES (1, ?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
                scale = excluded.scale,
                x = excluded.x,
                y = excluded.y,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(record.scale)
        .bind(record.x)
        .bind(record.y)
        .bind(record.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to upsert live2d config")?;

        Ok(record)
    }

    pub async fn upsert_live2d_state(
        &self,
        state: NewLive2dStateRecord,
    ) -> Result<Live2dStateRecord> {
        let config = self.get_live2d_config().await?;
        let record = Live2dStateRecord {
            subtitle: state.subtitle,
            subtitle_duration_ms: state.subtitle_duration_ms,
            emotion: state.emotion,
            config,
            updated_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO live2d_state (id, subtitle, subtitle_duration_ms, emotion, updated_at)
            VALUES (1, ?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
                subtitle = excluded.subtitle,
                subtitle_duration_ms = excluded.subtitle_duration_ms,
                emotion = excluded.emotion,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&record.subtitle)
        .bind(record.subtitle_duration_ms as i64)
        .bind(&record.emotion)
        .bind(record.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to upsert live2d state")?;

        Ok(record)
    }

    pub async fn get_live2d_config(&self) -> Result<Live2dConfigRecord> {
        let row = sqlx::query(
            r#"
            SELECT scale, x, y, updated_at
            FROM live2d_config
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load live2d config")?;

        match row {
            Some(row) => Ok(Live2dConfigRecord {
                scale: row.get::<f64, _>("scale"),
                x: row.get::<f64, _>("x"),
                y: row.get::<f64, _>("y"),
                updated_at: parse_datetime(&row, "updated_at")?,
            }),
            None => {
                self.upsert_live2d_config(NewLive2dConfigRecord {
                    scale: 0.25,
                    x: 0.3,
                    y: 0.5,
                })
                .await
            }
        }
    }

    pub async fn get_live2d_state(&self) -> Result<Live2dStateRecord> {
        let config = self.get_live2d_config().await?;
        let row = sqlx::query(
            r#"
            SELECT subtitle, subtitle_duration_ms, emotion, updated_at
            FROM live2d_state
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load live2d state")?;

        match row {
            Some(row) => Ok(Live2dStateRecord {
                subtitle: row.get::<String, _>("subtitle"),
                subtitle_duration_ms: row.get::<i64, _>("subtitle_duration_ms").max(0) as u64,
                emotion: row.get::<String, _>("emotion"),
                config,
                updated_at: parse_datetime(&row, "updated_at")?,
            }),
            None => {
                let state = self
                    .upsert_live2d_state(NewLive2dStateRecord {
                        subtitle: String::new(),
                        subtitle_duration_ms: 0,
                        emotion: "normal".into(),
                    })
                    .await?;
                Ok(Live2dStateRecord { config, ..state })
            }
        }
    }

    pub async fn upsert_danmaku_source_config(
        &self,
        source: NewDanmakuSourceConfigRecord,
    ) -> Result<DanmakuSourceConfigRecord> {
        let record = DanmakuSourceConfigRecord {
            room_id: source.room_id,
            uid: source.uid,
            buvid: source.buvid,
            has_cookie: source
                .cookie
                .as_deref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
            signature_mode: source.signature_mode,
            connection_mode: source.connection_mode,
            updated_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO danmaku_source_config (
                id, room_id, uid, buvid, cookie, signature_mode, connection_mode, updated_at
            )
            VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                room_id = excluded.room_id,
                uid = excluded.uid,
                buvid = excluded.buvid,
                cookie = excluded.cookie,
                signature_mode = excluded.signature_mode,
                connection_mode = excluded.connection_mode,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&record.room_id)
        .bind(record.uid as i64)
        .bind(&record.buvid)
        .bind(source.cookie)
        .bind(&record.signature_mode)
        .bind(&record.connection_mode)
        .bind(record.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to upsert danmaku source config")?;

        Ok(record)
    }

    pub async fn get_danmaku_source_config(&self) -> Result<DanmakuSourceConfigRecord> {
        let row = sqlx::query(
            r#"
            SELECT room_id, uid, buvid, cookie, signature_mode, connection_mode, updated_at
            FROM danmaku_source_config
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load danmaku source config")?;

        match row {
            Some(row) => Ok(DanmakuSourceConfigRecord {
                room_id: row.get::<String, _>("room_id"),
                uid: row.get::<i64, _>("uid").max(0) as u64,
                buvid: row.get::<String, _>("buvid"),
                has_cookie: row
                    .get::<Option<String>, _>("cookie")
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false),
                signature_mode: row.get::<String, _>("signature_mode"),
                connection_mode: row.get::<String, _>("connection_mode"),
                updated_at: parse_datetime(&row, "updated_at")?,
            }),
            None => {
                self.upsert_danmaku_source_config(NewDanmakuSourceConfigRecord {
                    room_id: String::new(),
                    uid: 0,
                    buvid: String::new(),
                    cookie: None,
                    signature_mode: "cookie".into(),
                    connection_mode: "native_websocket".into(),
                })
                .await
            }
        }
    }

    pub async fn get_danmaku_source_secret(&self) -> Result<DanmakuSourceSecretRecord> {
        let row = sqlx::query(
            r#"
            SELECT room_id, uid, buvid, cookie, signature_mode, connection_mode, updated_at
            FROM danmaku_source_config
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load danmaku source secret config")?;

        match row {
            Some(row) => Ok(DanmakuSourceSecretRecord {
                room_id: row.get::<String, _>("room_id"),
                uid: row.get::<i64, _>("uid").max(0) as u64,
                buvid: row.get::<String, _>("buvid"),
                cookie: row.get::<Option<String>, _>("cookie"),
                signature_mode: row.get::<String, _>("signature_mode"),
                connection_mode: row.get::<String, _>("connection_mode"),
                updated_at: parse_datetime(&row, "updated_at")?,
            }),
            None => {
                self.upsert_danmaku_source_config(NewDanmakuSourceConfigRecord {
                    room_id: String::new(),
                    uid: 0,
                    buvid: String::new(),
                    cookie: None,
                    signature_mode: "cookie".into(),
                    connection_mode: "native_websocket".into(),
                })
                .await?;
                Ok(DanmakuSourceSecretRecord {
                    room_id: String::new(),
                    uid: 0,
                    buvid: String::new(),
                    cookie: None,
                    signature_mode: "cookie".into(),
                    connection_mode: "native_websocket".into(),
                    updated_at: Utc::now(),
                })
            }
        }
    }

    pub async fn upsert_danmaku_connection_state(
        &self,
        state: NewDanmakuConnectionStateRecord,
    ) -> Result<DanmakuConnectionStateRecord> {
        let record = DanmakuConnectionStateRecord {
            status: state.status,
            attempt_count: state.attempt_count,
            consecutive_failures: state.consecutive_failures,
            retry_delay_ms: state.retry_delay_ms,
            session_id: state.session_id,
            current_upstream_host: state.current_upstream_host,
            last_connect_attempt_at: state.last_connect_attempt_at,
            last_heartbeat_at: state.last_heartbeat_at,
            next_retry_at: state.next_retry_at,
            last_error: state.last_error,
            last_close_reason: state.last_close_reason,
            adapter_id: state.adapter_id,
            updated_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO danmaku_connection_state (
                id, status, attempt_count, session_id, current_upstream_host, last_connect_attempt_at,
                last_heartbeat_at, next_retry_at, last_error, last_close_reason, adapter_id,
                consecutive_failures, retry_delay_ms, updated_at
            )
            VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                attempt_count = excluded.attempt_count,
                session_id = excluded.session_id,
                current_upstream_host = excluded.current_upstream_host,
                last_connect_attempt_at = excluded.last_connect_attempt_at,
                last_heartbeat_at = excluded.last_heartbeat_at,
                next_retry_at = excluded.next_retry_at,
                last_error = excluded.last_error,
                last_close_reason = excluded.last_close_reason,
                adapter_id = excluded.adapter_id,
                consecutive_failures = excluded.consecutive_failures,
                retry_delay_ms = excluded.retry_delay_ms,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&record.status)
        .bind(record.attempt_count as i64)
        .bind(&record.session_id)
        .bind(&record.current_upstream_host)
        .bind(record.last_connect_attempt_at.map(|value| value.to_rfc3339()))
        .bind(record.last_heartbeat_at.map(|value| value.to_rfc3339()))
        .bind(record.next_retry_at.map(|value| value.to_rfc3339()))
        .bind(&record.last_error)
        .bind(&record.last_close_reason)
        .bind(&record.adapter_id)
        .bind(record.consecutive_failures as i64)
        .bind(record.retry_delay_ms as i64)
        .bind(record.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to upsert danmaku connection state")?;

        Ok(record)
    }

    pub async fn get_danmaku_connection_state(&self) -> Result<DanmakuConnectionStateRecord> {
        let row = sqlx::query(
            r#"
            SELECT
                status,
                attempt_count,
                consecutive_failures,
                retry_delay_ms,
                session_id,
                current_upstream_host,
                last_connect_attempt_at,
                last_heartbeat_at,
                next_retry_at,
                last_error,
                last_close_reason,
                adapter_id,
                updated_at
            FROM danmaku_connection_state
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load danmaku connection state")?;

        match row {
            Some(row) => Ok(DanmakuConnectionStateRecord {
                status: row.get::<String, _>("status"),
                attempt_count: row.get::<i64, _>("attempt_count").max(0) as u32,
                consecutive_failures: row.get::<i64, _>("consecutive_failures").max(0) as u32,
                retry_delay_ms: row.get::<i64, _>("retry_delay_ms").max(0) as u32,
                session_id: row.get::<Option<String>, _>("session_id"),
                current_upstream_host: row.get::<Option<String>, _>("current_upstream_host"),
                last_connect_attempt_at: parse_optional_datetime(&row, "last_connect_attempt_at")?,
                last_heartbeat_at: parse_optional_datetime(&row, "last_heartbeat_at")?,
                next_retry_at: parse_optional_datetime(&row, "next_retry_at")?,
                last_error: row.get::<Option<String>, _>("last_error"),
                last_close_reason: row.get::<Option<String>, _>("last_close_reason"),
                adapter_id: row.get::<Option<String>, _>("adapter_id"),
                updated_at: parse_datetime(&row, "updated_at")?,
            }),
            None => {
                self.upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                    status: "disconnected".into(),
                    attempt_count: 0,
                    consecutive_failures: 0,
                    retry_delay_ms: 0,
                    session_id: None,
                    current_upstream_host: None,
                    last_connect_attempt_at: None,
                    last_heartbeat_at: None,
                    next_retry_at: None,
                    last_error: None,
                    last_close_reason: None,
                    adapter_id: None,
                })
                .await
            }
        }
    }

    pub async fn upsert_danmaku_bootstrap(
        &self,
        bootstrap: NewDanmakuBootstrapRecord,
    ) -> Result<DanmakuBootstrapRecord> {
        let record = DanmakuBootstrapRecord {
            requested_room_id: bootstrap.requested_room_id,
            resolved_room_id: bootstrap.resolved_room_id,
            live_status: bootstrap.live_status,
            token_ready: !bootstrap.token.trim().is_empty(),
            token: bootstrap.token.clone(),
            selected_upstream_host: bootstrap.selected_upstream_host,
            upstream_hosts: bootstrap.upstream_hosts,
            fetched_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO danmaku_bootstrap_snapshot (
                id, requested_room_id, resolved_room_id, live_status, token, upstream_hosts,
                selected_upstream_host, fetched_at
            )
            VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                requested_room_id = excluded.requested_room_id,
                resolved_room_id = excluded.resolved_room_id,
                live_status = excluded.live_status,
                token = excluded.token,
                upstream_hosts = excluded.upstream_hosts,
                selected_upstream_host = excluded.selected_upstream_host,
                fetched_at = excluded.fetched_at
            "#,
        )
        .bind(&record.requested_room_id)
        .bind(&record.resolved_room_id)
        .bind(record.live_status as i64)
        .bind(&bootstrap.token)
        .bind(serde_json::to_string(&record.upstream_hosts).context("serialize danmaku hosts")?)
        .bind(&record.selected_upstream_host)
        .bind(record.fetched_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to upsert danmaku bootstrap snapshot")?;

        Ok(record)
    }

    pub async fn get_danmaku_bootstrap(&self) -> Result<Option<DanmakuBootstrapRecord>> {
        let row = sqlx::query(
            r#"
            SELECT
                requested_room_id,
                resolved_room_id,
                live_status,
                token,
                upstream_hosts,
                selected_upstream_host,
                fetched_at
            FROM danmaku_bootstrap_snapshot
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load danmaku bootstrap snapshot")?;

        row.map(|row| {
            Ok(DanmakuBootstrapRecord {
                requested_room_id: row.get::<String, _>("requested_room_id"),
                resolved_room_id: row.get::<String, _>("resolved_room_id"),
                live_status: row.get::<i64, _>("live_status").max(0) as u32,
                token_ready: !row.get::<String, _>("token").trim().is_empty(),
                token: row.get::<String, _>("token"),
                upstream_hosts: serde_json::from_str(&row.get::<String, _>("upstream_hosts"))
                    .context("parse danmaku upstream hosts")?,
                selected_upstream_host: row.get::<Option<String>, _>("selected_upstream_host"),
                fetched_at: parse_datetime(&row, "fetched_at")?,
            })
        })
        .transpose()
    }

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
            INSERT OR IGNORE INTO persona_runtime_config (id, mode, tone_profile, warmth, sarcasm, autonomy, current_context)
            VALUES (1, 'stream', 'balanced', 0.5, 0.5, 0.2, 'idle')
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

            CREATE TABLE IF NOT EXISTS live2d_config (
                id INTEGER PRIMARY KEY,
                scale REAL NOT NULL,
                x REAL NOT NULL,
                y REAL NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS live2d_state (
                id INTEGER PRIMARY KEY,
                subtitle TEXT NOT NULL,
                subtitle_duration_ms INTEGER NOT NULL,
                emotion TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS danmaku_source_config (
                id INTEGER PRIMARY KEY,
                room_id TEXT NOT NULL,
                uid INTEGER NOT NULL,
                buvid TEXT NOT NULL,
                cookie TEXT,
                signature_mode TEXT NOT NULL,
                connection_mode TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS danmaku_connection_state (
                id INTEGER PRIMARY KEY,
                status TEXT NOT NULL,
                attempt_count INTEGER NOT NULL,
                consecutive_failures INTEGER NOT NULL DEFAULT 0,
                retry_delay_ms INTEGER NOT NULL DEFAULT 0,
                session_id TEXT,
                current_upstream_host TEXT,
                last_connect_attempt_at TEXT,
                last_heartbeat_at TEXT,
                next_retry_at TEXT,
                last_error TEXT,
                last_close_reason TEXT,
                adapter_id TEXT,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS danmaku_bootstrap_snapshot (
                id INTEGER PRIMARY KEY,
                requested_room_id TEXT NOT NULL,
                resolved_room_id TEXT NOT NULL,
                live_status INTEGER NOT NULL,
                token TEXT NOT NULL,
                upstream_hosts TEXT NOT NULL,
                selected_upstream_host TEXT,
                fetched_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS persona_runtime_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                mode TEXT NOT NULL DEFAULT 'stream',
                tone_profile TEXT NOT NULL DEFAULT 'balanced',
                warmth REAL NOT NULL DEFAULT 0.5,
                sarcasm REAL NOT NULL DEFAULT 0.5,
                autonomy REAL NOT NULL DEFAULT 0.2
            );

            CREATE TABLE IF NOT EXISTS user_relationships (
                user_id TEXT PRIMARY KEY,
                relationship_type TEXT NOT NULL DEFAULT 'unknown',
                warmth_level REAL NOT NULL DEFAULT 0.5,
                interaction_count INTEGER NOT NULL DEFAULT 0,
                last_seen TEXT
            );

            CREATE TABLE IF NOT EXISTS fallback_stats (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                remote_successes INTEGER NOT NULL DEFAULT 0,
                remote_timeouts INTEGER NOT NULL DEFAULT 0,
                builtin_fallbacks INTEGER NOT NULL DEFAULT 0,
                last_path TEXT NOT NULL DEFAULT 'none'
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
        add_column_if_missing(
            &self.pool,
            "danmaku_connection_state",
            "consecutive_failures INTEGER NOT NULL DEFAULT 0",
        )
        .await?;
        add_column_if_missing(
            &self.pool,
            "danmaku_connection_state",
            "retry_delay_ms INTEGER NOT NULL DEFAULT 0",
        )
        .await?;
        add_column_if_missing(&self.pool, "danmaku_connection_state", "session_id TEXT").await?;
        add_column_if_missing(&self.pool, "danmaku_connection_state", "next_retry_at TEXT").await?;
        add_column_if_missing(
            &self.pool,
            "danmaku_connection_state",
            "last_close_reason TEXT",
        )
        .await?;
        add_column_if_missing(
            &self.pool,
            "persona_runtime_config",
            "current_context TEXT NOT NULL DEFAULT 'idle'",
        )
        .await?;
        add_column_if_missing(
            &self.pool,
            "persona_runtime_config",
            "current_mood TEXT NOT NULL DEFAULT 'neutral'",
        )
        .await?;

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

fn parse_json(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Value> {
    let raw = row.get::<String, _>(column);
    serde_json::from_str(&raw).with_context(|| format!("invalid json payload in column {column}"))
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

async fn add_column_if_missing(
    pool: &SqlitePool,
    table: &str,
    column_definition: &str,
) -> Result<()> {
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column_definition}");
    match sqlx::query(&sql).execute(pool).await {
        Ok(_) => Ok(()),
        Err(error) if error.to_string().contains("duplicate column name") => Ok(()),
        Err(error) => Err(error)
            .with_context(|| format!("failed to add column {column_definition} to {table}")),
    }
}
