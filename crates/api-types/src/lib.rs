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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct ChatResponse {
    pub session_id: String,
    pub message_id: Uuid,
    pub response_text: String,
    pub created_at: DateTime<Utc>,
    pub events: Vec<SessionEvent>,
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
    pub status: String,
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
    pub status: String,
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
pub struct LegacyEventRecord {
    pub id: Uuid,
    pub source_path: String,
    pub source_type: String,
    #[ts(type = "unknown")]
    pub payload: Value,
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
pub struct ImportSummary {
    pub status: String,
    pub source_root: String,
    pub user_profiles_imported: u32,
    pub memory_entries_imported: u32,
    pub proactive_events_imported: u32,
    pub config_artifacts_imported: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct ImportRequest {
    pub root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct RuntimeOverview {
    pub db_ready: bool,
    pub message_count: u32,
    pub job_count: u32,
    pub user_profile_count: u32,
    pub memory_entry_count: u32,
    pub legacy_event_count: u32,
    pub config_artifact_count: u32,
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
        exported::<SessionEvent>(),
        exported::<SessionEventKind>(),
        exported::<RuntimeEvent>(),
        exported::<RuntimeEventKind>(),
        exported::<TtsSpeakRequest>(),
        exported::<TtsSpeakResponse>(),
        exported::<JobRequest>(),
        exported::<AdapterStartRequest>(),
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
        exported::<LegacyEventRecord>(),
        exported::<ConfigArtifactRecord>(),
        exported::<ImportSummary>(),
        exported::<ImportRequest>(),
        exported::<RuntimeOverview>(),
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
    }
}
