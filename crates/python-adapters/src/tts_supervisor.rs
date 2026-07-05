use std::{collections::HashSet, path::PathBuf, sync::OnceLock};

use anyhow::{Context, Result};
use api_types::{AdapterStatus, RuntimeEvent, RuntimeEventKind};
use orchestrator::RuntimeBus;
use storage::{AdapterRunRecord, NewAdapterRunRecord, Storage};
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
        SUPPORTED_ADAPTERS.get_or_init(|| HashSet::from(["edge_tts", "sovits", "faster_whisper"]))
    }

    pub async fn start_adapter(&self, adapter_id: &str) -> Result<AdapterRunRecord> {
        if !Self::supported_adapter_ids().contains(adapter_id) {
            let last_error =
                format!(
                    "unsupported adapter '{adapter_id}'; supported adapters: edge_tts, sovits, faster_whisper"
                );
            self.storage
                .create_adapter_run(NewAdapterRunRecord {
                    adapter_id: adapter_id.to_string(),
                    status: AdapterStatus::Failed,
                    python_executable: self.python_executable.clone(),
                    args: Vec::new(),
                    pid: None,
                    last_error: Some(last_error.clone()),
                })
                .await?;
            return Err(anyhow::anyhow!(last_error));
        }

        if let Some(existing) = self.find_running_adapter(adapter_id).await? {
            return Ok(existing);
        }

        let args = default_python_args(adapter_id, &self.models_root);

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

    pub async fn list_runs(&self) -> Result<Vec<AdapterRunRecord>> {
        self.storage.list_adapter_runs().await
    }

    pub async fn stop_all_running_adapters(&self) -> Result<Vec<AdapterRunRecord>> {
        let runs = self.storage.list_adapter_runs().await?;
        let mut stopped = Vec::new();

        for record in runs {
            if record.status != AdapterStatus::Running {
                continue;
            }

            let Some(pid) = record.pid else {
                continue;
            };

            if !adapter_pid_is_alive(Some(pid)) {
                let updated = self
                    .storage
                    .update_adapter_run(
                        record.id,
                        AdapterStatus::Failed,
                        record.pid,
                        Some("adapter pid missing during shutdown cleanup".into()),
                    )
                    .await?;
                stopped.push(updated);
                continue;
            }

            match terminate_pid(pid) {
                Ok(()) => {
                    let updated = self
                        .storage
                        .update_adapter_run(record.id, AdapterStatus::Stopped, record.pid, None)
                        .await?;
                    stopped.push(updated);
                }
                Err(error) => {
                    let updated = self
                        .storage
                        .update_adapter_run(
                            record.id,
                            AdapterStatus::Failed,
                            record.pid,
                            Some(format!("failed to stop adapter during shutdown: {error}")),
                        )
                        .await?;
                    stopped.push(updated);
                }
            }
        }

        Ok(stopped)
    }

    async fn find_running_adapter(&self, adapter_id: &str) -> Result<Option<AdapterRunRecord>> {
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

fn terminate_pid(pid: u32) -> Result<()> {
    #[cfg(windows)]
    {
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .context("run taskkill for adapter pid")?;

        if !status.success() {
            anyhow::bail!("taskkill returned non-zero status for pid {pid}: {status}");
        }

        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let status = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .context("run kill for adapter pid")?;

        if !status.success() {
            anyhow::bail!("kill returned non-zero status for pid {pid}: {status}");
        }

        Ok(())
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
        "faster_whisper" => ("stt/faster_whisper_server.py", 9882),
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
        "faster_whisper" => resolve_adapter_script(models_root, "stt/faster_whisper_server.py"),
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

    use api_types::AdapterStatus;
    use orchestrator::RuntimeBus;
    use storage::{NewAdapterRunRecord, Storage};
    use tempfile::tempdir;

    use super::{default_python_args, default_python_script_path, TtsAdapterSupervisor};

    async fn write_placeholder_tts_scripts(models_root: &Path) {
        let tts_root = models_root.join("tts");
        tokio::fs::create_dir_all(&tts_root)
            .await
            .expect("create placeholder tts root");
        let script = "import time\ntime.sleep(1)\n";
        tokio::fs::write(tts_root.join("edge_tts_server.py"), script)
            .await
            .expect("write placeholder edge_tts script");
        tokio::fs::write(tts_root.join("genie_api_server.py"), script)
            .await
            .expect("write placeholder genie script");
    }

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
        let models_root = dir.path().join("python");
        write_placeholder_tts_scripts(&models_root).await;
        let storage = Storage::connect(&dir.path().join("memory-suite.db"))
            .await
            .expect("connect storage");
        let runtime_bus = RuntimeBus::new();
        let adapters = TtsAdapterSupervisor::new(
            storage.clone(),
            "python",
            PathBuf::from(&models_root),
            runtime_bus,
        );

        let stale = storage
            .create_adapter_run(NewAdapterRunRecord {
                adapter_id: "edge_tts".into(),
                status: AdapterStatus::Running,
                python_executable: "python".into(),
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
            .start_adapter("edge_tts")
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
