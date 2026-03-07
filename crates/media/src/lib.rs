use std::{path::PathBuf, time::Duration};

use anyhow::Result;
use api_types::{
    AdapterStartRequest, Live2dConfigRequest, Live2dEmotionRequest, Live2dStateRecord,
    Live2dSubtitleRequest, RuntimeEvent, RuntimeEventKind, TtsSpeakRequest, TtsSpeakResponse,
};
use jobs::PythonAdapterSupervisor;
use orchestrator::RuntimeBus;
use storage::{NewLive2dConfigRecord, NewLive2dStateRecord, NewTtsRecord, Storage};
use tokio::{fs, time::sleep};
use uuid::Uuid;

#[derive(Clone)]
pub struct TtsService {
    storage: Storage,
    adapters: PythonAdapterSupervisor,
    runtime_bus: RuntimeBus,
    enable_mock_tts: bool,
    audio_cache_dir: PathBuf,
}

#[derive(Clone)]
pub struct Live2dService {
    storage: Storage,
    runtime_bus: RuntimeBus,
}

impl Live2dService {
    pub fn new(storage: Storage, runtime_bus: RuntimeBus) -> Self {
        Self {
            storage,
            runtime_bus,
        }
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
        audio_cache_dir: PathBuf,
    ) -> Self {
        Self {
            storage,
            adapters,
            runtime_bus,
            enable_mock_tts,
            audio_cache_dir,
        }
    }

    pub async fn enqueue(&self, request: TtsSpeakRequest) -> Result<TtsSpeakResponse> {
        let session_id = request
            .session_id
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let text = request.text.clone();
        let adapter_id = select_tts_adapter(request.voice.as_deref());
        let record = self
            .storage
            .enqueue_tts(NewTtsRecord {
                session_id,
                text,
                voice: request.voice,
            })
            .await?;

        match self
            .adapters
            .start_adapter(adapter_id, AdapterStartRequest { args: Vec::new() })
            .await
        {
            Ok(_) => {
                let _ = self
                    .storage
                    .update_tts_dispatch(record.id, "dispatching", Some(adapter_id))
                    .await?;
                let completed = self
                    .dispatch_to_python_worker(
                        record.id,
                        adapter_id,
                        &record.text,
                        record.voice.as_deref(),
                    )
                    .await?;
                self.runtime_bus.publish(RuntimeEvent {
                    id: Uuid::new_v4(),
                    kind: RuntimeEventKind::TtsQueued,
                    source: adapter_id.to_string(),
                    detail: completed.audio_path.clone(),
                    created_at: completed.created_at,
                });
                return Ok(TtsSpeakResponse {
                    request_id: completed.id,
                    status: completed.status,
                    audio_path: completed.audio_path,
                    created_at: completed.created_at,
                });
            }
            Err(error) if self.enable_mock_tts => {
                let mocked = self
                    .storage
                    .update_tts_dispatch(record.id, "mocked", Some(adapter_id))
                    .await?;
                tracing::warn!("falling back to mock tts dispatch: {error}");
                return Ok(TtsSpeakResponse {
                    request_id: mocked.id,
                    status: mocked.status,
                    audio_path: mocked.audio_path,
                    created_at: mocked.created_at,
                });
            }
            Err(error) => return Err(error),
        }
    }

    async fn dispatch_to_python_worker(
        &self,
        request_id: Uuid,
        adapter_id: &str,
        text: &str,
        voice: Option<&str>,
    ) -> Result<api_types::TtsRequestRecord> {
        let endpoint = tts_endpoint(adapter_id);
        wait_for_tts_worker(&endpoint).await?;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()?;
        let response = client
            .post(format!("{endpoint}/tts"))
            .json(&serde_json::json!({
                "character_name": "feibi",
                "text": text,
                "voice": voice,
            }))
            .send()
            .await?
            .error_for_status()?;

        let extension = audio_extension(response.headers().get(reqwest::header::CONTENT_TYPE));
        let audio = response.bytes().await?;
        fs::create_dir_all(&self.audio_cache_dir).await?;
        let audio_path = self
            .audio_cache_dir
            .join(format!("{request_id}.{extension}"));
        fs::write(&audio_path, &audio).await?;

        self.storage
            .update_tts_result(
                request_id,
                "completed",
                Some(adapter_id),
                Some(&audio_path.to_string_lossy()),
            )
            .await
    }
}

fn audio_extension(content_type: Option<&reqwest::header::HeaderValue>) -> &'static str {
    let Some(content_type) = content_type.and_then(|value| value.to_str().ok()) else {
        return "mp3";
    };
    let mime = content_type.to_ascii_lowercase();
    if mime.contains("audio/wav") || mime.contains("audio/x-wav") || mime.contains("audio/wave") {
        "wav"
    } else {
        "mp3"
    }
}

fn select_tts_adapter(voice: Option<&str>) -> &'static str {
    let _ = voice;
    // Runtime policy: Edge TTS is the single active speech backend for now.
    "edge_tts"
}

fn tts_endpoint(adapter_id: &str) -> String {
    match adapter_id {
        "sovits" => format!(
            "http://127.0.0.1:{}",
            std::env::var("GENIE_PORT").unwrap_or_else(|_| "9880".into())
        ),
        _ => format!(
            "http://127.0.0.1:{}",
            std::env::var("EDGE_TTS_PORT").unwrap_or_else(|_| "9881".into())
        ),
    }
}

async fn wait_for_tts_worker(endpoint: &str) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;

    let health_url = if endpoint.ends_with(":9881") {
        format!("{endpoint}/voices")
    } else {
        format!("{endpoint}/docs")
    };

    let mut last_error = None;
    for _ in 0..30 {
        match client.get(&health_url).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                last_error = Some(format!("worker returned {}", response.status()));
            }
            Err(error) => {
                last_error = Some(error.to_string());
            }
        }
        sleep(Duration::from_millis(250)).await;
    }

    Err(anyhow::anyhow!(
        "timed out waiting for tts worker at {endpoint}: {}",
        last_error.unwrap_or_else(|| "unknown error".into())
    ))
}

#[cfg(test)]
mod tests {
    use super::select_tts_adapter;

    #[test]
    fn tts_adapter_selection_is_forced_to_edge_tts() {
        assert_eq!(select_tts_adapter(None), "edge_tts");
        assert_eq!(select_tts_adapter(Some("edge-tts-zh")), "edge_tts");
        assert_eq!(select_tts_adapter(Some("sovits")), "edge_tts");
        assert_eq!(select_tts_adapter(Some("legacy-custom-voice")), "edge_tts");
    }
}
