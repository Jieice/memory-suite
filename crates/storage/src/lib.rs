use std::path::Path;

use anyhow::{Context, Result};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};

mod adapters;
mod artifacts;
mod counts;
mod danmaku;
mod live2d;
mod memory;
mod messages;
mod persona;
mod profiles;
mod relationships;
mod tts;
mod util;

pub use adapters::{AdapterRunRecord, NewAdapterRunRecord};
pub use artifacts::NewConfigArtifactRecord;
pub use counts::RuntimeCounts;
pub use danmaku::{
    DanmakuSourceSecretRecord, NewDanmakuBootstrapRecord, NewDanmakuConnectionStateRecord,
    NewDanmakuSourceConfigRecord,
};
pub use live2d::{NewLive2dConfigRecord, NewLive2dStateRecord};
pub use memory::NewMemoryEntryRecord;
pub use messages::NewMessageRecord;
pub use profiles::NewUserProfileRecord;
pub use tts::NewTtsRecord;

#[derive(Debug, Clone)]
pub struct Storage {
    pool: SqlitePool,
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
                autonomy REAL NOT NULL DEFAULT 0.2,
                current_context TEXT NOT NULL DEFAULT 'idle',
                current_mood TEXT NOT NULL DEFAULT 'neutral'
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

        Ok(())
    }
}
