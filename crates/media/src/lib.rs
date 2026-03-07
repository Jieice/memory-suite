use anyhow::Result;
use api_types::{
    AdapterStartRequest, Live2dConfigRequest, Live2dEmotionRequest, Live2dStateRecord,
    Live2dSubtitleRequest, RuntimeEvent, RuntimeEventKind, TtsSpeakRequest, TtsSpeakResponse,
};
use jobs::PythonAdapterSupervisor;
use orchestrator::RuntimeBus;
use storage::{NewLive2dConfigRecord, NewLive2dStateRecord, NewTtsRecord, Storage};
use uuid::Uuid;

#[derive(Clone)]
pub struct TtsService {
    storage: Storage,
    adapters: PythonAdapterSupervisor,
    runtime_bus: RuntimeBus,
    enable_mock_tts: bool,
}

#[derive(Clone)]
pub struct Live2dService {
    storage: Storage,
    runtime_bus: RuntimeBus,
}

impl Live2dService {
    pub fn new(storage: Storage, runtime_bus: RuntimeBus) -> Self {
        Self { storage, runtime_bus }
    }

    pub async fn get_state(&self) -> Result<Live2dStateRecord> {
        self.storage.get_live2d_state().await
    }

    pub async fn set_subtitle(&self, request: Live2dSubtitleRequest) -> Result<Live2dStateRecord> {
        let current = self.storage.get_live2d_state().await?;
        let record = self
            .storage
            .upsert_live2d_state(NewLive2dStateRecord {
                subtitle: request.text,
                subtitle_duration_ms: request.duration_ms,
                emotion: current.emotion,
            })
            .await?;
        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::Live2dSubtitleUpdated,
            source: "live2d".into(),
            detail: Some(record.subtitle.clone()),
            created_at: record.updated_at,
        });
        Ok(record)
    }

    pub async fn set_emotion(&self, request: Live2dEmotionRequest) -> Result<Live2dStateRecord> {
        let current = self.storage.get_live2d_state().await?;
        let record = self
            .storage
            .upsert_live2d_state(NewLive2dStateRecord {
                subtitle: current.subtitle,
                subtitle_duration_ms: current.subtitle_duration_ms,
                emotion: request.emotion,
            })
            .await?;
        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::Live2dEmotionUpdated,
            source: "live2d".into(),
            detail: Some(record.emotion.clone()),
            created_at: record.updated_at,
        });
        Ok(record)
    }

    pub async fn set_config(&self, request: Live2dConfigRequest) -> Result<Live2dStateRecord> {
        self.storage
            .upsert_live2d_config(NewLive2dConfigRecord {
                scale: request.scale,
                x: request.x,
                y: request.y,
            })
            .await?;
        let record = self.storage.get_live2d_state().await?;
        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::Live2dConfigUpdated,
            source: "live2d".into(),
            detail: Some(format!(
                "scale={},x={},y={}",
                record.config.scale, record.config.x, record.config.y
            )),
            created_at: record.updated_at,
        });
        Ok(record)
    }
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
