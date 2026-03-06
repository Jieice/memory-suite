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
enable_legacy_import = false
"#,
    )
    .expect("write config");

    // SAFETY: test-scoped environment mutation
    unsafe {
        env::set_var("MEMORY_SUITE_PORT", "9090");
        env::set_var("MEMORY_SUITE_DATABASE_PATH", "./runtime/override.db");
    }

    let config = AppConfig::load_from_file(&config_path).expect("load config");

    assert_eq!(config.server.port, 9090);
    assert_eq!(config.storage.database_path, "./runtime/override.db");
    assert_eq!(config.server.host, "127.0.0.1");
    assert!(config.features.enable_mock_tts);
    assert!(!config.features.enable_legacy_import);

    // SAFETY: test cleanup for process environment
    unsafe {
        env::remove_var("MEMORY_SUITE_PORT");
        env::remove_var("MEMORY_SUITE_DATABASE_PATH");
    }
}
