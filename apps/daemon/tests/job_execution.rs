use anyhow::Result;
use api_types::JobStatus;
use app_config::{AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use daemon::{AppState, build_router};
use serde_json::Value;
use tempfile::tempdir;
use tokio::time::{Duration, sleep};
use tower::ServiceExt;

#[tokio::test]
async fn starts_train_and_eval_jobs_through_real_python_adapters() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let python_root = dir.path().join("python");
    let adapters_root = python_root.join("adapters");
    tokio::fs::create_dir_all(&adapters_root).await?;
    tokio::fs::create_dir_all(runtime_root.join("training")).await?;
    tokio::fs::create_dir_all(runtime_root.join("eval").join("intelligence")).await?;
    tokio::fs::write(runtime_root.join("training").join("demo.txt"), "demo").await?;
    tokio::fs::write(
        runtime_root
            .join("eval")
            .join("intelligence")
            .join("dataset.v2.json"),
        r#"[{"prompt":"hello","expect":{"ok":true}}]"#,
    )
    .await?;
    tokio::fs::write(
        adapters_root.join("train_adapter.py"),
        r#"
import argparse
import json
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--input", default="")
parser.add_argument("--profile", default="")
args = parser.parse_args()

time.sleep(0.2)
report_dir = Path.cwd().parent / "runtime" / "reports" / "train"
report_dir.mkdir(parents=True, exist_ok=True)
(report_dir / "train.json").write_text(
    json.dumps({"input": args.input, "profile": args.profile}),
    encoding="utf-8",
)
"#,
    )
    .await?;
    tokio::fs::write(
        adapters_root.join("eval_adapter.py"),
        r#"
import argparse
import json
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--input", default="")
parser.add_argument("--profile", default="")
args = parser.parse_args()

time.sleep(0.2)
report_dir = Path.cwd().parent / "runtime" / "reports" / "eval"
report_dir.mkdir(parents=True, exist_ok=True)
(report_dir / "eval.json").write_text(
    json.dumps({"input": args.input, "profile": args.profile}),
    encoding="utf-8",
)
"#,
    )
    .await?;

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
            executable: "python".into(),
            models_root: python_root.to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
            enable_legacy_import: false,
        },
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
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
                .body(Body::from(r#"{"input":"training/demo.txt","profile":"anime"}"#))?,
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

    sleep(Duration::from_millis(900)).await;

    let jobs = state.storage.list_jobs().await?;
    assert_eq!(jobs.len(), 2);

    let train_job = jobs
        .iter()
        .find(|job| job.kind == api_types::JobKind::Train)
        .expect("train job");
    assert_eq!(train_job.status, JobStatus::Completed);
    assert_eq!(train_job.adapter_id.as_deref(), Some("train"));
    assert!(train_job.started_at.is_some());
    assert!(train_job.finished_at.is_some());

    let eval_job = jobs
        .iter()
        .find(|job| job.kind == api_types::JobKind::Eval)
        .expect("eval job");
    assert_eq!(eval_job.status, JobStatus::Completed);
    assert_eq!(eval_job.adapter_id.as_deref(), Some("eval"));
    assert!(eval_job.started_at.is_some());
    assert!(eval_job.finished_at.is_some());

    let train_report: Value = serde_json::from_str(
        &tokio::fs::read_to_string(runtime_root.join("reports").join("train").join("train.json"))
            .await?,
    )?;
    assert_eq!(train_report.get("input").and_then(Value::as_str), Some("training/demo.txt"));
    assert_eq!(train_report.get("profile").and_then(Value::as_str), Some("anime"));

    let eval_report: Value = serde_json::from_str(
        &tokio::fs::read_to_string(runtime_root.join("reports").join("eval").join("eval.json"))
            .await?,
    )?;
    assert_eq!(eval_report.get("input").and_then(Value::as_str), Some("eval/intelligence/dataset.v2.json"));
    assert_eq!(eval_report.get("profile").and_then(Value::as_str), Some("smoke"));

    Ok(())
}

#[tokio::test]
async fn passes_job_input_and_profile_to_real_train_adapter() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let python_root = dir.path().join("python");
    let adapters_root = python_root.join("adapters");
    tokio::fs::create_dir_all(&adapters_root).await?;
    tokio::fs::create_dir_all(runtime_root.join("training")).await?;
    tokio::fs::write(runtime_root.join("training").join("demo.txt"), "demo").await?;
    tokio::fs::write(
        adapters_root.join("train_adapter.py"),
        r#"
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--input", default="")
parser.add_argument("--profile", default="")
args = parser.parse_args()

report_dir = Path.cwd().parent / "runtime" / "reports" / "train"
report_dir.mkdir(parents=True, exist_ok=True)
(report_dir / "args.json").write_text(
    json.dumps({"input": args.input, "profile": args.profile}),
    encoding="utf-8",
)
"#,
    )
    .await?;

    let state = AppState::from_config(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18087,
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
            models_root: python_root.to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
            enable_legacy_import: false,
        },
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
    })
    .await?;

    let app = build_router(state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/jobs/train")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"input":"training/demo.txt","profile":"anime"}"#))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    sleep(Duration::from_millis(600)).await;

    let report_path = runtime_root.join("reports").join("train").join("args.json");
    let report = tokio::fs::read_to_string(&report_path).await?;
    let payload: Value = serde_json::from_str(&report)?;
    assert_eq!(payload.get("input").and_then(Value::as_str), Some("training/demo.txt"));
    assert_eq!(payload.get("profile").and_then(Value::as_str), Some("anime"));

    Ok(())
}

