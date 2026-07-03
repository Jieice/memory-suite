use std::{env, fs, path::Path};

use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub storage: StorageConfig,
    pub python: PythonConfig,
    pub features: FeatureFlags,
    #[serde(default)]
    pub tts: TtsConfig,
    #[serde(default)]
    pub llm: LlmConfig,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct StorageConfig {
    pub database_path: String,
    pub data_root: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PythonConfig {
    pub executable: String,
    pub models_root: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct FeatureFlags {
    pub enable_mock_tts: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
pub struct TtsConfig {
    pub provider: Option<String>,
    pub endpoint: Option<String>,
    pub health_path: Option<String>,
    pub chat_voice: Option<String>,
    pub speech_rate: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
pub struct LlmConfig {
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub system_prompt: Option<String>,
    /// Total timeout for a remote LLM request in milliseconds. Default: 15000.
    pub remote_timeout_ms: Option<u64>,
    /// Fast-path fallback budget in milliseconds — if remote does not respond
    /// within this window the runtime falls back to built-in responses.
    /// Default: 100.
    pub fallback_timeout_ms: Option<u64>,
}

impl AppConfig {
    pub fn load_from_file(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read config file at {}", path.display()))?;
        let mut config: AppConfig =
            toml::from_str(&raw).with_context(|| format!("invalid TOML in {}", path.display()))?;
        config.apply_environment_overrides();
        Ok(config)
    }

    fn apply_environment_overrides(&mut self) {
        if let Ok(value) = env::var("MEMORY_SUITE_HOST") {
            self.server.host = value;
        }
        if let Ok(value) = env::var("MEMORY_SUITE_PORT") {
            if let Ok(parsed) = value.parse::<u16>() {
                self.server.port = parsed;
            }
        }
        if let Ok(value) = env::var("MEMORY_SUITE_DATABASE_PATH") {
            self.storage.database_path = value;
        }
        if let Ok(value) = env::var("MEMORY_SUITE_DATA_ROOT") {
            self.storage.data_root = value;
        }
        if let Ok(value) = env::var("MEMORY_SUITE_PYTHON_EXECUTABLE") {
            self.python.executable = value;
        }
        if let Ok(value) = env::var("MEMORY_SUITE_MODELS_ROOT") {
            self.python.models_root = value;
        }
        if let Ok(value) = env::var("MEMORY_SUITE_ENABLE_MOCK_TTS") {
            self.features.enable_mock_tts = parse_bool(value, self.features.enable_mock_tts);
        }
        if let Ok(value) = env::var("MEMORY_SUITE_TTS_PROVIDER") {
            self.tts.provider = normalize_optional(value);
        }
        if let Ok(value) = env::var("MEMORY_SUITE_TTS_ENDPOINT") {
            self.tts.endpoint = normalize_optional(value).map(normalize_endpoint);
        }
        if let Ok(value) = env::var("MEMORY_SUITE_TTS_HEALTH_PATH") {
            self.tts.health_path = normalize_optional(value);
        }
        if let Ok(value) = env::var("MEMORY_SUITE_TTS_CHAT_VOICE") {
            self.tts.chat_voice = normalize_optional(value);
        }
        if let Ok(value) = env::var("MEMORY_SUITE_TTS_RATE") {
            self.tts.speech_rate = normalize_optional(value);
        }
        if let Ok(value) = env::var("MEMORY_SUITE_LLM_ENDPOINT") {
            self.llm.endpoint = Some(value);
        }
        if let Ok(value) = env::var("MEMORY_SUITE_LLM_BASE_URL") {
            self.llm.endpoint = Some(format!(
                "{}/v1/chat/completions",
                value.trim_end_matches('/')
            ));
        }
        if let Ok(value) = env::var("MEMORY_SUITE_LLM_MODEL") {
            self.llm.model = Some(value);
        }
        if let Ok(value) = env::var("MEMORY_SUITE_LLM_API_KEY") {
            self.llm.api_key = Some(value);
        }
        if let Ok(value) = env::var("MEMORY_SUITE_LLM_SYSTEM_PROMPT") {
            self.llm.system_prompt = Some(value);
        }
        if let Ok(value) = env::var("MEMORY_SUITE_LLM_TIMEOUT_MS") {
            if let Ok(parsed) = value.parse::<u64>() {
                self.llm.remote_timeout_ms = Some(parsed);
            }
        }
        if let Ok(value) = env::var("MEMORY_SUITE_LLM_FALLBACK_TIMEOUT_MS") {
            if let Ok(parsed) = value.parse::<u64>() {
                self.llm.fallback_timeout_ms = Some(parsed);
            }
        }
    }
}

fn parse_bool(value: String, fallback: bool) -> bool {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn normalize_optional(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn normalize_endpoint(value: String) -> String {
    value.trim().trim_end_matches('/').to_string()
}
