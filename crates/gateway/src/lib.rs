pub mod protocol;

use anyhow::{Context, Result, anyhow, bail};
use api_types::{
    ChatRequest, ChatResponse, DanmakuBootstrapRecord, DanmakuConnectionActionResponse,
    DanmakuConnectionStateRecord, DanmakuHostRecord, DanmakuInjectRequest,
    DanmakuNativeConnectResponse, DanmakuNativeProbeResponse, DanmakuSourceConfigRecord,
    DanmakuSourceUpdateRequest, RuntimeEvent, RuntimeEventKind,
};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use media::ChatResponseFinalizer;
use orchestrator::{Orchestrator, RuntimeBus};
use serde::Deserialize;
use serde_json::Value;
use storage::{
    DanmakuSourceSecretRecord, NewDanmakuBootstrapRecord, NewDanmakuConnectionStateRecord,
    NewDanmakuSourceConfigRecord, Storage,
};
use tokio::net::TcpStream;
use tokio::time::{Duration, interval, sleep};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{
        Message, client::IntoClientRequest,
        http::header::{COOKIE, ORIGIN, REFERER, USER_AGENT},
    },
};
use url::form_urlencoded::byte_serialize;
use uuid::Uuid;

use crate::protocol::{DecodedPacket, decode_packets, encode_auth_packet, encode_heartbeat_packet};

#[derive(Debug, Clone)]
struct NativeEndpointCandidate {
    host: String,
    address: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeSessionBootstrap {
    room_id: u64,
    uid: u64,
    buvid: String,
    token: String,
    cookie: Option<String>,
}

#[derive(Debug, Clone)]
struct NativeSessionPlan {
    endpoint_candidates: Vec<NativeEndpointCandidate>,
    bootstrap: NativeSessionBootstrap,
}

#[derive(Debug, Clone)]
struct NativeAttemptPlan {
    host: String,
    address: String,
    bootstrap: NativeSessionBootstrap,
}

#[derive(Debug)]
struct NativeSessionHandshake {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    first_frame: Vec<DecodedPacket>,
}

#[derive(Debug)]
struct NativeSessionAttemptResult {
    host: String,
    first_frame: Vec<DecodedPacket>,
}

#[derive(Debug, Default)]
struct NativePacketIngestSummary {
    saw_heartbeat_reply: bool,
    ingested_event_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DanmakuProtocolEventKind {
    Danmaku,
    Gift,
    Superchat,
    Guard,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DanmakuProtocolEvent {
    session_id: String,
    kind: DanmakuProtocolEventKind,
    username: String,
    message: String,
    count: Option<u32>,
}

#[derive(Clone)]
pub struct GatewayService {
    storage: Storage,
    orchestrator: Orchestrator,
    chat_response_finalizer: ChatResponseFinalizer,
    runtime_bus: RuntimeBus,
}

impl GatewayService {
    pub fn new(
        storage: Storage,
        orchestrator: Orchestrator,
        chat_response_finalizer: ChatResponseFinalizer,
        runtime_bus: RuntimeBus,
    ) -> Self {
        Self {
            storage,
            orchestrator,
            chat_response_finalizer,
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

                let _ = gateway.start_native_session("reconnect_worker").await;
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
        let plan = self.prepare_native_session_plan(true).await?;
        let result = self.run_native_session_once(&plan).await?;

        Ok(DanmakuNativeProbeResponse {
            host: result.host,
            decoded_packet_count: result.first_frame.len() as u32,
            saw_heartbeat_reply: result
                .first_frame
                .iter()
                .any(|packet| matches!(packet, DecodedPacket::HeartbeatReply { .. })),
            saw_message_frame: result.first_frame.iter().any(
                |packet| matches!(packet, DecodedPacket::JsonMessage { operation: 5, .. }),
            ),
        })
    }

    pub async fn native_connect_once(&self) -> Result<DanmakuNativeConnectResponse> {
        let current = self.storage.get_danmaku_connection_state().await?;
        let attempted_at = Utc::now();
        let plan = self.prepare_native_session_plan(false).await?;

        let _ = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "connecting".into(),
                attempt_count: current.attempt_count + 1,
                consecutive_failures: current.consecutive_failures,
                retry_delay_ms: 0,
                session_id: current.session_id,
                current_upstream_host: plan
                    .endpoint_candidates
                    .first()
                    .map(|candidate| candidate.host.clone()),
                last_connect_attempt_at: Some(attempted_at),
                last_heartbeat_at: current.last_heartbeat_at,
                next_retry_at: None,
                last_error: None,
                last_close_reason: None,
            })
            .await?;

        let first_candidate_host = plan
            .endpoint_candidates
            .first()
            .map(|candidate| candidate.host.clone())
            .unwrap_or_else(|| "127.0.0.1".into());
        let first_candidate_address = plan
            .endpoint_candidates
            .first()
            .map(|candidate| candidate.address.clone());

        let result = match self.run_native_session_once(&plan).await {
            Ok(result) => result,
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
                        current_upstream_host: Some(first_candidate_host),
                        last_connect_attempt_at: state.last_connect_attempt_at,
                        last_heartbeat_at: state.last_heartbeat_at,
                        next_retry_at: None,
                        last_error: Some(format!("{error:#}")),
                        last_close_reason: first_candidate_address
                            .map(|address| format!("handshake address={address}")),
                    })
                    .await?;
                return Err(error);
            }
        };

