pub mod protocol;
pub mod protocol_client;

use anyhow::Result;
use api_types::{
    ChatRequest, ChatResponse, DanmakuConnectionActionResponse, DanmakuConnectionStateRecord,
    DanmakuBootstrapRecord, DanmakuDisconnectReportRequest, DanmakuHeartbeatRequest,
    DanmakuHostRecord, DanmakuInjectRequest, DanmakuSourceConfigRecord,
    DanmakuNativeConnectResponse, DanmakuNativeProbeResponse,
    DanmakuProtocolEventRequest, DanmakuProtocolEventType,
    DanmakuSessionCloseRequest, DanmakuSessionErrorRequest, DanmakuSessionOpenRequest,
    DanmakuSourceUpdateRequest, Live2dSubtitleRequest, RuntimeEvent, RuntimeEventKind,
};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use jobs::PythonAdapterSupervisor;
use media::Live2dService;
use orchestrator::{Orchestrator, RuntimeBus};
use serde::Deserialize;
use serde_json::Value;
use storage::{
    DanmakuSourceSecretRecord, NewDanmakuBootstrapRecord, NewDanmakuConnectionStateRecord,
    NewDanmakuSourceConfigRecord, Storage,
};
use tokio::time::{Duration, interval, sleep};
use tokio_tungstenite::tungstenite::Message;
use url::form_urlencoded::byte_serialize;
use uuid::Uuid;

use crate::protocol::{DecodedPacket, decode_packets, encode_heartbeat_packet};
use crate::protocol_client::{SessionBootstrap, connect_authenticated, handshake_and_read_once};

#[derive(Clone)]
pub struct GatewayService {
    storage: Storage,
    adapters: PythonAdapterSupervisor,
    orchestrator: Orchestrator,
    live2d: Live2dService,
    runtime_bus: RuntimeBus,
}

impl GatewayService {
    pub fn new(
        storage: Storage,
        adapters: PythonAdapterSupervisor,
        orchestrator: Orchestrator,
        live2d: Live2dService,
        runtime_bus: RuntimeBus,
    ) -> Self {
        Self {
            storage,
            adapters,
            orchestrator,
            live2d,
            runtime_bus,
        }
    }

    pub fn spawn_reconnect_worker(&self) {
        let gateway = self.clone();
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_millis(200)).await;
                let Ok(state) = gateway.storage.get_danmaku_connection_state().await else {
                    continue;
                };
                if state.status != "reconnecting" {
                    continue;
                }
                let Some(next_retry_at) = state.next_retry_at else {
                    continue;
                };
                if next_retry_at > Utc::now() {
                    continue;
                }

