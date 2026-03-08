use std::{env, fs, path::Path};

use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub storage: StorageConfig,
    pub python: PythonConfig,
    pub features: FeatureFlags,
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
    }
}

fn parse_bool(value: String, fallback: bool) -> bool {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}
