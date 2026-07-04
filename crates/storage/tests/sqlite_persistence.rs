use api_types::MessageRole;
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

    let default_state = storage
        .get_persona_runtime_state()
        .await
        .expect("default persona state");
    assert_eq!(default_state.mode, "stream");
    assert_eq!(default_state.tone_profile, "balanced");
    assert_eq!(default_state.current_context, "idle");
    assert_eq!(default_state.current_mood, "neutral");
    assert_eq!(default_state.fallback.builtin_fallbacks, 0);
    assert_eq!(default_state.fallback.last_path, "none");

    storage
        .upsert_persona_runtime_config(
            "stream",
            "sharp-playful",
            0.45,
            0.65,
            0.20,
            "explaining",
            "curious",
        )
        .await
        .expect("upsert persona config");

    storage
        .bump_fallback_stat("builtin")
        .await
        .expect("bump builtin fallback");

    let state = storage
        .get_persona_runtime_state()
        .await
        .expect("persona state after update");
    assert_eq!(state.tone_profile, "sharp-playful");
    assert_eq!(state.current_context, "explaining");
    assert_eq!(state.current_mood, "curious");
    assert_eq!(state.fallback.builtin_fallbacks, 1);
    assert_eq!(state.fallback.last_path, "builtin");

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
