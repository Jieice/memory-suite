use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use serde_json::{Value, json};
use storage::{NewConfigArtifactRecord, NewMemoryEntryRecord, NewUserProfileRecord};
use tempfile::tempdir;
use tower::ServiceExt;

#[tokio::test]
async fn exposes_knowledge_catalog_from_unified_storage() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18088,
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
        },
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
    })
    .await?;

    state
        .storage
        .upsert_user_profile(NewUserProfileRecord {
            user_id: "creator".into(),
            preferred_name: Some("Creator".into()),
            interaction_count: 12,
            updated_at: None,
        })
        .await?;
    state
        .storage
        .import_memory_entry(NewMemoryEntryRecord {
            user_id: "creator".into(),
            entry_type: "fact".into(),
            payload: json!({ "summary": "rust unified runtime" }),
            source: "tests".into(),
        })
        .await?;
    state
        .storage
        .import_config_artifact(NewConfigArtifactRecord {
            path: "config/app.toml.example".into(),
            kind: "json-config".into(),
            payload: json!({ "room_id": "123" }),
            copied_to: Some(
                runtime_root
                    .join("imports/config/danmaku.json")
                    .display()
                    .to_string(),
            ),
        })
        .await?;

    let app = build_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/knowledge/catalog?query=creator&limit=5")
                .body(Body::empty())?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let payload: Value = serde_json::from_slice(&body)?;

    assert_eq!(payload.get("limit").and_then(Value::as_u64), Some(5));
    assert_eq!(
        payload.get("query").and_then(Value::as_str),
        Some("creator")
    );
    assert_eq!(
        payload
            .get("profiles")
            .and_then(Value::as_array)
            .map(std::vec::Vec::len),
        Some(1)
    );
    assert_eq!(
        payload
            .get("memory_entries")
            .and_then(Value::as_array)
            .map(std::vec::Vec::len),
        Some(1)
    );
    assert_eq!(
        payload
            .get("config_artifacts")
            .and_then(Value::as_array)
            .map(std::vec::Vec::len),
        Some(0)
    );

    Ok(())
}



