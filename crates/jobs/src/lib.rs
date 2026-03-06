pub mod python_adapter;

use anyhow::Result;
use api_types::{JobKind, JobRequest, JobResponse, RuntimeEvent, RuntimeEventKind};
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
    pub fn new(storage: Storage, adapters: PythonAdapterSupervisor, runtime_bus: RuntimeBus) -> Self {
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
        match self
            .adapters
            .start_adapter(
                &adapter_id,
                api_types::AdapterStartRequest { args: Vec::new() },
            )
            .await
        {
            Ok(adapter) => {
                let updated = self
                    .storage
                    .update_job_state(
                        job.id,
                        "running",
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
                        "failed",
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
                        let _ = storage
                            .update_job_state(
                                job_id,
                                "completed",
                                Some(&adapter.adapter_id),
                                None,
                                Some(Utc::now()),
                                None,
                            )
                            .await;
                        break;
                    }
                    Ok(adapter) if adapter.status == api_types::AdapterStatus::Failed => {
                        let _ = storage
                            .update_job_state(
                                job_id,
                                "failed",
                                Some(&adapter.adapter_id),
                                None,
                                Some(Utc::now()),
                                adapter.last_error.as_deref(),
                            )
                            .await;
                        break;
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });
    }
}
