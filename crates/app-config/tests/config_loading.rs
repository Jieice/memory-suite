use std::{
    env, fs,
    sync::{Mutex, MutexGuard, OnceLock},
};

use app_config::{
    AppConfig, normalize_chat_completions_endpoint, normalize_health_path,
    normalize_service_endpoint,
};
use tempfile::tempdir;

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const APP_CONFIG_ENV_VARS: &[&str] = &[
    "MEMORY_SUITE_HOST",
    "MEMORY_SUITE_PORT",
    "MEMORY_SUITE_LLM_TIMEOUT_MS",
    "MEMORY_SUITE_LLM_FALLBACK_TIMEOUT_MS",
    "MEMORY_SUITE_DATABASE_PATH",
    "MEMORY_SUITE_DATA_ROOT",
    "MEMORY_SUITE_PYTHON_EXECUTABLE",
    "MEMORY_SUITE_MODELS_ROOT",
    "MEMORY_SUITE_ENABLE_MOCK_TTS",
    "MEMORY_SUITE_TTS_PROVIDER",
    "MEMORY_SUITE_TTS_ENDPOINT",
    "MEMORY_SUITE_TTS_HEALTH_PATH",
    "MEMORY_SUITE_TTS_CHAT_VOICE",
    "MEMORY_SUITE_TTS_RATE",
    "MEMORY_SUITE_LLM_ENDPOINT",
    "MEMORY_SUITE_LLM_BASE_URL",
    "MEMORY_SUITE_LLM_MODEL",
    "MEMORY_SUITE_LLM_API_KEY",
    "MEMORY_SUITE_LLM_SYSTEM_PROMPT",
    "MEMORY_SUITE_STT_PROVIDER",
    "MEMORY_SUITE_STT_ENDPOINT",
    "MEMORY_SUITE_STT_MODEL",
    "MEMORY_SUITE_STT_API_KEY",
    "MEMORY_SUITE_STT_LANGUAGE",
    "MEMORY_SUITE_STT_PROMPT",
    "MEMORY_SUITE_STT_DEVICE",
    "MEMORY_SUITE_STT_COMPUTE_TYPE",
];

fn env_lock() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("env lock poisoned")
}

struct EnvGuard {
    _lock: MutexGuard<'static, ()>,
    original_values: Vec<(&'static str, Option<String>)>,
}

impl EnvGuard {
    fn hermetic(vars: &[(&'static str, &'static str)]) -> Self {
        let lock = env_lock();
        let original_values = APP_CONFIG_ENV_VARS
            .iter()
            .map(|key| (*key, env::var(key).ok()))
            .collect::<Vec<_>>();

        for key in APP_CONFIG_ENV_VARS {
            unsafe {
                env::remove_var(key);
            }
        }

        for (key, value) in vars {
            unsafe {
                env::set_var(key, value);
            }
        }

        Self {
            _lock: lock,
            original_values,
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, original_value) in self.original_values.iter().rev() {
            match original_value {
                Some(value) => unsafe {
                    env::set_var(key, value);
                },
                None => unsafe {
                    env::remove_var(key);
                },
            }
        }
    }
}

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
speech_rate = "1.2"

[llm]
endpoint = "https://example.com/v1/chat/completions"
model = "gpt-5.4"
api_key = "test-key"
system_prompt = "请用中文回复"
"#,
    )
    .expect("write config");

    let _env = EnvGuard::hermetic(&[
        ("MEMORY_SUITE_PORT", "9090"),
        ("MEMORY_SUITE_DATABASE_PATH", "./runtime/override.db"),
        (
            "MEMORY_SUITE_LLM_ENDPOINT",
            "https://override.example.com/v1/chat/completions",
        ),
        ("MEMORY_SUITE_LLM_MODEL", "gpt-5.4"),
        ("MEMORY_SUITE_LLM_API_KEY", "override-key"),
        ("MEMORY_SUITE_LLM_SYSTEM_PROMPT", "请务必用中文直接回答"),
        ("MEMORY_SUITE_TTS_PROVIDER", "sovits"),
        ("MEMORY_SUITE_TTS_ENDPOINT", "http://127.0.0.1:9882"),
        ("MEMORY_SUITE_TTS_CHAT_VOICE", "override-voice"),
        ("MEMORY_SUITE_TTS_RATE", "1.4"),
    ]);

    let config = AppConfig::load_from_file(&config_path).expect("load config");

    assert_eq!(config.server.port, 9090);
    assert_eq!(config.storage.database_path, "./runtime/override.db");
    assert_eq!(config.server.host, "127.0.0.1");
    assert!(config.features.enable_mock_tts);
    assert_eq!(config.tts.provider.as_deref(), Some("sovits"));
    assert_eq!(
        config.tts.endpoint.as_deref(),
        Some("http://127.0.0.1:9882")
    );
    assert_eq!(config.tts.health_path.as_deref(), Some("/voices"));
    assert_eq!(config.tts.chat_voice.as_deref(), Some("override-voice"));
    assert_eq!(config.tts.speech_rate.as_deref(), Some("1.4"));
    assert_eq!(
        config.llm.endpoint.as_deref(),
        Some("https://override.example.com/v1/chat/completions")
    );
    assert_eq!(config.llm.model.as_deref(), Some("gpt-5.4"));
    assert_eq!(config.llm.api_key.as_deref(), Some("override-key"));
    assert_eq!(
        config.llm.system_prompt.as_deref(),
        Some("请务必用中文直接回答")
    );
}

