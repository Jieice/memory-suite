use api_types::{JobKind, MessageRole};
use storage::{NewJobRecord, NewMessageRecord, Storage};
use tempfile::tempdir;

#[tokio::test]
async fn initializes_schema_and_persists_messages_and_jobs() {
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

    let job = storage
        .create_job(NewJobRecord {
            kind: JobKind::Train,
            input: Some("data/training".into()),
            profile: Some("anime".into()),
        })
        .await
        .expect("create job");

    assert_eq!(job.kind, JobKind::Train);
    assert_eq!(job.status.as_str(), "queued");
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
        .upsert_persona_runtime_config("stream", "sharp-playful", 0.45, 0.65, 0.20)
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
