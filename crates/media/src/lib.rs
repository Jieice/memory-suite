use anyhow::Result;
use api_types::{AdapterStartRequest, RuntimeEvent, RuntimeEventKind, TtsSpeakRequest, TtsSpeakResponse};
use jobs::PythonAdapterSupervisor;
use orchestrator::RuntimeBus;
use storage::{NewTtsRecord, Storage};
use uuid::Uuid;

#[derive(Clone)]
pub struct TtsService {
    storage: Storage,
    adapters: PythonAdapterSupervisor,
    runtime_bus: RuntimeBus,
    enable_mock_tts: bool,
}

impl TtsService {
    pub fn new(
        storage: Storage,
        adapters: PythonAdapterSupervisor,
        runtime_bus: RuntimeBus,
        enable_mock_tts: bool,
    ) -> Self {
        Self {
            storage,
            adapters,
            runtime_bus,
            enable_mock_tts,
        }
    }

    pub async fn enqueue(&self, request: TtsSpeakRequest) -> Result<TtsSpeakResponse> {
        let session_id = request
            .session_id
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let adapter_id = select_tts_adapter(request.voice.as_deref());
        let record = self
            .storage
            .enqueue_tts(NewTtsRecord {
                session_id,
                text: request.text,
                voice: request.voice,
            })
            .await?;

        match self
            .adapters
            .start_adapter(
                adapter_id,
                AdapterStartRequest {
                    args: Vec::new(),
                },
            )
            .await
        {
            Ok(_) => {
                let _ = self
                    .storage
                    .update_tts_dispatch(record.id, "dispatching", Some(adapter_id))
                    .await?;
                self.runtime_bus.publish(RuntimeEvent {
                    id: Uuid::new_v4(),
                    kind: RuntimeEventKind::TtsQueued,
                    source: adapter_id.to_string(),
                    detail: Some(record.id.to_string()),
                    created_at: record.created_at,
                });
            }
            Err(error) if self.enable_mock_tts => {
                let _ = self
                    .storage
                    .update_tts_dispatch(record.id, "mocked", Some(adapter_id))
                    .await?;
                tracing::warn!("falling back to mock tts dispatch: {error}");
            }
            Err(error) => return Err(error),
        }

        Ok(TtsSpeakResponse {
            request_id: record.id,
            status: record.status,
            audio_path: record.audio_path,
            created_at: record.created_at,
        })
    }
}

fn select_tts_adapter(voice: Option<&str>) -> &'static str {
    let Some(voice) = voice else {
        return "edge_tts";
    };
    if voice.to_ascii_lowercase().contains("sovits") {
        "sovits"
    } else {
        "edge_tts"
    }
}