#[test]
fn concrete_chat_voice_can_be_loaded_from_toml() {
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
chat_voice = "zh-CN-YunxiNeural"
speech_rate = "1.2"

[llm]
endpoint = "https://example.com/v1/chat/completions"
model = "gpt-5.4"
api_key = "test-key"
system_prompt = "请用中文回复"
"#,
    )
    .expect("write config");

    let _env = EnvGuard::hermetic(&[]);
    let config = AppConfig::load_from_file(&config_path).expect("load config");

    assert_eq!(config.tts.chat_voice.as_deref(), Some("zh-CN-YunxiNeural"));
}

#[test]
fn tts_rate_can_be_loaded_from_toml_and_env() {
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
speech_rate = "1.2"
"#,
    )
    .expect("write config");

    let _env = EnvGuard::hermetic(&[("MEMORY_SUITE_TTS_RATE", "1.4")]);

    let config = AppConfig::load_from_file(&config_path).expect("load config");

    assert_eq!(config.tts.speech_rate.as_deref(), Some("1.4"));
}

#[test]
fn alternate_port_env_overrides_toml_port() {
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
enable_mock_tts = false
"#,
    )
    .expect("write config");

    let _env = EnvGuard::hermetic(&[("MEMORY_SUITE_PORT", "18080")]);
    let config = AppConfig::load_from_file(&config_path).expect("load config");

    assert_eq!(config.server.port, 18080);
    assert_eq!(config.server.host, "127.0.0.1");
}

#[test]
fn llm_endpoint_env_is_normalized_to_chat_completions() {
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

    let _env = EnvGuard::hermetic(&[
        ("MEMORY_SUITE_LLM_ENDPOINT", "https://api.openai.com/v1/"),
        ("MEMORY_SUITE_TTS_ENDPOINT", "http://127.0.0.1:9881/"),
        ("MEMORY_SUITE_TTS_HEALTH_PATH", "voices"),
    ]);

    let config = AppConfig::load_from_file(&config_path).expect("load config");

    assert_eq!(
        config.llm.endpoint.as_deref(),
        Some("https://api.openai.com/v1/chat/completions")
    );
    assert_eq!(config.tts.endpoint.as_deref(), Some("http://127.0.0.1:9881"));
    assert_eq!(config.tts.health_path.as_deref(), Some("/voices"));
}

#[test]
fn stt_device_and_compute_type_load_from_toml_and_env() {
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

[stt]
provider = "faster-whisper"
model = "small"
device = "cuda"
compute_type = "int8_float16"
"#,
    )
    .expect("write config");

    // TOML values load as written.
    {
        let _env = EnvGuard::hermetic(&[]);
        let config = AppConfig::load_from_file(&config_path).expect("load config");
        assert_eq!(config.stt.device.as_deref(), Some("cuda"));
        assert_eq!(config.stt.compute_type.as_deref(), Some("int8_float16"));
    }

    // Env overrides win over TOML — this is the daemon-bootstrap path that
    // steers the faster-whisper worker onto a given device.
    {
        let _env = EnvGuard::hermetic(&[
            ("MEMORY_SUITE_STT_DEVICE", "cpu"),
            ("MEMORY_SUITE_STT_COMPUTE_TYPE", "int8"),
        ]);
        let config = AppConfig::load_from_file(&config_path).expect("load config");
        assert_eq!(config.stt.device.as_deref(), Some("cpu"));
        assert_eq!(config.stt.compute_type.as_deref(), Some("int8"));
    }
}

#[test]
fn normalization_helpers_handle_common_suffixes() {
    assert_eq!(
        normalize_chat_completions_endpoint("https://api.openai.com"),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        normalize_chat_completions_endpoint("https://api.openai.com/v1/"),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        normalize_chat_completions_endpoint("https://api.openai.com/chat/completions/"),
        "https://api.openai.com/chat/completions"
    );
    assert_eq!(
        normalize_service_endpoint("http://127.0.0.1:9881/"),
        "http://127.0.0.1:9881"
    );
    assert_eq!(normalize_health_path("voices"), "/voices");
}

#[test]
fn invalid_port_env_is_silently_ignored_and_toml_value_used() {
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
enable_mock_tts = false
"#,
    )
    .expect("write config");

    let _env = EnvGuard::hermetic(&[("MEMORY_SUITE_PORT", "not-a-number")]);
    let config = AppConfig::load_from_file(&config_path).expect("load config");

    // Non-numeric value is silently ignored; TOML default is used.
    assert_eq!(config.server.port, 8080);
}
