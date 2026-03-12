use std::{fs, path::Path};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

impl MessageRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }
}

impl From<&str> for MessageRole {
    fn from(value: &str) -> Self {
        match value {
            "assistant" => Self::Assistant,
            "system" => Self::System,
            _ => Self::User,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Train,
    Eval,
}

impl JobKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Train => "train",
            Self::Eval => "eval",
        }
    }
}

impl From<&str> for JobKind {
    fn from(value: &str) -> Self {
        match value {
            "eval" => Self::Eval,
            _ => Self::Train,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
}

impl JobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

impl From<&str> for JobStatus {
    fn from(value: &str) -> Self {
        match value {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            _ => Self::Queued,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum SessionEventKind {
    MessageCreated,
    TtsQueued,
    JobQueued,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEventKind {
    MessageCreated,
    AdapterStarted,
    JobQueued,
    TtsQueued,
    SpeechQueued,
    SpeechReady,
    SpeechStarted,
    SpeechCompleted,
    SpeechFailed,
    DanmakuReceived,
    DanmakuSourceUpdated,
    DanmakuConnectAttempted,
    DanmakuConnectionConnecting,
    DanmakuConnectionDisconnected,
    DanmakuHeartbeatReceived,
    DanmakuReconnectScheduled,
    Live2dSubtitleUpdated,
    Live2dEmotionUpdated,
    Live2dConfigUpdated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum AdapterStatus {
    Starting,
    Running,
    Stopped,
    Failed,
}

impl AdapterStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }
}

impl From<&str> for AdapterStatus {
    fn from(value: &str) -> Self {
        match value {
            "starting" => Self::Starting,
            "stopped" => Self::Stopped,
            "failed" => Self::Failed,
            _ => Self::Running,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub db_ready: bool,
    pub runtime_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct ChatRequest {
    pub session_id: Option<String>,
    pub user_id: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct ChatResponse {
    pub session_id: String,
    pub message_id: Uuid,
    pub assistant_text: String,
    pub created_at: DateTime<Utc>,
    pub speech: SpeechPlaybackPlan,
    pub animation: Live2dAnimationPlan,
    pub events: Vec<SessionEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct SpeechPlaybackPlan {
    pub request_id: String,
    pub status: String,
    pub audio_url: Option<String>,
    #[ts(type = "number")]
    pub duration_ms: u64,
    pub viseme_timeline: Vec<VisemeCue>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct VisemeCue {
    #[ts(type = "number")]
    pub start_ms: u64,
    #[ts(type = "number")]
    pub end_ms: u64,
    pub viseme: String,
    pub mouth_open: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct Live2dAnimationPlan {
    pub emotion: String,
    pub subtitle_text: String,
    pub motion_timeline: Vec<MotionCue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct MotionCue {
    #[ts(type = "number")]
    pub at_ms: u64,
    #[ts(type = "number")]
    pub duration_ms: u64,
    pub motion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct Live2dSpeechRecord {
    pub id: String,
    pub session_id: String,
    pub message_id: Uuid,
    pub assistant_text: String,
    pub speech: SpeechPlaybackPlan,
    pub animation: Live2dAnimationPlan,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct Live2dSpeechNextResponse {
    pub item: Option<Live2dSpeechRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct Live2dSpeechAckRequest {
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct Live2dSpeechAckResponse {
    pub ok: bool,
    pub item: Option<Live2dSpeechRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct SessionEvent {
    pub session_id: String,
    pub kind: SessionEventKind,
    pub detail: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct RuntimeEvent {
    pub id: Uuid,
    pub kind: RuntimeEventKind,
    pub source: String,
    pub detail: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct TtsSpeakRequest {
    pub session_id: Option<String>,
    pub text: String,
    pub voice: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct TtsSpeakResponse {
    pub request_id: Uuid,
    pub status: String,
    pub audio_path: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct JobRequest {
    pub input: Option<String>,
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct AdapterStartRequest {
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct JobResponse {
    pub job_id: Uuid,
    pub kind: JobKind,
    pub status: JobStatus,
    pub adapter_id: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct AdapterRecord {
    pub id: Uuid,
    pub adapter_id: String,
    pub status: AdapterStatus,
    pub python_executable: String,
    pub args: Vec<String>,
    pub pid: Option<u32>,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct StoredMessage {
    pub id: Uuid,
    pub session_id: String,
    pub role: MessageRole,
    pub text: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct JobRecord {
    pub id: Uuid,
    pub kind: JobKind,
    pub status: JobStatus,
    pub input: Option<String>,
    pub profile: Option<String>,
    pub adapter_id: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct TtsRequestRecord {
    pub id: Uuid,
    pub session_id: String,
    pub text: String,
    pub voice: Option<String>,
    pub status: String,
    pub adapter_id: Option<String>,
    pub audio_path: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct UserProfileRecord {
    pub user_id: String,
    pub preferred_name: Option<String>,
    pub interaction_count: i64,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct MemoryEntryRecord {
    pub id: Uuid,
    pub user_id: String,
    pub entry_type: String,
    #[ts(type = "unknown")]
    pub payload: Value,
    pub source: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct ConfigArtifactRecord {
    pub id: Uuid,
    pub path: String,
    pub kind: String,
    #[ts(type = "unknown")]
    pub payload: Value,
    pub copied_to: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct RuntimeOverview {
    pub db_ready: bool,
    pub message_count: u32,
    pub job_count: u32,
    pub user_profile_count: u32,
    pub memory_entry_count: u32,
    pub config_artifact_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct KnowledgeCatalogQuery {
    pub query: Option<String>,
    #[ts(type = "number")]
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct KnowledgeCatalogResponse {
    pub query: Option<String>,
    #[ts(type = "number")]
    pub limit: u32,
    pub profiles: Vec<UserProfileRecord>,
    pub memory_entries: Vec<MemoryEntryRecord>,
    pub config_artifacts: Vec<ConfigArtifactRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct ToolSchemaRecord {
    pub name: String,
    pub description: Option<String>,
    pub action_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct ToolManifestRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub runtime: String,
    pub entry: String,
    pub enabled_by_default: bool,
    pub access_level: String,
    pub confirmation_level: Option<String>,
    pub description: Option<String>,
    pub schema_count: u32,
    pub schemas: Vec<ToolSchemaRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct ToolExecutionRequest {
    pub tool_id: String,
    #[ts(type = "unknown")]
    pub args: Value,
    #[ts(type = "number | null")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct ToolExecutionResponse {
    pub execution_id: String,
    pub tool_id: String,
    #[ts(type = "unknown")]
    pub args: Value,
    pub ok: bool,
    pub status: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    #[ts(type = "number")]
    pub duration_ms: u64,
    #[ts(type = "unknown | null")]
    pub output: Option<Value>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub error: Option<String>,
    pub executed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct Live2dConfigRecord {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct Live2dStateRecord {
    pub subtitle: String,
    #[ts(type = "number")]
    pub subtitle_duration_ms: u64,
    pub emotion: String,
    pub config: Live2dConfigRecord,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct Live2dSubtitleRequest {
    pub text: String,
    #[ts(type = "number")]
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct Live2dEmotionRequest {
    pub emotion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct Live2dConfigRequest {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuInjectRequest {
    pub session_id: String,
    pub user_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuSourceConfigRecord {
    pub room_id: String,
    #[ts(type = "number")]
    pub uid: u64,
    pub buvid: String,
    pub has_cookie: bool,
    pub signature_mode: String,
    pub connection_mode: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuSourceUpdateRequest {
    pub room_id: String,
    #[ts(type = "number")]
    pub uid: u64,
    pub buvid: String,
    pub cookie: Option<String>,
    pub signature_mode: String,
    pub connection_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuConnectionStateRecord {
    pub status: String,
    #[ts(type = "number")]
    pub attempt_count: u32,
    #[ts(type = "number")]
    pub consecutive_failures: u32,
    #[ts(type = "number")]
    pub retry_delay_ms: u32,
    pub session_id: Option<String>,
    pub current_upstream_host: Option<String>,
    pub last_connect_attempt_at: Option<DateTime<Utc>>,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
    pub next_retry_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub last_close_reason: Option<String>,
    pub adapter_id: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuConnectionActionResponse {
    pub ok: bool,
    pub state: DanmakuConnectionStateRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuHostRecord {
    pub host: String,
    pub port: u16,
    pub wss_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuBootstrapRecord {
    pub requested_room_id: String,
    pub resolved_room_id: String,
    pub live_status: u32,
    pub token_ready: bool,
    #[serde(skip_serializing, default)]
    #[ts(skip)]
    pub token: String,
    pub upstream_hosts: Vec<DanmakuHostRecord>,
    pub selected_upstream_host: Option<String>,
    pub fetched_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuHeartbeatRequest {
    pub upstream_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuDisconnectReportRequest {
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuSessionOpenRequest {
    pub session_id: String,
    pub upstream_host: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuSessionErrorRequest {
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuSessionCloseRequest {
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuProtocolEventType {
    Danmaku,
    Gift,
    Superchat,
    Guard,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuProtocolEventRequest {
    pub session_id: String,
    pub event_type: DanmakuProtocolEventType,
    pub username: String,
    pub message: String,
    #[ts(type = "number | null")]
    pub count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuNativeProbeResponse {
    pub host: String,
    #[ts(type = "number")]
    pub decoded_packet_count: u32,
    pub saw_heartbeat_reply: bool,
    pub saw_message_frame: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct DanmakuNativeConnectResponse {
    pub host: String,
    pub session_id: String,
    #[ts(type = "number")]
    pub decoded_packet_count: u32,
    #[ts(type = "number")]
    pub ingested_event_count: u32,
    pub saw_heartbeat_reply: bool,
    pub state: DanmakuConnectionStateRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct FallbackStatsRecord {
    #[ts(type = "number")]
    pub remote_successes: u32,
    #[ts(type = "number")]
    pub remote_timeouts: u32,
    #[ts(type = "number")]
    pub builtin_fallbacks: u32,
    pub last_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct PersonaRuntimeStateRecord {
    pub mode: String,
    pub tone_profile: String,
    #[ts(type = "number")]
    pub warmth: f32,
    #[ts(type = "number")]
    pub sarcasm: f32,
    #[ts(type = "number")]
    pub autonomy: f32,
    pub current_context: String,
    pub fallback: FallbackStatsRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct PersonaRuntimeConfigRecord {
    pub mode: String,
    pub tone_profile: String,
    #[ts(type = "number")]
    pub warmth: f32,
    #[ts(type = "number")]
    pub sarcasm: f32,
    #[ts(type = "number")]
    pub autonomy: f32,
    pub current_context: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct PersonaRuntimeConfigUpdateRequest {
    pub mode: Option<String>,
    pub tone_profile: Option<String>,
    #[ts(type = "number | null")]
    pub warmth: Option<f32>,
    #[ts(type = "number | null")]
    pub sarcasm: Option<f32>,
    #[ts(type = "number | null")]
    pub autonomy: Option<f32>,
    pub current_context: Option<String>,
}

pub fn write_typescript_bindings(output_path: impl AsRef<Path>) -> std::io::Result<()> {
    fn exported<T: TS>() -> String {
        let decl = T::decl();
        if decl.trim_start().starts_with("export ") {
            decl
        } else {
            format!("export {decl}")
        }
    }

    let bindings = [
        "// Generated by crates/api-types. Do not edit by hand.".to_string(),
        exported::<HealthResponse>(),
        exported::<ChatRequest>(),
        exported::<ChatResponse>(),
        exported::<SpeechPlaybackPlan>(),
        exported::<VisemeCue>(),
        exported::<Live2dAnimationPlan>(),
        exported::<MotionCue>(),
        exported::<Live2dSpeechRecord>(),
        exported::<Live2dSpeechNextResponse>(),
        exported::<Live2dSpeechAckRequest>(),
        exported::<Live2dSpeechAckResponse>(),
        exported::<SessionEvent>(),
        exported::<SessionEventKind>(),
        exported::<RuntimeEvent>(),
        exported::<RuntimeEventKind>(),
        exported::<TtsSpeakRequest>(),
        exported::<TtsSpeakResponse>(),
        exported::<JobRequest>(),
        exported::<AdapterStartRequest>(),
        exported::<JobStatus>(),
        exported::<JobResponse>(),
        exported::<AdapterStatus>(),
        exported::<AdapterRecord>(),
        exported::<StoredMessage>(),
        exported::<MessageRole>(),
        exported::<JobKind>(),
        exported::<JobRecord>(),
        exported::<TtsRequestRecord>(),
        exported::<UserProfileRecord>(),
        exported::<MemoryEntryRecord>(),
        exported::<ConfigArtifactRecord>(),
        exported::<RuntimeOverview>(),
        exported::<KnowledgeCatalogQuery>(),
        exported::<KnowledgeCatalogResponse>(),
        exported::<ToolSchemaRecord>(),
        exported::<ToolManifestRecord>(),
        exported::<ToolExecutionRequest>(),
        exported::<ToolExecutionResponse>(),
        exported::<Live2dConfigRecord>(),
        exported::<Live2dStateRecord>(),
        exported::<Live2dSubtitleRequest>(),
        exported::<Live2dEmotionRequest>(),
        exported::<Live2dConfigRequest>(),
        exported::<DanmakuInjectRequest>(),
        exported::<DanmakuSourceConfigRecord>(),
        exported::<DanmakuSourceUpdateRequest>(),
        exported::<DanmakuConnectionStateRecord>(),
        exported::<DanmakuConnectionActionResponse>(),
        exported::<DanmakuHostRecord>(),
        exported::<DanmakuBootstrapRecord>(),
        exported::<DanmakuHeartbeatRequest>(),
        exported::<DanmakuDisconnectReportRequest>(),
        exported::<DanmakuSessionOpenRequest>(),
        exported::<DanmakuSessionErrorRequest>(),
        exported::<DanmakuSessionCloseRequest>(),
        exported::<DanmakuProtocolEventType>(),
        exported::<DanmakuProtocolEventRequest>(),
        exported::<DanmakuNativeProbeResponse>(),
        exported::<DanmakuNativeConnectResponse>(),
        exported::<FallbackStatsRecord>(),
        exported::<PersonaRuntimeStateRecord>(),
        exported::<PersonaRuntimeConfigRecord>(),
        exported::<PersonaRuntimeConfigUpdateRequest>(),
    ]
    .join("\n\n");

    if let Some(parent) = output_path.as_ref().parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output_path, bindings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_typescript_bindings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = dir.path().join("api.ts");

        write_typescript_bindings(&output).expect("write bindings");
        let generated = fs::read_to_string(output).expect("read bindings");

        assert!(generated.contains("HealthResponse"));
        assert!(generated.contains("ChatRequest"));
        assert!(generated.contains("TtsSpeakRequest"));
        assert!(generated.contains("PersonaRuntimeStateRecord"));
        assert!(generated.contains("FallbackStatsRecord"));
    }

    #[test]
    fn persona_runtime_state_serializes_for_web() {
        let payload = PersonaRuntimeStateRecord {
            mode: "stream".into(),
            tone_profile: "sharp-playful".into(),
            warmth: 0.45,
            sarcasm: 0.65,
            autonomy: 0.20,
            current_context: "explaining".into(),
            fallback: FallbackStatsRecord {
                remote_successes: 10,
                remote_timeouts: 3,
                builtin_fallbacks: 5,
                last_path: "remote".into(),
            },
        };

        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["tone_profile"], "sharp-playful");
        assert_eq!(value["fallback"]["last_path"], "remote");
        assert_eq!(value["fallback"]["builtin_fallbacks"], 5);
    }
}
