use std::path::PathBuf;

use anyhow::{Context, Result};
use api_types::{
    AdapterRecord, AdapterStartRequest, AdapterStatus, RuntimeEvent, RuntimeEventKind,
};
use orchestrator::RuntimeBus;
use storage::{NewAdapterRunRecord, Storage};
use tokio::process::Command;
use uuid::Uuid;

#[derive(Clone)]
pub struct PythonAdapterSupervisor {
    storage: Storage,
    python_executable: String,
    models_root: PathBuf,
    runtime_bus: RuntimeBus,
}

impl PythonAdapterSupervisor {
    pub fn new(
        storage: Storage,
        python_executable: impl Into<String>,
        models_root: PathBuf,
        runtime_bus: RuntimeBus,
    ) -> Self {
        Self {
            storage,
            python_executable: python_executable.into(),
            models_root,
            runtime_bus,
        }
    }

    pub async fn start_adapter(
        &self,
        adapter_id: &str,
        request: AdapterStartRequest,
    ) -> Result<AdapterRecord> {
        let args = if request.args.is_empty() {
            default_args(adapter_id, &self.python_executable)
        } else {
            request.args
        };

        let mut command = Command::new(&self.python_executable);
        command.args(&args);
        if self.models_root.exists() {
            command.current_dir(&self.models_root);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("failed to start adapter {adapter_id}"))?;
        let pid = child.id();

        let record = self
            .storage
            .create_adapter_run(NewAdapterRunRecord {
                adapter_id: adapter_id.to_string(),
                status: AdapterStatus::Running,
                python_executable: self.python_executable.clone(),
                args,
                pid,
                last_error: None,
            })
            .await?;
        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::AdapterStarted,
            source: record.adapter_id.clone(),
            detail: record.pid.map(|pid| pid.to_string()),
            created_at: record.started_at,
        });

        let storage = self.storage.clone();
        let run_id = record.id;
        tokio::spawn(async move {
            match child.wait().await {
                Ok(exit_status) if exit_status.success() => {
                    let _ = storage
                        .update_adapter_run(run_id, AdapterStatus::Stopped, pid, None)
                        .await;
                }
                Ok(exit_status) => {
                    let _ = storage
                        .update_adapter_run(
                            run_id,
                            AdapterStatus::Failed,
                            pid,
                            Some(format!("adapter exited with status {exit_status}")),
                        )
                        .await;
                }
                Err(error) => {
                    let _ = storage
                        .update_adapter_run(
                            run_id,
                            AdapterStatus::Failed,
                            pid,
                            Some(format!("failed to wait for adapter process: {error}")),
                        )
                        .await;
                }
            }
        });

        Ok(record)
    }

    pub async fn list_runs(&self) -> Result<Vec<AdapterRecord>> {
        self.storage.list_adapter_runs().await
    }
}

fn default_args(adapter_id: &str, python_executable: &str) -> Vec<String> {
    let executable = python_executable.to_ascii_lowercase();
    if executable.contains("powershell") || executable.ends_with("pwsh") {
        vec![
            "-NoProfile".into(),
            "-Command".into(),
            format!("Start-Sleep -Seconds {}", default_sleep_seconds(adapter_id)),
        ]
    } else {
        vec![
            "-c".into(),
            format!(
                "import time; print('starting {adapter_id}'); time.sleep({})",
                default_sleep_seconds(adapter_id)
            ),
        ]
    }
}

fn default_sleep_seconds(adapter_id: &str) -> u32 {
    match adapter_id {
        "tts" => 300,
        "train" | "eval" => 30,
        _ => 10,
    }
}