#[tokio::test]
async fn exposes_real_job_and_adapter_state_over_http() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let python_root = dir.path().join("python");
    let adapters_root = python_root.join("adapters");
    tokio::fs::create_dir_all(&adapters_root).await?;
    tokio::fs::create_dir_all(runtime_root.join("training")).await?;
    tokio::fs::write(runtime_root.join("training").join("demo.txt"), "demo").await?;
    tokio::fs::write(
        adapters_root.join("train_adapter.py"),
        r#"
import argparse
import time

parser = argparse.ArgumentParser()
parser.add_argument("--input", default="")
parser.add_argument("--profile", default="")
parser.parse_args()
time.sleep(0.2)
"#,
    )
    .await?;

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
            models_root: python_root.to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
            enable_legacy_import: false,
        },
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
    })
    .await?;

    let app = build_router(state.clone());
    let start = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/jobs/train")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"input":"training/demo.txt","profile":"anime"}"#))?,
        )
        .await?;
    assert_eq!(start.status(), StatusCode::OK);

    sleep(Duration::from_millis(700)).await;

    let jobs = app
        .clone()
        .oneshot(Request::builder().uri("/api/jobs").body(Body::empty())?)
        .await?;
    assert_eq!(jobs.status(), StatusCode::OK);
    let jobs_body = axum::body::to_bytes(jobs.into_body(), usize::MAX).await?;
    let jobs_payload: Value = serde_json::from_slice(&jobs_body)?;
    let jobs = jobs_payload.as_array().expect("jobs payload");
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].get("kind").and_then(Value::as_str), Some("train"));
    assert_eq!(jobs[0].get("status").and_then(Value::as_str), Some("completed"));
    assert_eq!(jobs[0].get("adapter_id").and_then(Value::as_str), Some("train"));
    assert!(jobs[0].get("started_at").and_then(Value::as_str).is_some());
    assert!(jobs[0].get("finished_at").and_then(Value::as_str).is_some());

    let adapters = app
        .oneshot(
            Request::builder()
                .uri("/api/runtime/adapters")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(adapters.status(), StatusCode::OK);
    let adapters_body = axum::body::to_bytes(adapters.into_body(), usize::MAX).await?;
    let adapters_payload: Value = serde_json::from_slice(&adapters_body)?;
    let adapters = adapters_payload.as_array().expect("adapters payload");
    assert_eq!(adapters.len(), 1);
    assert_eq!(adapters[0].get("adapter_id").and_then(Value::as_str), Some("train"));
    assert_eq!(adapters[0].get("status").and_then(Value::as_str), Some("stopped"));

    let args = adapters[0]
        .get("args")
        .and_then(Value::as_array)
        .expect("adapter args");
    let args = args.iter().filter_map(Value::as_str).collect::<Vec<_>>();
    assert_eq!(
        args,
        vec![
            "adapters/train_adapter.py",
            "--input",
            "training/demo.txt",
            "--profile",
            "anime",
        ]
    );

    Ok(())
}



