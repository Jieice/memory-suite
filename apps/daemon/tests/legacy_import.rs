use std::{fs, path::Path};

use anyhow::Result;
use api_types::ImportSummary;
use app_config::AppConfig;
use daemon::{AppState, import_legacy_from_root};
use tempfile::tempdir;

fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent directories");
    }
    fs::write(path, contents).expect("write file");
}

#[tokio::test]
async fn imports_legacy_json_jsonl_and_config_files_into_unified_storage() -> Result<()> {
    let dir = tempdir()?;
    let old_root = dir.path().join("legacy");
    let runtime_root = dir.path().join("runtime");

    write_file(
        &old_root.join("data/canonical-memory.json"),
        r#"
{
  "version": 1,
  "users": {
    "viewer-1": {
      "userId": "viewer-1",
      "preferredName": "Alpha",
      "facts": [{"topic":"anime","value":"likes idol shows"}],
      "preferences": [{"item":"voice","value":"soft"}],
      "tasks": [{"task":"watch stream replay"}],
      "conflicts": [{"reason":"spoiler sensitivity"}],
      "interactionCount": 12,
      "updatedAt": 1770630827385
    }
  }
}
"#,
    );

    write_file(
        &old_root.join("data/proactive-memory.jsonl"),
        r#"{"timestamp":1766761104085,"query":"抓取并总结","response":"已总结完成"}
{"timestamp":1766761104099,"query":"弹幕提醒","response":"已经记录"}"#,
    );

    write_file(
        &old_root.join("memory-danmaku/config.example.json"),
        r#"{"roomId":123456,"userId":"danmaku","triggerPrefix":"!"}"#,
    );

    let config = AppConfig {
        server: app_config::ServerConfig {
            host: "127.0.0.1".into(),
            port: 18080,
        },
        storage: app_config::StorageConfig {
            database_path: runtime_root
                .join("memory-suite.db")
                .to_string_lossy()
                .to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: app_config::PythonConfig {
            executable: "python".into(),
            models_root: old_root.join("python").to_string_lossy().to_string(),
        },
        features: app_config::FeatureFlags {
            enable_mock_tts: true,
            enable_legacy_import: true,
        },
    };

    let state = AppState::from_config(config).await?;
    let summary: ImportSummary = import_legacy_from_root(&state, &old_root).await?;

    assert_eq!(summary.user_profiles_imported, 1);
    assert_eq!(summary.memory_entries_imported, 4);
    assert_eq!(summary.proactive_events_imported, 2);
    assert_eq!(summary.config_artifacts_imported, 1);

    let counts = state.storage.import_counts().await?;
    assert_eq!(counts.user_profiles, 1);
    assert_eq!(counts.memory_entries, 4);
    assert_eq!(counts.legacy_events, 2);
    assert_eq!(counts.config_artifacts, 1);

    Ok(())
}