        let session_id = format!("native:{}", Uuid::new_v4());
        self.session_open(session_id.clone(), result.host.clone())
            .await?;
        let ingest = self
            .ingest_decoded_packets(&session_id, &result.host, result.first_frame.clone())
            .await?;

        let state = self.storage.get_danmaku_connection_state().await?;
        Ok(DanmakuNativeConnectResponse {
            host: result.host,
            session_id,
            decoded_packet_count: result.first_frame.len() as u32,
            ingested_event_count: ingest.ingested_event_count,
            saw_heartbeat_reply: ingest.saw_heartbeat_reply,
            state,
        })
    }

    pub async fn start_native_session(
        &self,
        trigger: &'static str,
    ) -> Result<DanmakuConnectionActionResponse> {
        let source = self.storage.get_danmaku_source_secret().await?;
        let current = self.storage.get_danmaku_connection_state().await?;
        let attempted_at = Utc::now();
        if trigger != "reconnect_worker"
            && current
                .session_id
                .as_deref()
                .map(|session_id| session_id.starts_with("native:"))
                .unwrap_or(false)
            && matches!(current.status.as_str(), "connecting" | "connected" | "reconnecting")
        {
            let state = self
                .storage
                .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                    status: current.status.clone(),
                    attempt_count: current.attempt_count,
                    consecutive_failures: current.consecutive_failures,
                    retry_delay_ms: current.retry_delay_ms,
                    session_id: current.session_id.clone(),
                    current_upstream_host: current.current_upstream_host.clone(),
                    last_connect_attempt_at: current.last_connect_attempt_at,
                    last_heartbeat_at: current.last_heartbeat_at,
                    next_retry_at: current.next_retry_at,
                    last_error: Some(format!(
                        "native start skipped: trigger={} existing status={} session_id={} host={}",
                        trigger,
                        current.status,
                        current.session_id.as_deref().unwrap_or("<none>"),
                        current.current_upstream_host.as_deref().unwrap_or("<none>")
                    )),
                    last_close_reason: current.last_close_reason.clone(),
                })
                .await?;

            self.runtime_bus.publish(RuntimeEvent {
                id: Uuid::new_v4(),
                kind: RuntimeEventKind::DanmakuReconnectScheduled,
                source: "danmaku_connection".into(),
                detail: Some(format!("native_start_skipped_existing_session:{trigger}")),
                created_at: attempted_at,
            });

            return Ok(DanmakuConnectionActionResponse { ok: true, state });
        }

        let plan = match self.prepare_native_session_plan(false).await {
            Ok(plan) => plan,
            Err(error) => {
                let state = self
                    .storage
                    .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                        status: "failed".into(),
                        attempt_count: current.attempt_count + 1,
                        consecutive_failures: current.consecutive_failures + 1,
                        retry_delay_ms: 0,
                        session_id: current.session_id.clone(),
                        current_upstream_host: current.current_upstream_host.clone(),
                        last_connect_attempt_at: Some(attempted_at),
                        last_heartbeat_at: current.last_heartbeat_at,
                        next_retry_at: None,
                        last_error: Some(format!("{error:#}")),
                        last_close_reason: current.last_close_reason.clone(),
                    })
                    .await?;
                return Ok(DanmakuConnectionActionResponse { ok: false, state });
            }
        };
        let host = plan
            .endpoint_candidates
            .first()
            .map(|candidate| candidate.host.clone())
            .unwrap_or_else(|| "127.0.0.1".into());
        let session_id = format!("native:{}", Uuid::new_v4());

        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::DanmakuConnectAttempted,
            source: "danmaku_connection".into(),
            detail: Some(format!("{}:{trigger}", current.attempt_count + 1)),
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
            })
            .await?;

        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::DanmakuConnectionConnecting,
            source: "danmaku_connection".into(),
            detail: Some(format!("{}:{}:native:{trigger}", source.room_id, source.uid)),
            created_at: Utc::now(),
        });

        let gateway = self.clone();
        tokio::spawn(async move {
            if let Err(error) = gateway.run_native_session_background(session_id.clone(), plan).await {
                let _ = gateway.session_error(session_id, format!("{error:#}")).await;
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
            .header(
                reqwest::header::COOKIE,
                source.cookie.clone().unwrap_or_default(),
            )
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let resolved_room_id = room_init.data.room_id.max(0).to_string();
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
            .header(
                reqwest::header::COOKIE,
                source.cookie.clone().unwrap_or_default(),
            )
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
            })
            .await?;

        Ok(record)
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
        upstream_host: Option<String>,
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
                current_upstream_host: upstream_host.or(current.current_upstream_host),
                last_connect_attempt_at: current.last_connect_attempt_at,
                last_heartbeat_at: Some(Utc::now()),
                next_retry_at: None,
                last_error: None,
                last_close_reason: current.last_close_reason,
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

    pub async fn report_disconnect(&self, reason: String) -> Result<DanmakuConnectionStateRecord> {
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
                last_error: Some(reason),
                last_close_reason: current.last_close_reason,
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
        session_id: String,
        upstream_host: String,
    ) -> Result<DanmakuConnectionStateRecord> {
        let current = self.storage.get_danmaku_connection_state().await?;
        let state = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "connected".into(),
                attempt_count: current.attempt_count,
                consecutive_failures: 0,
                retry_delay_ms: 0,
                session_id: Some(session_id),
                current_upstream_host: Some(upstream_host),
                last_connect_attempt_at: current.last_connect_attempt_at,
                last_heartbeat_at: Some(Utc::now()),
                next_retry_at: None,
                last_error: None,
                last_close_reason: None,
            })
            .await?;
        Ok(state)
    }

    pub async fn session_error(
        &self,
        session_id: String,
        reason: String,
    ) -> Result<DanmakuConnectionStateRecord> {
        let current = self.storage.get_danmaku_connection_state().await?;
        let state = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "reconnecting".into(),
                attempt_count: current.attempt_count,
                consecutive_failures: current.consecutive_failures + 1,
                retry_delay_ms: calculate_retry_delay_ms(current.consecutive_failures + 1),
                session_id: Some(session_id),
                current_upstream_host: current.current_upstream_host,
                last_connect_attempt_at: current.last_connect_attempt_at,
                last_heartbeat_at: current.last_heartbeat_at,
                next_retry_at: Some(
                    Utc::now()
                        + chrono::TimeDelta::milliseconds(i64::from(calculate_retry_delay_ms(
                            current.consecutive_failures + 1,
                        ))),
                ),
                last_error: Some(reason),
                last_close_reason: current.last_close_reason,
            })
            .await?;
        Ok(state)
    }

    pub async fn session_close(
        &self,
        session_id: String,
        reason: String,
    ) -> Result<DanmakuConnectionStateRecord> {
        let current = self.storage.get_danmaku_connection_state().await?;
        let state = self
            .storage
            .upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                status: "disconnected".into(),
                attempt_count: current.attempt_count,
                consecutive_failures: current.consecutive_failures,
                retry_delay_ms: 0,
                session_id: Some(session_id),
                current_upstream_host: current.current_upstream_host,
                last_connect_attempt_at: current.last_connect_attempt_at,
                last_heartbeat_at: current.last_heartbeat_at,
                next_retry_at: None,
                last_error: current.last_error,
                last_close_reason: Some(reason),
            })
            .await?;
        Ok(state)
    }

    pub async fn inject_danmaku(&self, request: DanmakuInjectRequest) -> Result<ChatResponse> {
        self.runtime_bus.publish(RuntimeEvent {
            id: Uuid::new_v4(),
            kind: RuntimeEventKind::DanmakuReceived,
            source: request.user_id.clone(),
            detail: Some(request.text.clone()),
            created_at: Utc::now(),
        });

        // Inject viewer identity as scene hint so the character knows who's speaking
        let scene_hint = Some(format!(
            "Viewer {} sent a danmaku comment: \"{}\"",
            request.user_id, request.text
        ));

        let response = self
            .orchestrator
            .handle_chat_with_scene(
                ChatRequest {
                    session_id: Some(request.session_id),
                    user_id: Some(request.user_id),
                    text: request.text,
                },
                scene_hint,
            )
            .await?;

        self.chat_response_finalizer.finalize(response).await
    }

    pub async fn ingest_protocol_event(
        &self,
        session_id: String,
        kind: DanmakuProtocolEventKind,
        username: String,
        message: String,
        count: Option<u32>,
    ) -> Result<ChatResponse> {
        let normalized_text = match kind {
            DanmakuProtocolEventKind::Danmaku => message.clone(),
            DanmakuProtocolEventKind::Gift => format!(
                "感谢 {} 送出 {} x{}",
                username,
                message,
                count.unwrap_or(1)
            ),
            DanmakuProtocolEventKind::Superchat => {
                format!("感谢 {} 的醒目留言：{}", username, message)
            }
            DanmakuProtocolEventKind::Guard => {
                format!("感谢 {} 开通舰长：{}", username, message)
            }
        };

        self.inject_danmaku(DanmakuInjectRequest {
            session_id,
            user_id: username,
            text: normalized_text,
        })
        .await
    }

    async fn prepare_native_session_plan(&self, probe_mode: bool) -> Result<NativeSessionPlan> {
        let source = self.storage.get_danmaku_source_secret().await?;
        let bootstrap = self.bootstrap().await?;
        let endpoint_candidates = native_endpoint_candidates(&bootstrap);

        let cookie = if probe_mode { None } else { source.cookie };
        let buvid = cookie
            .as_deref()
            .and_then(cookie_value_by_name("LIVE_BUVID"))
            .filter(|value| !value.trim().is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or(source.buvid);

        Ok(NativeSessionPlan {
            endpoint_candidates,
            bootstrap: NativeSessionBootstrap {
                room_id: bootstrap.resolved_room_id.parse().unwrap_or_default(),
                uid: 0,
                buvid,
                token: if probe_mode && bootstrap.token_ready {
                    "probe-token".into()
                } else if probe_mode {
                    String::new()
                } else {
                    bootstrap.token
                },
                cookie,
            },
        })
    }

    async fn run_native_session_once(
        &self,
        plan: &NativeSessionPlan,
    ) -> Result<NativeSessionAttemptResult> {
        let mut candidate_errors = Vec::new();
        for attempt in self.native_attempts(plan) {
            tracing::info!(
                host = %attempt.host,
                address = %attempt.address,
                room_id = attempt.bootstrap.room_id,
                uid = attempt.bootstrap.uid,
                token_present = !attempt.bootstrap.token.trim().is_empty(),
                cookie_present = attempt.bootstrap.cookie.as_deref().is_some_and(|value| !value.trim().is_empty()),
                "native one-shot attempt starting"
            );
            match self.connect_native_attempt(&attempt).await {
                Ok(handshake) => {
                    tracing::info!(
                        host = %attempt.host,
                        address = %attempt.address,
                        decoded_packet_count = handshake.first_frame.len(),
                        "native one-shot attempt accepted first frame"
                    );
                    return Ok(NativeSessionAttemptResult {
                        host: attempt.host,
                        first_frame: handshake.first_frame,
                    });
                }
                Err(error) => {
                    tracing::warn!(
                        host = %attempt.host,
                        address = %attempt.address,
                        error = %error,
                        "native one-shot attempt failed"
                    );
                    candidate_errors.push(format!(
                        "host={} address={} error={error}",
                        attempt.host, attempt.address
                    ));
                }
            }
        }

        if candidate_errors.is_empty() {
            Err(anyhow!("no native endpoint candidates available"))
        } else {
            Err(anyhow!(
                "native one-shot candidates exhausted: {}",
                candidate_errors.join(" | ")
            ))
        }
    }

    async fn run_native_session_background(
        &self,
        session_id: String,
        plan: NativeSessionPlan,
    ) -> Result<()> {
        let mut candidate_errors = Vec::new();
        for attempt in self.native_attempts(&plan) {
            let attempted_host = attempt.host.clone();
            let attempted_address = attempt.address.clone();
            tracing::info!(
                session_id = %session_id,
                host = %attempted_host,
                address = %attempted_address,
                room_id = attempt.bootstrap.room_id,
                uid = attempt.bootstrap.uid,
                token_present = !attempt.bootstrap.token.trim().is_empty(),
                cookie_present = attempt.bootstrap.cookie.as_deref().is_some_and(|value| !value.trim().is_empty()),
                "native background attempt starting"
            );
            match self.run_native_session_attempt(&session_id, attempt).await {
                Ok(()) => {
                    tracing::info!(
                        session_id = %session_id,
                        host = %attempted_host,
                        address = %attempted_address,
                        "native background attempt completed"
                    );
                    return Ok(());
                }
                Err(error) => {
                    tracing::warn!(
                        session_id = %session_id,
                        host = %attempted_host,
                        address = %attempted_address,
                        error = %error,
                        "native background attempt failed"
                    );
                    candidate_errors.push(format!(
                        "host={} address={} error={error}",
                        attempted_host, attempted_address
                    ));
                }
            }
        }

        if candidate_errors.is_empty() {
            Err(anyhow!("no native endpoint candidates available"))
        } else {
            Err(anyhow!(
                "native background candidates exhausted: {}",
                candidate_errors.join(" | ")
            ))
        }
    }

    fn native_attempts(&self, plan: &NativeSessionPlan) -> Vec<NativeAttemptPlan> {
        plan.endpoint_candidates
            .iter()
            .cloned()
            .map(|candidate| NativeAttemptPlan {
                host: candidate.host,
                address: candidate.address,
                bootstrap: plan.bootstrap.clone(),
            })
            .collect()
    }

    async fn run_native_session_attempt(
        &self,
        session_id: &str,
        attempt: NativeAttemptPlan,
    ) -> Result<()> {
        let NativeSessionHandshake {
            mut socket,
            first_frame,
        } = self.connect_native_attempt(&attempt).await?;

        tracing::info!(
            session_id = %session_id,
            host = %attempt.host,
            address = %attempt.address,
            decoded_packet_count = first_frame.len(),
            "native attempt accepted first frame"
        );

        self.session_open(session_id.to_string(), attempt.host.clone())
            .await?;
        self.ingest_decoded_packets(session_id, &attempt.host, first_frame)
            .await?;

        let mut heartbeat = interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    socket
                        .send(Message::Binary(encode_heartbeat_packet()?.into()))
                        .await
                        .with_context(|| format!("native stage=send_heartbeat address={}", attempt.address))?;
                }
                next = socket.next() => {
                    match next {
                        Some(Ok(Message::Binary(bytes))) => {
                            let decoded = decode_packets(&bytes)
                                .with_context(|| format!("native stage=decode_runtime_frame address={}", attempt.address))?;
                            self.ingest_decoded_packets(session_id, &attempt.host, decoded)
                                .await?;
                        }
                        Some(Ok(Message::Close(frame))) => {
                            let reason = close_frame_detail("native stage=runtime_close", &attempt.address, frame);
                            let _ = self.report_disconnect(reason.clone()).await?;
                            return Err(anyhow!(reason));
                        }
                        Some(Ok(_)) => {}
                        Some(Err(error)) => {
                            let reason = format!("native stage=runtime_read address={} error={error}", attempt.address);
                            let _ = self.report_disconnect(reason.clone()).await?;
                            return Err(anyhow!(reason));
                        }
                        None => {
                            let reason = format!("native stage=runtime_eof address={}", attempt.address);
                            let _ = self.report_disconnect(reason.clone()).await?;
                            return Err(anyhow!(reason));
                        }
                    }
                }
            }
        }
    }

    async fn connect_native_attempt(
        &self,
        attempt: &NativeAttemptPlan,
    ) -> Result<NativeSessionHandshake> {
        tracing::info!(
            host = %attempt.host,
            address = %attempt.address,
            room_id = attempt.bootstrap.room_id,
            uid = attempt.bootstrap.uid,
            "native connect_authenticated starting"
        );
        let mut socket = connect_authenticated(attempt).await?;
        tracing::info!(
            host = %attempt.host,
            address = %attempt.address,
            "native connect_authenticated completed"
        );
        let first_frame = self.read_native_first_frame(&mut socket, &attempt.address).await?;
        Ok(NativeSessionHandshake { socket, first_frame })
    }

    async fn read_native_first_frame(
        &self,
        socket: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
        address: &str,
    ) -> Result<Vec<DecodedPacket>> {
        while let Some(message_result) = socket.next().await {
            let message = match message_result {
                Ok(message) => message,
                Err(error) => {
                    tracing::warn!(
                        address = %address,
                        error = %error,
                        error_debug = ?error,
                        "native first frame stream produced websocket error"
                    );
                    return Err(error)
                        .with_context(|| format!("native stage=read_first_frame address={address}"));
                }
            };

            match message {
                Message::Binary(bytes) => {
                    tracing::info!(
                        address = %address,
                        byte_len = bytes.len(),
                        "native first frame received binary payload"
                    );
                    let decoded = decode_packets(&bytes)
                        .with_context(|| format!("native stage=decode_first_frame address={address}"))?;
                    tracing::info!(
                        address = %address,
                        decoded_packet_count = decoded.len(),
                        accepts_first_frame = decoded.iter().any(DecodedPacket::accepts_first_frame),
                        "native first frame decoded"
                    );
                    if decoded.iter().any(DecodedPacket::accepts_first_frame) {
                        return Ok(decoded);
                    }

                    if let Some(detail) = decoded.iter().find_map(rejected_auth_detail) {
                        tracing::warn!(
                            address = %address,
                            detail = %detail,
                            "native first frame rejected by auth reply"
                        );
                        bail!("native stage=read_first_frame_rejected address={address} {detail}");
                    }

                    tracing::warn!(
                        address = %address,
                        decoded = ?decoded,
                        "native first frame rejected without auth acceptance packet"
                    );
                    bail!("native stage=read_first_frame_rejected address={address} decoded={decoded:?}");
                }
                Message::Text(text) => {
                    tracing::warn!(
                        address = %address,
                        text = %text,
                        "native first frame received unexpected text payload"
                    );
                }
                Message::Ping(payload) => {
                    tracing::info!(
                        address = %address,
                        byte_len = payload.len(),
                        "native first frame received ping"
                    );
                }
                Message::Pong(payload) => {
                    tracing::info!(
                        address = %address,
                        byte_len = payload.len(),
                        "native first frame received pong"
                    );
                }
                Message::Frame(_) => {
                    tracing::info!(address = %address, "native first frame received raw frame marker");
                }
                Message::Close(frame) => {
                    let detail = close_frame_detail("native stage=read_first_frame_closed", address, frame);
                    tracing::warn!(address = %address, detail = %detail, "native first frame closed before acceptance");
                    bail!(detail);
                }
            }
        }

        tracing::warn!(address = %address, "native first frame stream ended before acceptance");
        bail!("native stage=read_first_frame_ended address={address}")
    }

    async fn ingest_decoded_packets(
        &self,
        session_id: &str,
        host: &str,
        decoded: Vec<DecodedPacket>,
    ) -> Result<NativePacketIngestSummary> {
        let mut summary = NativePacketIngestSummary::default();
        for packet in decoded {
            match packet {
                DecodedPacket::HeartbeatReply { .. } => {
                    summary.saw_heartbeat_reply = true;
                    self.heartbeat(Some(host.to_string())).await?;
                }
                DecodedPacket::JsonMessage {
                    operation: 5,
                    payload,
                } => {
                    if let Some(event) = protocol_payload_to_event(&payload, session_id) {
                        let _ = self
                            .ingest_protocol_event(
                                event.session_id,
                                event.kind,
                                event.username,
                                event.message,
                                event.count,
                            )
                            .await?;
                        summary.ingested_event_count += 1;
                    }
                }
                _ => {}
            }
        }
        Ok(summary)
    }
}

