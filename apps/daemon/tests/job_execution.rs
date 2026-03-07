use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, PythonConfig, ServerConfig, StorageConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use tempfile::tempdir;
use tokio::time::{Duration, sleep};
use tower::ServiceExt;

#[tokio::test]
async fn starts_train_and_eval_jobs_through_supervised_adapters() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18086,
        },
        storage: StorageConfig {
            database_path: runtime_root
                .join("memory-suite.db")
                .to_string_lossy()
                .to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: PythonConfig {
            executable: "powershell".into(),
            models_root: dir.path().join("python").to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
            enable_legacy_import: true,
        },
    })
    .await?;

    let app = build_router(state.clone());

    let train = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/jobs/train")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"input":"training/demo","profile":"anime"}"#))?,
        )
        .await?;
    assert_eq!(train.status(), StatusCode::OK);

    let eval = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/jobs/eval")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"input":"eval/intelligence/dataset.v2.json","profile":"smoke"}"#,
                ))?,
        )
        .await?;
    assert_eq!(eval.status(), StatusCode::OK);

    sleep(Duration::from_millis(150)).await;

    let jobs = state.storage.list_jobs().await?;
    assert_eq!(jobs.len(), 2);

    let train_job = jobs
        .iter()
        .find(|job| job.kind == api_types::JobKind::Train)
        .expect("train job");
    assert_eq!(train_job.status, "running");
    assert_eq!(train_job.adapter_id.as_deref(), Some("train"));
    assert!(train_job.started_at.is_some());

    let eval_job = jobs
        .iter()
        .find(|job| job.kind == api_types::JobKind::Eval)
        .expect("eval job");
    assert_eq!(eval_job.status, "running");
    assert_eq!(eval_job.adapter_id.as_deref(), Some("eval"));
    assert!(eval_job.started_at.is_some());

    Ok(())
}
