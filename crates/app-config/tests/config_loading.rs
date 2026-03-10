use std::{env, fs};

use app_config::AppConfig;
use tempfile::tempdir;

#[test]
fn loads_from_toml_and_applies_environment_overrides() {
    let dir = tempdir().expect("tempdir");
    let config_path = dir.path().join("app.toml");
    fs::write(
        &config_path,
        r#"
[server]
host = "127.0.0.1"
port = 8080

[storage]
database_path = "./runtime/default.db"
data_root = "./runtime"

[python]
executable = "python"
models_root = "./python"

[features]
enable_mock_tts = true

[tts]
provider = "edge_tts"
endpoint = "http://127.0.0.1:9881"
health_path = "/voices"
chat_voice = "edge-tts-zh"

[llm]
endpoint = "https://example.com/v1/chat/completions"
model = "gpt-5.4"
api_key = "test-key"
system_prompt = "请用中文回复"
"#,
    )
    .expect("write config");

    unsafe {
        env::set_var("MEMORY_SUITE_PORT", "9090");
        env::set_var("MEMORY_SUITE_DATABASE_PATH", "./runtime/override.db");
        env::set_var(
            "MEMORY_SUITE_LLM_ENDPOINT",
            "https://override.example.com/v1/chat/completions",
        );
        env::set_var("MEMORY_SUITE_LLM_MODEL", "gpt-5.4");
        env::set_var("MEMORY_SUITE_LLM_API_KEY", "override-key");
        env::set_var("MEMORY_SUITE_LLM_SYSTEM_PROMPT", "请务必用中文直接回答");
        env::set_var("MEMORY_SUITE_TTS_PROVIDER", "sovits");
        env::set_var("MEMORY_SUITE_TTS_ENDPOINT", "http://127.0.0.1:9882");
    }

    let config = AppConfig::load_from_file(&config_path).expect("load config");

    assert_eq!(config.server.port, 9090);
    assert_eq!(config.storage.database_path, "./runtime/override.db");
    assert_eq!(config.server.host, "127.0.0.1");
    assert!(config.features.enable_mock_tts);
    assert!(!config.features.enable_legacy_import);
    assert_eq!(config.tts.provider.as_deref(), Some("sovits"));
    assert_eq!(config.tts.endpoint.as_deref(), Some("http://127.0.0.1:9882"));
    assert_eq!(config.tts.health_path.as_deref(), Some("/voices"));
    assert_eq!(config.tts.chat_voice.as_deref(), Some("edge-tts-zh"));
    assert_eq!(
        config.llm.endpoint.as_deref(),
        Some("https://override.example.com/v1/chat/completions")
    );
    assert_eq!(config.llm.model.as_deref(), Some("gpt-5.4"));
    assert_eq!(config.llm.api_key.as_deref(), Some("override-key"));
    assert_eq!(config.llm.system_prompt.as_deref(), Some("请务必用中文直接回答"));

    unsafe {
        env::remove_var("MEMORY_SUITE_PORT");
        env::remove_var("MEMORY_SUITE_DATABASE_PATH");
        env::remove_var("MEMORY_SUITE_LLM_ENDPOINT");
        env::remove_var("MEMORY_SUITE_LLM_MODEL");
        env::remove_var("MEMORY_SUITE_LLM_API_KEY");
        env::remove_var("MEMORY_SUITE_LLM_SYSTEM_PROMPT");
        env::remove_var("MEMORY_SUITE_TTS_PROVIDER");
        env::remove_var("MEMORY_SUITE_TTS_ENDPOINT");
    }
}

#[test]
fn legacy_tts_env_only_applies_when_formal_tts_config_is_absent() {
    let dir = tempdir().expect("tempdir");
    let config_path = dir.path().join("app.toml");
    fs::write(
        &config_path,
        r#"
[server]
host = "127.0.0.1"
port = 8080

[storage]
database_path = "./runtime/default.db"
data_root = "./runtime"

[python]
executable = "python"
models_root = "./python"

[features]
enable_mock_tts = true
"#,
    )
    .expect("write config");

    unsafe {
        env::set_var("TTS_ENGINE", "sovits");
        env::set_var("SOVITS_API_URL", "http://127.0.0.1:9882");
        env::set_var("MEMORY_SUITE_CHAT_TTS_VOICE", "legacy-voice");
    }

    let config = AppConfig::load_from_file(&config_path).expect("load config");

    assert_eq!(config.tts.provider.as_deref(), Some("sovits"));
    assert_eq!(config.tts.endpoint.as_deref(), Some("http://127.0.0.1:9882"));
    assert_eq!(config.tts.chat_voice.as_deref(), Some("legacy-voice"));

    unsafe {
        env::remove_var("TTS_ENGINE");
        env::remove_var("SOVITS_API_URL");
        env::remove_var("MEMORY_SUITE_CHAT_TTS_VOICE");
    }
}