fn browser_user_agent() -> &'static str {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0"
}

async fn connect_authenticated(
    attempt: &NativeAttemptPlan,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    let referer = format!("https://live.bilibili.com/{}", attempt.bootstrap.room_id);
    let mut request = attempt
        .address
        .as_str()
        .into_client_request()
        .with_context(|| format!("native stage=build_handshake address={}", attempt.address))?;
    request.headers_mut().insert(USER_AGENT, browser_user_agent().parse()?);
    request.headers_mut().insert(ORIGIN, "https://live.bilibili.com".parse()?);
    request.headers_mut().insert(REFERER, referer.parse()?);
    if let Some(cookie) = attempt
        .bootstrap
        .cookie
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        request.headers_mut().insert(COOKIE, cookie.parse()?);
    }

    let (mut socket, _) = connect_async(request)
        .await
        .with_context(|| format!("native stage=connect address={}", attempt.address))?;
    tracing::info!(
        address = %attempt.address,
        room_id = attempt.bootstrap.room_id,
        uid = attempt.bootstrap.uid,
        token_present = !attempt.bootstrap.token.trim().is_empty(),
        cookie_present = attempt.bootstrap.cookie.as_deref().is_some_and(|value| !value.trim().is_empty()),
        "native websocket handshake connected"
    );

    socket
        .send(Message::Binary(
            encode_auth_packet(
                attempt.bootstrap.room_id,
                attempt.bootstrap.uid,
                &attempt.bootstrap.buvid,
                &attempt.bootstrap.token,
            )?
            .into(),
        ))
        .await
        .with_context(|| format!("native stage=send_auth address={}", attempt.address))?;
    tracing::info!(
        address = %attempt.address,
        room_id = attempt.bootstrap.room_id,
        uid = attempt.bootstrap.uid,
        "native auth packet sent"
    );

    socket
        .send(Message::Binary(encode_heartbeat_packet()?.into()))
        .await
        .with_context(|| format!("native stage=send_initial_heartbeat address={}", attempt.address))?;
    tracing::info!(
        address = %attempt.address,
        room_id = attempt.bootstrap.room_id,
        uid = attempt.bootstrap.uid,
        "native initial heartbeat sent"
    );

    Ok(socket)
}

