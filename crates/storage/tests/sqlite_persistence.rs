use api_types::MessageRole;
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use storage::{NewMessageRecord, Storage};
use tempfile::tempdir;

#[tokio::test]
async fn initializes_schema_and_persists_messages() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("memory-suite.db");

    let storage = Storage::connect(&db_path).await.expect("connect storage");

    let user_message = storage
        .append_message(NewMessageRecord {
            session_id: "session-a".into(),
            role: MessageRole::User,
            text: "你好".into(),
        })
        .await
        .expect("persist user message");

    storage
        .append_message(NewMessageRecord {
            session_id: "session-a".into(),
            role: MessageRole::Assistant,
            text: "统一主进程已经在线".into(),
        })
        .await
        .expect("persist assistant message");

    let messages = storage
        .list_messages("session-a")
        .await
        .expect("list messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].id, user_message.id);

    let counts = storage.runtime_counts().await.expect("runtime counts");
    assert_eq!(counts.messages, 2);
}

#[tokio::test]
async fn connect_configures_sqlite_for_low_latency_runtime_writes() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("memory-suite.db");

    let storage = Storage::connect(&db_path).await.expect("connect storage");

    let (journal_mode, synchronous) = storage
        .sqlite_runtime_settings()
        .await
        .expect("read runtime sqlite settings");
    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    assert_eq!(synchronous, 1, "expected NORMAL synchronous mode");
}

#[tokio::test]
async fn stores_and_reads_persona_runtime_state() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("persona-test.db");
    let storage = Storage::connect(&db_path).await.expect("connect storage");

    // Default state should be readable without explicit upsert
    let default_state = storage
        .get_persona_runtime_state()
        .await
        .expect("default persona state");
    assert_eq!(default_state.mode, "stream");
    assert_eq!(default_state.tone_profile, "balanced");
    assert_eq!(default_state.fallback.builtin_fallbacks, 0);
    assert_eq!(default_state.fallback.last_path, "none");

    // Upsert a new config
    storage
        .upsert_persona_runtime_config("stream", "sharp-playful", 0.45, 0.65, 0.20, "explaining", "curious")
        .await
        .expect("upsert persona config");

    // Bump a fallback stat
    storage
        .bump_fallback_stat("builtin")
        .await
        .expect("bump builtin fallback");

    let state = storage
        .get_persona_runtime_state()
        .await
        .expect("persona state after update");
    assert_eq!(state.tone_profile, "sharp-playful");
    assert_eq!(state.fallback.builtin_fallbacks, 1);
    assert_eq!(state.fallback.last_path, "builtin");

    // Bump remote timeout
    storage
        .bump_fallback_stat("builtin_timeout")
        .await
        .expect("bump remote timeout");

    let state2 = storage
        .get_persona_runtime_state()
        .await
        .expect("persona state after timeout");
    assert_eq!(state2.fallback.remote_timeouts, 1);
    assert_eq!(state2.fallback.last_path, "builtin_timeout");
}

#[tokio::test]
async fn migrates_legacy_danmaku_source_config_without_connection_mode() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("legacy-danmaku.db");

    let legacy_pool = connect_sqlite_pool(&db_path).await;
    sqlx::query(
        r#"
        CREATE TABLE danmaku_source_config (
            id INTEGER PRIMARY KEY,
            room_id TEXT NOT NULL,
            uid INTEGER NOT NULL,
            buvid TEXT NOT NULL,
            cookie TEXT,
            signature_mode TEXT NOT NULL,
            connection_mode TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(&legacy_pool)
    .await
    .expect("create legacy danmaku source config");
    sqlx::query(
        r#"
        INSERT INTO danmaku_source_config (
            id, room_id, uid, buvid, cookie, signature_mode, connection_mode, updated_at
        )
        VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind("778899")
    .bind(123_i64)
    .bind("legacy-buvid")
    .bind("SESSDATA=legacy;")
    .bind("cookie")
    .bind("websocket")
    .bind("2026-01-01T00:00:00+00:00")
    .execute(&legacy_pool)
    .await
    .expect("seed legacy danmaku source config");
    drop(legacy_pool);

    let storage = Storage::connect(&db_path).await.expect("connect migrated storage");
    let source = storage
        .get_danmaku_source_config()
        .await
        .expect("read migrated danmaku source config");
    assert_eq!(source.room_id, "778899");
    assert_eq!(source.uid, 123);
    assert_eq!(source.buvid, "legacy-buvid");
    assert!(source.has_cookie);
    assert_eq!(source.signature_mode, "cookie");

    let migrated_pool = connect_sqlite_pool(&db_path).await;
    let columns = sqlx::query("PRAGMA table_info(danmaku_source_config)")
        .fetch_all(&migrated_pool)
        .await
        .expect("inspect migrated danmaku source schema");
    assert!(
        columns
            .iter()
            .all(|row| row.get::<String, _>("name") != "connection_mode")
    );
}

#[tokio::test]
async fn migrates_legacy_danmaku_connection_state_without_adapter_id() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("legacy-danmaku-state.db");

    let legacy_pool = connect_sqlite_pool(&db_path).await;
    sqlx::query(
        r#"
        CREATE TABLE danmaku_connection_state (
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
        )
        "#,
    )
    .execute(&legacy_pool)
    .await
    .expect("create legacy danmaku connection state");
    sqlx::query(
        r#"
        INSERT INTO danmaku_connection_state (
            id, status, attempt_count, consecutive_failures, retry_delay_ms, session_id,
            current_upstream_host, last_connect_attempt_at, last_heartbeat_at, next_retry_at,
            last_error, last_close_reason, adapter_id, updated_at
        )
        VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        "#,
    )
    .bind("connected")
    .bind(2_i64)
    .bind(1_i64)
    .bind(1000_i64)
    .bind("native:legacy")
    .bind("legacy-host.example")
    .bind("2026-01-01T00:00:00+00:00")
    .bind("2026-01-01T00:00:05+00:00")
    .bind(Option::<String>::None)
    .bind("legacy error")
    .bind("legacy close")
    .bind("native_bilibili")
    .bind("2026-01-01T00:00:10+00:00")
    .execute(&legacy_pool)
    .await
    .expect("seed legacy danmaku connection state");
    drop(legacy_pool);

    let storage = Storage::connect(&db_path).await.expect("connect migrated storage");
    let state = storage
        .get_danmaku_connection_state()
        .await
        .expect("read migrated danmaku connection state");
    assert_eq!(state.status, "connected");
    assert_eq!(state.attempt_count, 2);
    assert_eq!(state.consecutive_failures, 1);
    assert_eq!(state.retry_delay_ms, 1000);
    assert_eq!(state.session_id.as_deref(), Some("native:legacy"));
    assert_eq!(
        state.current_upstream_host.as_deref(),
        Some("legacy-host.example")
    );
    assert_eq!(state.last_error.as_deref(), Some("legacy error"));
    assert_eq!(state.last_close_reason.as_deref(), Some("legacy close"));

    let migrated_pool = connect_sqlite_pool(&db_path).await;
    let columns = sqlx::query("PRAGMA table_info(danmaku_connection_state)")
        .fetch_all(&migrated_pool)
        .await
        .expect("inspect migrated danmaku connection state schema");
    assert!(
        columns
            .iter()
            .all(|row| row.get::<String, _>("name") != "adapter_id")
    );
}

async fn connect_sqlite_pool(path: &std::path::Path) -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("connect sqlite pool")
}
