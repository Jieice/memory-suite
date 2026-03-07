use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, PythonConfig, ServerConfig, StorageConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use serde_json::Value;
use storage::{
    NewConfigArtifactRecord, NewJobRecord, NewLegacyEventRecord, NewMemoryEntryRecord,
    NewMessageRecord, NewUserProfileRecord,
};
use tempfile::tempdir;
use tower::ServiceExt;

#[tokio::test]
async fn exposes_runtime_overview_jobs_and_session_messages() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18082,
        },
        storage: StorageConfig {
            database_path: runtime_root
                .join("memory-suite.db")
                .to_string_lossy()
                .to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: PythonConfig {
            executable: "python".into(),
            models_root: dir.path().join("python").to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
            enable_legacy_import: true,
        },
    })
    .await?;

    state
        .storage
        .append_message(NewMessageRecord {
            session_id: "session-read".into(),
            role: api_types::MessageRole::User,
            text: "hello".into(),
        })
        .await?;
    state
        .storage
        .create_job(NewJobRecord {
            kind: api_types::JobKind::Train,
            input: Some("data/training".into()),
            profile: Some("anime".into()),
        })
        .await?;
    state
        .storage
        .upsert_user_profile(NewUserProfileRecord {
            user_id: "viewer".into(),
            preferred_name: Some("Alpha".into()),
            interaction_count: 5,
            updated_at: None,
        })
        .await?;
    state
        .storage
        .import_memory_entry(NewMemoryEntryRecord {
            user_id: "viewer".into(),
            entry_type: "fact".into(),
            payload: serde_json::json!({"topic":"anime"}),
            source: "test".into(),
        })
        .await?;
    state
        .storage
        .import_legacy_event(NewLegacyEventRecord {
            source_path: "data/proactive-memory.jsonl".into(),
            source_type: "proactive-memory".into(),
            payload: serde_json::json!({"query":"hello"}),
        })
        .await?;
    state
        .storage
        .import_config_artifact(NewConfigArtifactRecord {
            path: "memory-danmaku/config.example.json".into(),
            kind: "json-config".into(),
            payload: serde_json::json!({"roomId":123}),
            copied_to: None,
        })
        .await?;

    let app = build_router(state);

    let overview = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/runtime/overview")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(overview.status(), StatusCode::OK);

    let jobs = app
        .clone()
        .oneshot(Request::builder().uri("/api/jobs").body(Body::empty())?)
        .await?;
    assert_eq!(jobs.status(), StatusCode::OK);

    let messages = app
        .oneshot(
            Request::builder()
                .uri("/api/sessions/session-read/messages")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(messages.status(), StatusCode::OK);

    let body = axum::body::to_bytes(messages.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;
    assert_eq!(payload.as_array().map(|items| items.len()), Some(1));

    Ok(())
}