fn rejected_auth_detail(packet: &DecodedPacket) -> Option<String> {
    match packet {
        DecodedPacket::AuthReply { payload } if !payload.is_success() => Some(payload.rejection_detail()),
        _ => None,
    }
}

fn close_frame_detail(
    stage: &str,
    address: &str,
    frame: Option<tokio_tungstenite::tungstenite::protocol::CloseFrame>,
) -> String {
    frame
        .map(|frame| {
            if frame.reason.is_empty() {
                format!("{stage} address={address} code={}", frame.code)
            } else {
                format!("{stage} address={address} code={} reason={}", frame.code, frame.reason)
            }
        })
        .unwrap_or_else(|| format!("{stage} address={address} code=<none>"))
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
        .header(
            reqwest::header::COOKIE,
            source.cookie.clone().unwrap_or_default(),
        )
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
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
        29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
        22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
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

fn cookie_value_by_name<'a>(name: &'a str) -> impl FnOnce(&'a str) -> Option<&'a str> {
    move |cookie| {
        cookie
            .split(';')
            .map(str::trim)
            .find_map(|segment| segment.split_once('=').filter(|(key, _)| *key == name).map(|(_, value)| value))
    }
}

fn native_endpoint_candidates(bootstrap: &DanmakuBootstrapRecord) -> Vec<NativeEndpointCandidate> {
    let mut candidates = Vec::new();

    if let Some(host) = bootstrap.selected_upstream_host.as_deref() {
        candidates.push(NativeEndpointCandidate {
            host: host.to_string(),
            address: native_ws_address(bootstrap, host),
        });
    }

    for entry in &bootstrap.upstream_hosts {
        if candidates.iter().any(|candidate| candidate.host == entry.host) {
            continue;
        }
        candidates.push(NativeEndpointCandidate {
            host: entry.host.clone(),
            address: native_ws_address(bootstrap, &entry.host),
        });
    }

    if !candidates
        .iter()
        .any(|candidate| candidate.host == "broadcastlv.chat.bilibili.com")
    {
        candidates.push(NativeEndpointCandidate {
            host: "broadcastlv.chat.bilibili.com".into(),
            address: "wss://broadcastlv.chat.bilibili.com/sub".into(),
        });
    }

    candidates
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

#[cfg(test)]
mod tests {
    use super::cookie_value_by_name;

    #[test]
    fn extracts_live_buvid_from_cookie() {
        let cookie = "SESSDATA=test; LIVE_BUVID=live-123; buvid3=buvid3-xyz;";
        assert_eq!(cookie_value_by_name("LIVE_BUVID")(cookie), Some("live-123"));
    }

    #[test]
    fn returns_none_when_cookie_key_is_missing() {
        let cookie = "SESSDATA=test; buvid3=buvid3-xyz;";
        assert_eq!(cookie_value_by_name("LIVE_BUVID")(cookie), None);
    }
}

fn protocol_payload_to_event(payload: &str, session_id: &str) -> Option<DanmakuProtocolEvent> {
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
            Some(DanmakuProtocolEvent {
                session_id: session_id.to_string(),
                kind: DanmakuProtocolEventKind::Danmaku,
                username,
                message,
                count: None,
            })
        }
        "SEND_GIFT" => {
            let data = value.get("data")?;
            Some(DanmakuProtocolEvent {
                session_id: session_id.to_string(),
                kind: DanmakuProtocolEventKind::Gift,
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
            Some(DanmakuProtocolEvent {
                session_id: session_id.to_string(),
                kind: DanmakuProtocolEventKind::Superchat,
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
            Some(DanmakuProtocolEvent {
                session_id: session_id.to_string(),
                kind: DanmakuProtocolEventKind::Guard,
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
