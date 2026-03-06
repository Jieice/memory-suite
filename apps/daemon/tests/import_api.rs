use std::fs;

use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, PythonConfig, ServerConfig, StorageConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use tempfile::tempdir;
use tower::ServiceExt;

fn write_file(path: &std::path::Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent directories");
    }
    fs::write(path, contents).expect("write file");
}

#[tokio::test]
async fn exposes_legacy_import_over_http() -> Result<()> {
    let dir = tempdir()?;
    let old_root = dir.path().join("legacy");
    let runtime_root = dir.path().join("runtime");

    write_file(
        &old_root.join("data/canonical-memory.json"),
        r#"{"version":1,"users":{"viewer":{"userId":"viewer","facts":[],"preferences":[],"tasks":[],"conflicts":[],"interactionCount":1}}}"#,
    );

    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18081,
        },
        storage: StorageConfig {
            database_path: runtime_root.join("memory-suite.db").to_string_lossy().to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: PythonConfig {
            executable: "python".into(),
            models_root: old_root.join("python").to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
            enable_legacy_import: true,
        },
    })
    .await?;

    let app = build_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/import/legacy")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({ "root": old_root.display().to_string() }).to_string()))?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}
