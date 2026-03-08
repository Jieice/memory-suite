use std::{collections::HashSet, path::PathBuf, sync::OnceLock};

use anyhow::Result;
use api_types::{
    AdapterRecord, AdapterStartRequest, AdapterStatus, RuntimeEvent, RuntimeEventKind,
};
use orchestrator::RuntimeBus;
use serde_json::Value;
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

static SUPPORTED_ADAPTERS: OnceLock<HashSet<&'static str>> = OnceLock::new();

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

    pub fn supported_adapter_ids() -> &'static HashSet<&'static str> {
        SUPPORTED_ADAPTERS.get_or_init(|| HashSet::from(["edge_tts", "sovits", "train", "eval"]))
    }

    pub async fn start_adapter(
        &self,
        adapter_id: &str,
        request: AdapterStartRequest,
    ) -> Result<AdapterRecord> {
        if !Self::supported_adapter_ids().contains(adapter_id) {
            let last_error = format!(
                "unsupported adapter '{adapter_id}'; supported adapters: edge_tts, sovits, train, eval"
            );
            self.storage
                .create_adapter_run(NewAdapterRunRecord {
                    adapter_id: adapter_id.to_string(),
                    status: AdapterStatus::Failed,
                    python_executable: self.python_executable.clone(),
                    args: request.args,
                    pid: None,
                    last_error: Some(last_error.clone()),
                })
                .await?;
            return Err(anyhow::anyhow!(last_error));
        }

        if let Some(existing) = self.find_running_adapter(adapter_id).await? {
            return Ok(existing);
        }

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

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let last_error = format!("failed to start adapter {adapter_id}: {error}");
                self.storage
                    .create_adapter_run(NewAdapterRunRecord {
                        adapter_id: adapter_id.to_string(),
                        status: AdapterStatus::Failed,
                        python_executable: self.python_executable.clone(),
                        args,
                        pid: None,
                        last_error: Some(last_error.clone()),
                    })
                    .await?;
                return Err(anyhow::anyhow!(last_error)
                    .context(format!("failed to start adapter {adapter_id}")));
            }
        };
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

    async fn find_running_adapter(&self, adapter_id: &str) -> Result<Option<AdapterRecord>> {
        let runs = self.storage.list_adapter_runs().await?;
        Ok(runs.into_iter().find(|record| {
            record.adapter_id == adapter_id && record.status == AdapterStatus::Running
        }))
    }
}

async fn process_is_alive(pid: u32) -> Result<bool> {
    #[cfg(target_os = "windows")]
    {
        let filter = format!("tasklist /FI \"PID eq {pid}\" /NH");
        let output = Command::new("cmd").args(["/C", &filter]).output().await?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
        return Ok(output.status.success()
            && stdout.contains(&pid.to_string())
            && !stdout.contains("no tasks are running"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let status = Command::new("sh")
            .args(["-c", &format!("kill -0 {pid}")])
            .status()
            .await?;
        Ok(status.success())
    }
}

fn default_args(adapter_id: &str, python_executable: &str) -> Vec<String> {
    if let Some(args) = adapter_args_from_env(adapter_id) {
        return args;
    }

    let executable = python_executable.to_ascii_lowercase();
    if executable.contains("powershell") || executable.ends_with("pwsh") {
        default_powershell_args(adapter_id)
    } else {
        default_python_args(adapter_id)
    }
}

fn default_sleep_seconds(adapter_id: &str) -> u32 {
    match adapter_id {
        "tts" => 300,
        "train" | "eval" => 30,
        _ => 10,
    }
}

fn default_python_args(adapter_id: &str) -> Vec<String> {
    match adapter_id {
        "edge_tts" => vec!["tts/edge_tts_server.py".into()],
        "sovits" => vec!["tts/genie_api_server.py".into()],
        "train" => vec!["adapters/train_adapter.py".into()],
        "eval" => vec!["adapters/eval_adapter.py".into()],
        _ => vec![
            "-c".into(),
            format!(
                "import time; print('starting {adapter_id}'); time.sleep({})",
                default_sleep_seconds(adapter_id)
            ),
        ],
    }
}

fn default_powershell_args(adapter_id: &str) -> Vec<String> {
    vec![
        "-NoProfile".into(),
        "-Command".into(),
        format!("Start-Sleep -Seconds {}", default_sleep_seconds(adapter_id)),
    ]
}

fn adapter_args_from_env(adapter_id: &str) -> Option<Vec<String>> {
    let key = format!(
        "MEMORY_SUITE_ADAPTER_{}_ARGS_JSON",
        adapter_id.to_ascii_uppercase().replace('-', "_")
    );
    let raw = std::env::var(&key).ok()?;
    let parsed = serde_json::from_str::<Value>(&raw).ok()?;
    let values = parsed.as_array()?;
    let args = values
        .iter()
        .filter_map(|value| value.as_str().map(ToOwned::to_owned))
        .collect::<Vec<_>>();
    (!args.is_empty()).then_some(args)
}

#[cfg(test)]
mod tests {
    use super::{default_powershell_args, default_python_args};

    #[test]
    fn train_and_eval_default_to_real_python_scripts() {
        assert_eq!(
            default_python_args("train"),
            vec!["adapters/train_adapter.py"]
        );
        assert_eq!(
            default_python_args("eval"),
            vec!["adapters/eval_adapter.py"]
        );
    }

    #[test]
    fn powershell_fallback_keeps_long_running_process_shape() {
        let train = default_powershell_args("train");
        let eval = default_powershell_args("eval");
        assert!(train.join(" ").contains("Start-Sleep"));
        assert!(eval.join(" ").contains("Start-Sleep"));
    }
}
