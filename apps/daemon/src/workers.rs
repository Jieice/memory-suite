use std::{collections::VecDeque, sync::Arc};

use api_types::{ChatRequest, RuntimeEvent, RuntimeEventKind};
use gateway::GatewayService;
use orchestrator::RuntimeBus;
use storage::Storage;
use tokio::{sync::RwLock, time::Duration};

use crate::AppState;

pub(crate) fn spawn_clip_listener(
    runtime_bus: RuntimeBus,
    clip_candidates: Arc<RwLock<VecDeque<RuntimeEvent>>>,
    storage: Storage,
) {
    let mut rx = runtime_bus.subscribe();
    tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            if event.kind == RuntimeEventKind::ClipCandidate {
                {
                    let mut clips = clip_candidates.write().await;
                    if clips.len() >= 50 {
                        clips.pop_front();
                    }
                    clips.push_back(event.clone());
                }
                // Also store as memorable_moment memory entry for callback recall
                if let Some(ref detail) = event.detail {
                    if detail.len() > 20 {
                        let moment: String = detail.chars().take(120).collect();
                        let _ = storage.import_memory_entry(storage::NewMemoryEntryRecord {
                            user_id: "character".into(),
                            entry_type: "memorable_moment".into(),
                            payload: serde_json::json!({ "moment": moment, "source": event.source }),
                            source: "clip_detected".into(),
                        }).await;
                    }
                }
            }
        }
    });
}

/// Batch processor: collects danmaku every 3 seconds, picks best 1-2, calls LLM once.
pub(crate) fn spawn_danmaku_batch_processor(state: Arc<AppState>) {
    tokio::spawn(async move {
        let batch_window = Duration::from_secs(3);
        loop {
            tokio::time::sleep(batch_window).await;

            let batch: Vec<(String, String)> = {
                let mut buf = state.danmaku_buffer.write().await;
                if buf.is_empty() {
                    continue;
                }
                let items: Vec<_> = buf.drain(..).map(|(uid, text, _)| (uid, text)).collect();
                items
            };

            if batch.is_empty() {
                continue;
            }

            // Skip trivial messages, prioritize questions and longer messages
            let interesting: Vec<_> = batch
                .iter()
                .filter(|(_, text)| text.chars().count() >= 3)
                .take(2)
                .collect();

            if interesting.is_empty() {
                continue;
            }

            // Don't interrupt active speech.
            if state.live2d_speech_queue.has_active().await {
                continue;
            }

            // Build combined context
            let context_parts: Vec<String> = interesting
                .iter()
                .map(|(uid, text)| format!("{uid}: {text}"))
                .collect();
            let combined = context_parts.join(" / ");
            let prompt = format!("弹幕摘录：{combined}");
            let scene_hint = Some(format!(
                "channel=live_danmaku_batch\ncount={}",
                batch.len()
            ));

            let request = ChatRequest {
                session_id: Some("danmaku-batch".into()),
                user_id: Some("viewer".into()),
                text: prompt,
            };

            match state
                .orchestrator
                .handle_chat_with_scene(request, scene_hint)
                .await
            {
                Ok(response) => {
                    if let Err(err) = state.chat_response_finalizer.finalize(response, None).await
                    {
                        tracing::warn!("danmaku batch finalize failed: {err}");
                    } else {
                        tracing::debug!(batch_size = batch.len(), "danmaku batch processed");
                    }
                }
                Err(err) => {
                    tracing::warn!("danmaku batch chat failed: {err}");
                }
            }
        }
    });
}

pub(crate) async fn spawn_danmaku_autostart(gateway: GatewayService, storage: Storage) {
    let Ok(source) = storage.get_danmaku_source_config().await else {
        return;
    };
    let configured =
        !source.room_id.trim().is_empty() && !source.buvid.trim().is_empty() && source.has_cookie;
    if !configured {
        return;
    }

    let Ok(state) = storage.get_danmaku_connection_state().await else {
        return;
    };
    if state.status == "connected" {
        return;
    }

    // Decide from the startup snapshot so later source edits do not race into implicit autostarts.
    tokio::spawn(async move {
        let _ = gateway.start_native_session("daemon_autostart").await;
    });
}
