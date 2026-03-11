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
