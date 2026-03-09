pub mod python_adapter;

use anyhow::Result;
use api_types::{JobKind, JobRequest, JobResponse, JobStatus, RuntimeEvent, RuntimeEventKind};
use chrono::Utc;
use orchestrator::RuntimeBus;
use std::time::Duration;
use storage::{NewJobRecord, Storage};
use tokio::time::sleep;

pub use python_adapter::PythonAdapterSupervisor;

#[derive(Clone)]
pub struct JobService {
    storage: Storage,
    adapters: PythonAdapterSupervisor,
    runtime_bus: RuntimeBus,
}

impl JobService {
    pub fn new(
        storage: Storage,
        adapters: PythonAdapterSupervisor,
        runtime_bus: RuntimeBus,
    ) -> Self {
        Self {
            storage,
            adapters,
            runtime_bus,
        }
    }

    pub async fn create_job(&self, kind: JobKind, request: JobRequest) -> Result<JobResponse> {
        let job = self
            .storage
            .create_job(NewJobRecord {
                kind: kind.clone(),
                input: request.input,
                profile: request.profile,
            })
            .await?;
        self.runtime_bus.publish(RuntimeEvent {
            id: uuid::Uuid::new_v4(),
            kind: RuntimeEventKind::JobQueued,
            source: kind.as_str().to_string(),
            detail: Some(job.id.to_string()),
            created_at: job.created_at,
        });
        let adapter_id = kind.as_str().to_string();
        let adapter_args = job_adapter_args(&job);
        match self
            .adapters
            .start_adapter(
                &adapter_id,
                api_types::AdapterStartRequest { args: adapter_args },
            )
            .await
        {
            Ok(adapter) => {
                let updated = self
                    .storage
                    .update_job_state(
                        job.id,
                        JobStatus::Running,
                        Some(&adapter_id),
                        Some(Utc::now()),
                        None,
                        None,
                    )
                    .await?;
                self.track_job_completion(job.id, adapter.id);
                Ok(JobResponse {
                    job_id: updated.id,
                    kind,
                    status: updated.status,
                    adapter_id: updated.adapter_id,
                    started_at: updated.started_at,
                    created_at: updated.created_at,
                })
            }
            Err(error) => {
                let updated = self
                    .storage
                    .update_job_state(
                        job.id,
                        JobStatus::Failed,
                        Some(&adapter_id),
                        None,
                        Some(Utc::now()),
                        Some(&error.to_string()),
                    )
                    .await?;
                Ok(JobResponse {
                    job_id: updated.id,
                    kind,
                    status: updated.status,
                    adapter_id: updated.adapter_id,
                    started_at: updated.started_at,
                    created_at: updated.created_at,
                })
            }
        }
    }

    fn track_job_completion(&self, job_id: uuid::Uuid, adapter_run_id: uuid::Uuid) {
        let storage = self.storage.clone();
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_millis(250)).await;
                match storage.get_adapter_run(adapter_run_id).await {
                    Ok(adapter) if adapter.status == api_types::AdapterStatus::Stopped => {
                        if let Ok(job) = storage.get_job(job_id).await {
                            let _ = storage
                                .update_job_state(
                                    job_id,
                                    JobStatus::Completed,
                                    Some(&adapter.adapter_id),
                                    job.started_at,
                                    Some(Utc::now()),
                                    None,
                                )
                                .await;
                        }
                        break;
                    }
                    Ok(adapter) if adapter.status == api_types::AdapterStatus::Failed => {
                        if let Ok(job) = storage.get_job(job_id).await {
                            let _ = storage
                                .update_job_state(
                                    job_id,
                                    JobStatus::Failed,
                                    Some(&adapter.adapter_id),
                                    job.started_at,
                                    Some(Utc::now()),
                                    adapter.last_error.as_deref(),
                                )
                                .await;
                        }
                        break;
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });
    }
}

fn job_adapter_args(job: &api_types::JobRecord) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(input) = job.input.as_deref().filter(|value| !value.is_empty()) {
        args.push("--input".into());
        args.push(input.to_string());
    }
    if let Some(profile) = job.profile.as_deref().filter(|value| !value.is_empty()) {
        args.push("--profile".into());
        args.push(profile.to_string());
    }
    args
}

#[cfg(test)]
mod tests {
    use super::JobService;
    use api_types::{AdapterStartRequest, AdapterStatus, JobKind, JobRequest, JobStatus};
    use orchestrator::RuntimeBus;
    use std::{path::PathBuf, time::Duration};
    use storage::Storage;
    use tempfile::tempdir;

    #[tokio::test]
    async fn job_enters_terminal_state_when_adapter_stops() {
        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("memory-suite.db"))
            .await
            .expect("connect storage");
        let runtime_bus = RuntimeBus::new();
        let adapters = super::PythonAdapterSupervisor::new(
            storage.clone(),
            "powershell",
            PathBuf::from(dir.path().join("python")),
            runtime_bus.clone(),
        );
        let service = JobService::new(storage.clone(), adapters, runtime_bus);

        let response = service
            .create_job(
                JobKind::Train,
                JobRequest {
                    input: Some("training/demo".into()),
                    profile: Some("anime".into()),
                },
            )
            .await
            .expect("create job");

        let running = storage.get_job(response.job_id).await.expect("running job");
        assert_eq!(running.status, JobStatus::Running);

        let adapter_run = storage
            .list_adapter_runs()
            .await
            .expect("list adapter runs")
            .into_iter()
            .find(|record| record.adapter_id == "train")
            .expect("train adapter run");

        storage
            .update_adapter_run(adapter_run.id, AdapterStatus::Stopped, adapter_run.pid, None)
            .await
            .expect("stop adapter run");

        tokio::time::sleep(Duration::from_millis(350)).await;

        let completed = storage.get_job(response.job_id).await.expect("completed job");
        assert_eq!(completed.status, JobStatus::Completed);
        assert!(completed.finished_at.is_some());
        assert_eq!(completed.adapter_id.as_deref(), Some("train"));
    }

    #[tokio::test]
    async fn duplicate_running_adapter_is_rejected_or_reused_consistently() {
        let dir = tempdir().expect("tempdir");
        let storage = Storage::connect(&dir.path().join("memory-suite.db"))
            .await
            .expect("connect storage");
        let runtime_bus = RuntimeBus::new();
        let adapters = super::PythonAdapterSupervisor::new(
            storage.clone(),
            "powershell",
            PathBuf::from(dir.path().join("python")),
            runtime_bus,
        );

        let first = adapters
            .start_adapter("train", AdapterStartRequest { args: Vec::new() })
            .await
            .expect("start first adapter");

        let second = adapters
            .start_adapter("train", AdapterStartRequest { args: Vec::new() })
            .await
            .expect("start second adapter");

        assert_eq!(second.id, first.id);

        let runs = storage.list_adapter_runs().await.expect("list runs");
        let running_train_runs = runs
            .iter()
            .filter(|record| {
                record.adapter_id == "train" && record.status == AdapterStatus::Running
            })
            .count();
        assert_eq!(running_train_runs, 1);
    }
}