                let source = match gateway.storage.get_danmaku_source_config().await {
                    Ok(source) => source,
                    Err(_) => continue,
                };
                if source.connection_mode == "native_websocket" {
                    let _ = gateway.start_native_session().await;
                } else {
                    let _ = gateway.connect().await;
                }
            }
        });
    }

    pub async fn get_source_config(&self) -> Result<DanmakuSourceConfigRecord> {
        self.storage.get_danmaku_source_config().await
    }

    pub async fn update_source_config(
        &self,
        request: DanmakuSourceUpdateRequest,
    ) -> Result<DanmakuSourceConfigRecord> {
        let record = self
            .storage
            .upsert_danmaku_source_config(NewDanmakuSourceConfigRecord {
                room_id: request.room_id,
                uid: request.uid,
                buvid: request.buvid,
                cookie: request.cookie,
                signature_mode: request.signature_mode,
                connection_mode: request.connection_mode,
            })
            .await?;

        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::DanmakuSourceUpdated,
            source: "danmaku_source".into(),
            detail: Some(record.room_id.clone()),
            created_at: Utc::now(),
        });

        Ok(record)
    }

    pub async fn get_connection_state(&self) -> Result<DanmakuConnectionStateRecord> {
        self.storage.get_danmaku_connection_state().await
    }

    pub async fn native_probe(&self) -> Result<DanmakuNativeProbeResponse> {
        let source = self.storage.get_danmaku_source_config().await?;
        let bootstrap = match self.storage.get_danmaku_bootstrap().await? {
            Some(snapshot) if snapshot.requested_room_id == source.room_id => snapshot,
            _ => self.bootstrap().await?,
        };
        let host = bootstrap
            .selected_upstream_host
            .clone()
            .or_else(|| bootstrap.upstream_hosts.first().map(|entry| entry.host.clone()))
            .unwrap_or_else(|| "127.0.0.1".into());
        let address = std::env::var("MEMORY_SUITE_BILIBILI_NATIVE_WS_ADDR")
            .unwrap_or_else(|_| native_ws_address(&bootstrap, &host));

        let decoded = handshake_and_read_once(&SessionBootstrap {
            room_id: bootstrap.resolved_room_id.parse().unwrap_or_default(),
            uid: source.uid,
            buvid: source.buvid,
            token: if bootstrap.token_ready {
                "probe-token".into()
            } else {
                String::new()
            },
            address,
        })
        .await?;

        Ok(DanmakuNativeProbeResponse {
            host,
            decoded_packet_count: decoded.len() as u32,
            saw_heartbeat_reply: decoded
                .iter()
                .any(|packet| matches!(packet, DecodedPacket::HeartbeatReply { .. })),
            saw_message_frame: decoded
                .iter()
                .any(|packet| matches!(packet, DecodedPacket::JsonMessage { operation: 5, .. })),
        })
    }

    pub async fn native_connect_once(&self) -> Result<DanmakuNativeConnectResponse> {
        let source = self.storage.get_danmaku_source_config().await?;
        let current = self.storage.get_danmaku_connection_state().await?;
        let attempted_at = Utc::now();
        let bootstrap = match self.storage.get_danmaku_bootstrap().await? {
            Some(snapshot) if snapshot.requested_room_id == source.room_id => snapshot,
            _ => self.bootstrap().await?,
        };
        let host = bootstrap
            .selected_upstream_host
            .clone()
            .or_else(|| bootstrap.upstream_hosts.first().map(|entry| entry.host.clone()))
            .unwrap_or_else(|| "127.0.0.1".into());
        let address = std::env::var("MEMORY_SUITE_BILIBILI_NATIVE_WS_ADDR")
            .unwrap_or_else(|_| native_ws_address(&bootstrap, &host));

        let _ = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "connecting".into(),
                attempt_count: current.attempt_count + 1,
                consecutive_failures: current.consecutive_failures,
                retry_delay_ms: 0,
                session_id: current.session_id,
                current_upstream_host: Some(host.clone()),
                last_connect_attempt_at: Some(attempted_at),
                last_heartbeat_at: current.last_heartbeat_at,
                next_retry_at: None,
                last_error: None,
                last_close_reason: None,
                adapter_id: Some("native_bilibili".into()),
            })
            .await?;

        let decoded = match handshake_and_read_once(&SessionBootstrap {
            room_id: bootstrap.resolved_room_id.parse().unwrap_or_default(),
            uid: source.uid,
            buvid: source.buvid,
            token: bootstrap.token,
            address,
        })
        .await
        {
            Ok(decoded) => decoded,
            Err(error) => {
                let state = self.storage.get_danmaku_connection_state().await?;
                let _ = self
                    .storage
                    .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                        status: "failed".into(),
                        attempt_count: state.attempt_count,
                        consecutive_failures: state.consecutive_failures + 1,
                        retry_delay_ms: 0,
                        session_id: state.session_id,
                        current_upstream_host: Some(host.clone()),
                        last_connect_attempt_at: state.last_connect_attempt_at,
                        last_heartbeat_at: state.last_heartbeat_at,
                        next_retry_at: None,
                        last_error: Some(error.to_string()),
                        last_close_reason: state.last_close_reason,
                        adapter_id: Some("native_bilibili".into()),
                    })
                    .await?;
                return Err(error);
            }
        };

        let session_id = format!("native:{}", Uuid::new_v4());
        self.session_open(DanmakuSessionOpenRequest {
            session_id: session_id.clone(),
            upstream_host: host.clone(),
        })
        .await?;
        let mut saw_heartbeat_reply = false;
        let mut ingested_event_count = 0_u32;

        for packet in &decoded {
            match packet {
                DecodedPacket::HeartbeatReply { .. } => {
                    saw_heartbeat_reply = true;
                    self.heartbeat(DanmakuHeartbeatRequest {
                        upstream_host: Some(host.clone()),
                    })
                    .await?;
                }
                DecodedPacket::JsonMessage {
                    operation: 5,
                    payload,
                } => {
                    if let Some(event) = protocol_payload_to_event(payload, &session_id) {
                        let _ = self.ingest_protocol_event(event).await?;
                        ingested_event_count += 1;
                    }
                }
                _ => {}
            }
        }

        let state = self.storage.get_danmaku_connection_state().await?;
        Ok(DanmakuNativeConnectResponse {
            host,
            session_id,
            decoded_packet_count: decoded.len() as u32,
            ingested_event_count,
            saw_heartbeat_reply,
            state,
        })
    }

    pub async fn start_native_session(&self) -> Result<DanmakuConnectionActionResponse> {
        let source = self.storage.get_danmaku_source_config().await?;
        let current = self.storage.get_danmaku_connection_state().await?;
        let attempted_at = Utc::now();
        let bootstrap = match self.storage.get_danmaku_bootstrap().await? {
            Some(snapshot) if snapshot.requested_room_id == source.room_id => snapshot,
            _ => self.bootstrap().await?,
        };
        let host = bootstrap
            .selected_upstream_host
            .clone()
            .or_else(|| bootstrap.upstream_hosts.first().map(|entry| entry.host.clone()))
            .unwrap_or_else(|| "127.0.0.1".into());
        let address = std::env::var("MEMORY_SUITE_BILIBILI_NATIVE_WS_ADDR")
            .unwrap_or_else(|_| native_ws_address(&bootstrap, &host));
        let session_id = format!("native:{}", Uuid::new_v4());

        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::DanmakuConnectAttempted,
            source: "danmaku_connection".into(),
            detail: Some((current.attempt_count + 1).to_string()),
            created_at: attempted_at,
        });

        let state = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "connecting".into(),
                attempt_count: current.attempt_count + 1,
                consecutive_failures: current.consecutive_failures,
                retry_delay_ms: 0,
                session_id: Some(session_id.clone()),
                current_upstream_host: Some(host.clone()),
                last_connect_attempt_at: Some(attempted_at),
                last_heartbeat_at: current.last_heartbeat_at,
                next_retry_at: None,
                last_error: None,
                last_close_reason: None,
                adapter_id: Some("native_bilibili".into()),
            })
            .await?;

        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::DanmakuConnectionConnecting,
            source: "danmaku_connection".into(),
            detail: Some(format!("{}:{}:native", source.room_id, source.uid)),
            created_at: Utc::now(),
        });

        let gateway = self.clone();
        tokio::spawn(async move {
            let result = gateway
                .run_native_session_loop(
                    session_id.clone(),
                    host.clone(),
                    SessionBootstrap {
                        room_id: bootstrap.resolved_room_id.parse().unwrap_or_default(),
                        uid: source.uid,
                        buvid: source.buvid,
                        token: bootstrap.token,
                        address,
                    },
                )
                .await;

            if let Err(error) = result {
                let _ = gateway
                    .session_error(DanmakuSessionErrorRequest {
                        session_id,
                        reason: error.to_string(),
                    })
                    .await;
            }
        });

        Ok(DanmakuConnectionActionResponse { ok: true, state })
    }

    pub async fn bootstrap(&self) -> Result<DanmakuBootstrapRecord> {
        let source = self.storage.get_danmaku_source_secret().await?;
        let room_init_base = std::env::var("MEMORY_SUITE_BILIBILI_ROOM_INIT_BASE")
            .unwrap_or_else(|_| "https://api.live.bilibili.com".into());
        let danmu_info_base = std::env::var("MEMORY_SUITE_BILIBILI_DANMU_INFO_BASE")
            .unwrap_or_else(|_| "https://api.live.bilibili.com".into());
        let client = reqwest::Client::builder().build()?;

        let room_referer = format!("https://live.bilibili.com/{}", source.room_id);

        let room_init: RoomInitEnvelope = client
            .get(format!("{room_init_base}/room/v1/Room/room_init"))
            .query(&[("id", source.room_id.as_str())])
            .header(reqwest::header::USER_AGENT, browser_user_agent())
            .header(reqwest::header::REFERER, room_referer.clone())
            .header(reqwest::header::ORIGIN, "https://live.bilibili.com")
            .header(reqwest::header::COOKIE, source.cookie.clone().unwrap_or_default())
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let resolved_room_id = room_init
            .data
            .room_id
            .max(0)
            .to_string();
        let live_status = room_init.data.live_status.max(0) as u32;

        let danmu_query = signed_danmu_query(&client, &source, &resolved_room_id).await?;
        let danmu_info: DanmuInfoEnvelope = client
            .get(format!(
                "{danmu_info_base}/xlive/web-room/v1/index/getDanmuInfo"
            ))
            .query(&danmu_query)
            .header(reqwest::header::USER_AGENT, browser_user_agent())
            .header(reqwest::header::REFERER, room_referer)
            .header(reqwest::header::ORIGIN, "https://live.bilibili.com")
            .header(reqwest::header::COOKIE, source.cookie.clone().unwrap_or_default())
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let upstream_hosts = danmu_info
            .data
            .host_list
            .into_iter()
            .map(|host| DanmakuHostRecord {
                host: host.host,
                port: host.port.max(0) as u16,
                wss_port: host.wss_port.max(0) as u16,
            })
            .collect::<Vec<_>>();
        let selected_upstream_host = upstream_hosts.first().map(|host| host.host.clone());

        let record = self
            .storage
            .upsert_danmaku_bootstrap(NewDanmakuBootstrapRecord {
                requested_room_id: source.room_id,
                resolved_room_id,
                live_status,
                token: danmu_info.data.token,
                upstream_hosts,
                selected_upstream_host: selected_upstream_host.clone(),
            })
            .await?;

        let current = self.storage.get_danmaku_connection_state().await?;
        let _ = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: current.status,
                attempt_count: current.attempt_count,
                consecutive_failures: current.consecutive_failures,
                retry_delay_ms: current.retry_delay_ms,
                session_id: current.session_id,
                current_upstream_host: selected_upstream_host,
                last_connect_attempt_at: current.last_connect_attempt_at,
                last_heartbeat_at: current.last_heartbeat_at,
                next_retry_at: current.next_retry_at,
                last_error: current.last_error,
                last_close_reason: current.last_close_reason,
                adapter_id: current.adapter_id,
            })
            .await?;

        Ok(record)
    }

    pub async fn connect(&self) -> Result<DanmakuConnectionActionResponse> {
        let source = self.storage.get_danmaku_source_config().await?;
        let current = self.storage.get_danmaku_connection_state().await?;
        let attempted_at = Utc::now();
        let bootstrap = match self.storage.get_danmaku_bootstrap().await? {
            Some(snapshot) if snapshot.requested_room_id == source.room_id => Some(snapshot),
            _ => self.bootstrap().await.ok(),
        };
        let selected_upstream_host = bootstrap.and_then(|snapshot| snapshot.selected_upstream_host);

        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::DanmakuConnectAttempted,
            source: "danmaku_connection".into(),
            detail: Some((current.attempt_count + 1).to_string()),
            created_at: attempted_at,
        });

        match self
            .adapters
            .start_adapter(
                "danmaku_protocol",
                api_types::AdapterStartRequest { args: Vec::new() },
            )
            .await
        {
            Ok(adapter) => {
                let state = self
                    .storage
                    .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                        status: "connecting".into(),
                        attempt_count: current.attempt_count + 1,
                        consecutive_failures: current.consecutive_failures,
                        retry_delay_ms: 0,
                        session_id: current.session_id,
                        current_upstream_host: selected_upstream_host.clone(),
                        last_connect_attempt_at: Some(attempted_at),
                        last_heartbeat_at: current.last_heartbeat_at,
                        next_retry_at: None,
                        last_error: None,
                        last_close_reason: current.last_close_reason,
                        adapter_id: Some(adapter.adapter_id),
                    })
                    .await?;

                self.runtime_bus.publish(RuntimeEvent {
                    id: Uuid::new_v4(),
                    kind: RuntimeEventKind::DanmakuConnectionConnecting,
                    source: "danmaku_connection".into(),
                    detail: Some(format!(
                        "{}:{}:{}",
                        source.room_id, source.uid, source.connection_mode
                    )),
                    created_at: Utc::now(),
                });

                Ok(DanmakuConnectionActionResponse { ok: true, state })
            }
            Err(error) => {
                let state = self
                    .storage
                    .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                        status: "failed".into(),
                        attempt_count: current.attempt_count + 1,
                        consecutive_failures: current.consecutive_failures + 1,
                        retry_delay_ms: 0,
                        session_id: current.session_id,
                        current_upstream_host: selected_upstream_host,
                        last_connect_attempt_at: Some(attempted_at),
                        last_heartbeat_at: current.last_heartbeat_at,
                        next_retry_at: None,
                        last_error: Some(error.to_string()),
                        last_close_reason: current.last_close_reason,
                        adapter_id: Some("danmaku_protocol".into()),
                    })
                    .await?;

                Ok(DanmakuConnectionActionResponse { ok: false, state })
            }
        }
    }

    pub async fn disconnect(&self) -> Result<DanmakuConnectionActionResponse> {
        let current = self.storage.get_danmaku_connection_state().await?;
        let state = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "disconnected".into(),
                attempt_count: current.attempt_count,
                consecutive_failures: current.consecutive_failures,
                retry_delay_ms: 0,
                session_id: current.session_id,
                current_upstream_host: current.current_upstream_host,
                last_connect_attempt_at: current.last_connect_attempt_at,
                last_heartbeat_at: current.last_heartbeat_at,
                next_retry_at: None,
                last_error: Some("operator_disconnect".into()),
                last_close_reason: current.last_close_reason,
                adapter_id: current.adapter_id,
            })
            .await?;

        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::DanmakuConnectionDisconnected,
            source: "danmaku_connection".into(),
            detail: state.last_error.clone(),
            created_at: Utc::now(),
        });

        Ok(DanmakuConnectionActionResponse { ok: true, state })
    }

    pub async fn heartbeat(
        &self,
        request: DanmakuHeartbeatRequest,
    ) -> Result<DanmakuConnectionStateRecord> {
        let current = self.storage.get_danmaku_connection_state().await?;
        let state = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "connected".into(),
                attempt_count: current.attempt_count,
                consecutive_failures: 0,
                retry_delay_ms: 0,
                session_id: current.session_id,
                current_upstream_host: request
                    .upstream_host
                    .or(current.current_upstream_host),
                last_connect_attempt_at: current.last_connect_attempt_at,
                last_heartbeat_at: Some(Utc::now()),
                next_retry_at: None,
                last_error: None,
                last_close_reason: current.last_close_reason,
                adapter_id: current.adapter_id,
            })
            .await?;

        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::DanmakuHeartbeatReceived,
            source: "danmaku_connection".into(),
            detail: state.current_upstream_host.clone(),
            created_at: Utc::now(),
        });

        Ok(state)
    }

    pub async fn report_disconnect(
        &self,
        request: DanmakuDisconnectReportRequest,
    ) -> Result<DanmakuConnectionStateRecord> {
        let current = self.storage.get_danmaku_connection_state().await?;
        let consecutive_failures = current.consecutive_failures + 1;
        let retry_delay_ms = calculate_retry_delay_ms(consecutive_failures);
        let next_retry_at = Utc::now() + chrono::TimeDelta::milliseconds(i64::from(retry_delay_ms));

        let state = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "reconnecting".into(),
                attempt_count: current.attempt_count,
                consecutive_failures,
                retry_delay_ms,
                session_id: current.session_id,
                current_upstream_host: current.current_upstream_host,
                last_connect_attempt_at: current.last_connect_attempt_at,
                last_heartbeat_at: current.last_heartbeat_at,
                next_retry_at: Some(next_retry_at),
                last_error: Some(request.reason),
                last_close_reason: current.last_close_reason,
                adapter_id: current.adapter_id,
            })
            .await?;

        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::DanmakuReconnectScheduled,
            source: "danmaku_connection".into(),
            detail: Some(retry_delay_ms.to_string()),
            created_at: Utc::now(),
        });

        Ok(state)
    }

    pub async fn session_open(
        &self,
        request: DanmakuSessionOpenRequest,
    ) -> Result<DanmakuConnectionStateRecord> {
        let current = self.storage.get_danmaku_connection_state().await?;
        let state = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "connected".into(),
                attempt_count: current.attempt_count,
                consecutive_failures: 0,
                retry_delay_ms: 0,
                session_id: Some(request.session_id),
                current_upstream_host: Some(request.upstream_host),
                last_connect_attempt_at: current.last_connect_attempt_at,
                last_heartbeat_at: Some(Utc::now()),
                next_retry_at: None,
                last_error: None,
                last_close_reason: None,
                adapter_id: current.adapter_id,
            })
            .await?;
        Ok(state)
    }

    pub async fn session_error(
        &self,
        request: DanmakuSessionErrorRequest,
    ) -> Result<DanmakuConnectionStateRecord> {
        let current = self.storage.get_danmaku_connection_state().await?;
        let state = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "reconnecting".into(),
                attempt_count: current.attempt_count,
                consecutive_failures: current.consecutive_failures + 1,
                retry_delay_ms: calculate_retry_delay_ms(current.consecutive_failures + 1),
                session_id: Some(request.session_id),
                current_upstream_host: current.current_upstream_host,
                last_connect_attempt_at: current.last_connect_attempt_at,
                last_heartbeat_at: current.last_heartbeat_at,
                next_retry_at: Some(
                    Utc::now()
                        + chrono::TimeDelta::milliseconds(i64::from(calculate_retry_delay_ms(
                            current.consecutive_failures + 1,
                        ))),
                ),
                last_error: Some(request.reason),
                last_close_reason: current.last_close_reason,
                adapter_id: current.adapter_id,
            })
            .await?;
        Ok(state)
    }

    pub async fn session_close(
        &self,
        request: DanmakuSessionCloseRequest,
    ) -> Result<DanmakuConnectionStateRecord> {
        let current = self.storage.get_danmaku_connection_state().await?;
        let state = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "disconnected".into(),
                attempt_count: current.attempt_count,
                consecutive_failures: current.consecutive_failures,
                retry_delay_ms: 0,
                session_id: Some(request.session_id),
                current_upstream_host: current.current_upstream_host,
                last_connect_attempt_at: current.last_connect_attempt_at,
                last_heartbeat_at: current.last_heartbeat_at,
                next_retry_at: None,
                last_error: current.last_error,
                last_close_reason: Some(request.reason),
                adapter_id: current.adapter_id,
            })
            .await?;
        Ok(state)
    }

    pub async fn inject_danmaku(&self, request: DanmakuInjectRequest) -> Result<ChatResponse> {
        self.live2d
            .set_subtitle(Live2dSubtitleRequest {
                text: request.text.clone(),
                duration_ms: 2400,
            })
            .await?;

        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::DanmakuReceived,
            source: request.user_id.clone(),
            detail: Some(request.text.clone()),
            created_at: Utc::now(),
        });

        self.orchestrator
            .handle_chat(ChatRequest {
                session_id: Some(request.session_id),
                user_id: Some(request.user_id),
                text: request.text,
            })
            .await
    }

    pub async fn ingest_protocol_event(
        &self,
        request: DanmakuProtocolEventRequest,
    ) -> Result<ChatResponse> {
        let normalized_text = match request.event_type {
            DanmakuProtocolEventType::Danmaku => request.message.clone(),
            DanmakuProtocolEventType::Gift => format!(
                "感谢 {} 送出 {} x{}",
                request.username,
                request.message,
                request.count.unwrap_or(1)
            ),
            DanmakuProtocolEventType::Superchat => {
                format!("感谢 {} 的醒目留言：{}", request.username, request.message)
            }
            DanmakuProtocolEventType::Guard => {
                format!("感谢 {} 开通舰队：{}", request.username, request.message)
            }
        };

        self.inject_danmaku(DanmakuInjectRequest {
            session_id: request.session_id,
            user_id: request.username,
            text: normalized_text,
        })
        .await
    }

    async fn run_native_session_loop(
        &self,
        session_id: String,
        host: String,
        bootstrap: SessionBootstrap,
    ) -> Result<()> {
        let mut socket = connect_authenticated(&bootstrap).await?;
        self.session_open(DanmakuSessionOpenRequest {
            session_id: session_id.clone(),
            upstream_host: host.clone(),
        })
        .await?;

        let mut heartbeat = interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    socket
                        .send(Message::Binary(encode_heartbeat_packet()?.into()))
                        .await?;
                }
                next = socket.next() => {
                    match next {
                        Some(Ok(Message::Binary(bytes))) => {
                            let decoded = decode_packets(&bytes)?;
                            self.ingest_decoded_packets(&session_id, &host, decoded).await?;
                        }
                        Some(Ok(Message::Close(frame))) => {
                            let reason = frame
                                .map(|frame| frame.reason.to_string())
                                .filter(|reason| !reason.is_empty())
                                .unwrap_or_else(|| "native websocket closed".into());
                            let _ = self.report_disconnect(DanmakuDisconnectReportRequest { reason }).await?;
                            break;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(error)) => {
                            let _ = self.report_disconnect(DanmakuDisconnectReportRequest {
                                reason: error.to_string(),
                            }).await?;
                            break;
                        }
                        None => {
                            let _ = self.report_disconnect(DanmakuDisconnectReportRequest {
                                reason: "native websocket ended".into(),
                            }).await?;
                            break;
                        }
                    }
                }
            }
        }

        Ok(())
    }

    async fn ingest_decoded_packets(
        &self,
        session_id: &str,
        host: &str,
        decoded: Vec<DecodedPacket>,
    ) -> Result<()> {
        for packet in decoded {
            match packet {
                DecodedPacket::HeartbeatReply { .. } => {
                    self.heartbeat(DanmakuHeartbeatRequest {
                        upstream_host: Some(host.to_string()),
                    })
                    .await?;
                }
                DecodedPacket::JsonMessage {
                    operation: 5,
                    payload,
                } => {
                    if let Some(event) = protocol_payload_to_event(&payload, session_id) {
                        let _ = self.ingest_protocol_event(event).await?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

fn browser_user_agent() -> &'static str {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0"
}

async fn signed_danmu_query(
    client: &reqwest::Client,
    source: &DanmakuSourceSecretRecord,
    resolved_room_id: &str,
) -> Result<Vec<(String, String)>> {
    let mut params = vec![
        ("id".to_string(), resolved_room_id.to_string()),
        ("type".to_string(), "0".to_string()),
        ("web_location".to_string(), "444.8".to_string()),
    ];

    if source.signature_mode != "cookie" {
        return Ok(params);
    }

    let nav_base = std::env::var("MEMORY_SUITE_BILIBILI_NAV_BASE")
        .unwrap_or_else(|_| "https://api.bilibili.com".into());
    let nav_response = client
        .get(format!("{nav_base}/x/web-interface/nav"))
        .header(reqwest::header::USER_AGENT, browser_user_agent())
        .header(reqwest::header::REFERER, "https://live.bilibili.com/")
        .header(reqwest::header::ORIGIN, "https://live.bilibili.com")
        .header(reqwest::header::COOKIE, source.cookie.clone().unwrap_or_default())
        .send()
        .await;
    let Ok(nav_response) = nav_response else {
        return Ok(params);
    };
    let Ok(nav_response) = nav_response.error_for_status() else {
        return Ok(params);
    };
    let Ok(nav) = nav_response.json::<NavEnvelope>().await else {
        return Ok(params);
    };

    let mixin_key = build_wbi_mixin_key(&nav.data.wbi_img.img_url, &nav.data.wbi_img.sub_url);
    let timestamp = chrono::Utc::now().timestamp().to_string();
    params.push(("wts".to_string(), timestamp));
    let signature = sign_wbi_query(&params, &mixin_key);
    params.push(("w_rid".to_string(), signature));
    Ok(params)
}

fn build_wbi_mixin_key(img_url: &str, sub_url: &str) -> String {
    let img_key = img_url
        .rsplit('/')
        .next()
        .and_then(|segment| segment.split('.').next())
        .unwrap_or_default();
    let sub_key = sub_url
        .rsplit('/')
        .next()
        .and_then(|segment| segment.split('.').next())
        .unwrap_or_default();
    let source = format!("{img_key}{sub_key}");
    let bytes = source.as_bytes();
    const MIXIN_KEY_INDEX: [usize; 64] = [
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9,
        42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1,
        60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
    ];

    MIXIN_KEY_INDEX
        .iter()
        .filter_map(|&index| bytes.get(index).copied())
        .map(char::from)
        .take(32)
        .collect()
}

fn sign_wbi_query(params: &[(String, String)], mixin_key: &str) -> String {
    let mut sorted = params.to_vec();
    sorted.sort_by(|left, right| left.0.cmp(&right.0));
    let canonical = sorted
        .into_iter()
        .map(|(key, value)| {
            let sanitized = value
                .chars()
                .filter(|ch| !matches!(ch, '!' | '\'' | '(' | ')' | '*'))
                .collect::<String>();
            format!(
                "{}={}",
                percent_encode_component(&key),
                percent_encode_component(&sanitized)
            )
        })
        .collect::<Vec<_>>()
        .join("&");
    let digest = md5::compute(format!("{canonical}{mixin_key}"));
    format!("{digest:x}")
}

fn percent_encode_component(value: &str) -> String {
    byte_serialize(value.as_bytes()).collect()
}

fn native_ws_address(bootstrap: &DanmakuBootstrapRecord, host: &str) -> String {
    let upstream = bootstrap
        .upstream_hosts
        .iter()
        .find(|entry| entry.host == host)
        .or_else(|| bootstrap.upstream_hosts.first());

    match upstream {
        Some(entry) if entry.wss_port > 0 => format!("wss://{}:{}/sub", entry.host, entry.wss_port),
        Some(entry) if entry.port > 0 => format!("ws://{}:{}/sub", entry.host, entry.port),
        _ => format!("wss://{host}:443/sub"),
    }
}

#[derive(Debug, Deserialize)]
struct RoomInitEnvelope {
    data: RoomInitPayload,
}

#[derive(Debug, Deserialize)]
struct RoomInitPayload {
    room_id: i64,
    live_status: i64,
}

#[derive(Debug, Deserialize)]
struct DanmuInfoEnvelope {
    data: DanmuInfoPayload,
}

#[derive(Debug, Deserialize)]
struct DanmuInfoPayload {
    token: String,
    host_list: Vec<DanmuHostPayload>,
}

#[derive(Debug, Deserialize)]
struct NavEnvelope {
    data: NavPayload,
}

#[derive(Debug, Deserialize)]
struct NavPayload {
    wbi_img: NavWbiPayload,
}

#[derive(Debug, Deserialize)]
struct NavWbiPayload {
    img_url: String,
    sub_url: String,
}

#[derive(Debug, Deserialize)]
struct DanmuHostPayload {
    host: String,
    port: i64,
    wss_port: i64,
}

fn calculate_retry_delay_ms(consecutive_failures: u32) -> u32 {
    let exponent = consecutive_failures.saturating_sub(1).min(6);
    (1_000_u32.saturating_mul(2_u32.saturating_pow(exponent))).min(60_000)
}

fn protocol_payload_to_event(
    payload: &str,
    session_id: &str,
) -> Option<DanmakuProtocolEventRequest> {
    let value: Value = serde_json::from_str(payload).ok()?;
    let cmd = value.get("cmd")?.as_str()?;
    let cmd = cmd.split(':').next().unwrap_or(cmd);

    match cmd {
        "DANMU_MSG" => {
            let info = value.get("info")?.as_array()?;
            let message = info.get(1)?.as_str()?.to_string();
            let username = info
                .get(2)
                .and_then(Value::as_array)
                .and_then(|user| user.get(1))
                .and_then(Value::as_str)
                .unwrap_or("bilibili_viewer")
                .to_string();
            Some(DanmakuProtocolEventRequest {
                session_id: session_id.to_string(),
                event_type: DanmakuProtocolEventType::Danmaku,
                username,
                message,
                count: None,
            })
        }
        "SEND_GIFT" => {
            let data = value.get("data")?;
            Some(DanmakuProtocolEventRequest {
                session_id: session_id.to_string(),
                event_type: DanmakuProtocolEventType::Gift,
                username: data
                    .get("uname")
                    .and_then(Value::as_str)
                    .unwrap_or("gift_viewer")
                    .to_string(),
                message: data
                    .get("giftName")
                    .and_then(Value::as_str)
                    .unwrap_or("gift")
                    .to_string(),
                count: data
                    .get("num")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok()),
            })
        }
        "SUPER_CHAT_MESSAGE" => {
            let data = value.get("data")?;
            Some(DanmakuProtocolEventRequest {
                session_id: session_id.to_string(),
                event_type: DanmakuProtocolEventType::Superchat,
                username: data
                    .get("user_info")
                    .and_then(|user| user.get("uname"))
                    .and_then(Value::as_str)
                    .unwrap_or("superchat_viewer")
                    .to_string(),
                message: data
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                count: None,
            })
        }
        "GUARD_BUY" => {
            let data = value.get("data")?;
            Some(DanmakuProtocolEventRequest {
                session_id: session_id.to_string(),
                event_type: DanmakuProtocolEventType::Guard,
                username: data
                    .get("username")
                    .and_then(Value::as_str)
                    .unwrap_or("guard_viewer")
                    .to_string(),
                message: data
                    .get("gift_name")
                    .or_else(|| data.get("guard_level"))
                    .and_then(Value::as_str)
                    .unwrap_or("guard")
                    .to_string(),
                count: data
                    .get("num")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok()),
            })
        }
        _ => None,
    }
}
