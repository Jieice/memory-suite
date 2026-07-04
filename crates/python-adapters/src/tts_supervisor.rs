use std::{collections::HashSet, path::PathBuf, sync::OnceLock};

use anyhow::Result;
use api_types::{
    AdapterRecord, AdapterStartRequest, AdapterStatus, RuntimeEvent, RuntimeEventKind,
};
use orchestrator::RuntimeBus;
use storage::{NewAdapterRunRecord, Storage};
use tokio::process::Command;
use uuid::Uuid;

#[derive(Clone)]
pub struct TtsAdapterSupervisor {
    storage: Storage,
    python_executable: String,
    models_root: PathBuf,
    runtime_bus: RuntimeBus,
}

static SUPPORTED_ADAPTERS: OnceLock<HashSet<&'static str>> = OnceLock::new();

impl TtsAdapterSupervisor {
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
        SUPPORTED_ADAPTERS.get_or_init(|| HashSet::from(["edge_tts", "sovits"]))
    }

    pub async fn start_adapter(
        &self,
        adapter_id: &str,
        request: AdapterStartRequest,
    ) -> Result<AdapterRecord> {
        if !Self::supported_adapter_ids().contains(adapter_id) {
            let last_error =
                format!("unsupported adapter '{adapter_id}'; supported adapters: edge_tts, sovits");
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
            default_python_args(adapter_id, &self.models_root)
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
        for record in runs {
            if record.adapter_id != adapter_id || record.status != AdapterStatus::Running {
                continue;
            }

            let alive = adapter_pid_is_alive(record.pid);
            tracing::info!(
                adapter_id = %adapter_id,
                run_id = %record.id,
                pid = ?record.pid,
                alive,
                "checked running adapter candidate"
            );
            if alive {
                return Ok(Some(record));
            }

            let last_error = format!(
                "stale adapter run: process {} is no longer alive",
                record
                    .pid
                    .map(|pid| pid.to_string())
                    .unwrap_or_else(|| "<missing>".into())
            );
            tracing::warn!(
                adapter_id = %adapter_id,
                run_id = %record.id,
                pid = ?record.pid,
                error = %last_error,
                "marking stale adapter run as failed"
            );
            self.storage
                .update_adapter_run(
                    record.id,
                    AdapterStatus::Failed,
                    record.pid,
                    Some(last_error),
                )
                .await?;
        }
        Ok(None)
    }
}

fn adapter_pid_is_alive(pid: Option<u32>) -> bool {
    let Some(pid) = pid else {
        return false;
    };

    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "exit", "/B", "3"])
            .status();
        if matches!(status, Ok(status) if status.code().is_none()) {
            let _ = status;
        }

        match std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
        {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout.contains(&pid.to_string())
            }
            Err(_) => false,
        }
    }

    #[cfg(not(windows))]
    {
        let proc_path = std::path::Path::new("/proc").join(pid.to_string());
        proc_path.exists()
    }
}

fn default_python_args(adapter_id: &str, models_root: &std::path::Path) -> Vec<String> {
    let (relative_path, port) = match adapter_id {
        "edge_tts" => ("tts/edge_tts_server.py", 9881),
        "sovits" => ("tts/genie_api_server.py", 9880),
        _ => unreachable!("start_adapter validates supported adapters before resolving args"),
    };

    vec![
        resolve_adapter_script(models_root, relative_path),
        "--port".into(),
        port.to_string(),
    ]
}

#[cfg(test)]
fn default_python_script_path(adapter_id: &str, models_root: &std::path::Path) -> String {
    match adapter_id {
        "edge_tts" => resolve_adapter_script(models_root, "tts/edge_tts_server.py"),
        "sovits" => resolve_adapter_script(models_root, "tts/genie_api_server.py"),
        _ => unreachable!("script path helper only supports known adapters"),
    }
}

fn resolve_adapter_script(models_root: &std::path::Path, relative_path: &str) -> String {
    models_root
        .join(relative_path)
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        time::Duration,
    };

    use api_types::{AdapterStartRequest, AdapterStatus};
    use orchestrator::RuntimeBus;
    use storage::{NewAdapterRunRecord, Storage};
    use tempfile::tempdir;

    use super::{default_python_args, default_python_script_path, TtsAdapterSupervisor};

    #[test]
    fn edge_tts_script_path_resolves_from_models_root() {
        let models_root = Path::new("/tmp/runtime-python");
        assert_eq!(
            default_python_args("edge_tts", models_root),
            vec![
                default_python_script_path("edge_tts", models_root),
                "--port".into(),
                "9881".into(),
            ]
        );
    }

    #[test]
    fn sovits_script_path_resolves_from_models_root() {
        let models_root = Path::new("/tmp/runtime-python");
        assert_eq!(
            default_python_args("sovits", models_root),
            vec![
                default_python_script_path("sovits", models_root),
                "--port".into(),
                "9880".into(),
            ]
        );
    }

    #[tokio::test]
    async fn stale_running_adapter_record_is_not_reused() {
        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("memory-suite.db"))
            .await
            .expect("connect storage");
        let runtime_bus = RuntimeBus::new();
        let adapters = TtsAdapterSupervisor::new(
            storage.clone(),
            "powershell",
            PathBuf::from(dir.path().join("python")),
            runtime_bus,
        );

        let stale = storage
            .create_adapter_run(NewAdapterRunRecord {
                adapter_id: "edge_tts".into(),
                status: AdapterStatus::Running,
                python_executable: "powershell".into(),
                args: vec![
                    "-NoProfile".into(),
                    "-Command".into(),
                    "Start-Sleep -Seconds 10".into(),
                ],
                pid: Some(999_999),
                last_error: None,
            })
            .await
            .expect("create stale adapter run");

        let started = adapters
            .start_adapter(
                "edge_tts",
                AdapterStartRequest {
                    args: vec![
                        "-NoProfile".into(),
                        "-Command".into(),
                        "Start-Sleep -Seconds 10".into(),
                    ],
                },
            )
            .await
            .expect("start replacement adapter");

        assert_ne!(started.id, stale.id);

        let runs = storage.list_adapter_runs().await.expect("list runs");
        let stale_record = runs
            .iter()
            .find(|record| record.id == stale.id)
            .expect("stale record");
        assert_eq!(stale_record.status, AdapterStatus::Failed);
        assert!(stale_record
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("stale adapter run")));

        let running_edge_tts_runs = runs
            .iter()
            .filter(|record| {
                record.adapter_id == "edge_tts" && record.status == AdapterStatus::Running
            })
            .count();
        assert_eq!(running_edge_tts_runs, 1);

        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
