use anyhow::Result;
use api_types::MessageRole;
use app_config::{AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig};
use gateway::DanmakuProtocolEventKind;
use tempfile::tempdir;
mod support;
use support::build_test_state;

#[tokio::test]
async fn normalizes_native_danmaku_events_inside_rust() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = build_test_state(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18098,
        },
        storage: StorageConfig {
            database_path: runtime_root
                .join("memory-suite.db")
                .to_string_lossy()
                .to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: PythonConfig {
            executable: "powershell".into(),
            models_root: dir.path().join("python").to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
        },
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
    })
    .await?;

    state
        .gateway
        .ingest_protocol_event(
            "room-raw".into(),
            DanmakuProtocolEventKind::Danmaku,
            "viewer-a".into(),
            "hello native path".into(),
            None,
        )
        .await?;

    state
        .gateway
        .ingest_protocol_event(
            "room-raw".into(),
            DanmakuProtocolEventKind::Gift,
            "viewer-b".into(),
            "辣条".into(),
            Some(3),
        )
        .await?;

    let messages = state.storage.list_messages("room-raw").await?;
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0].role, MessageRole::User);
    assert_eq!(messages[0].text, "hello native path");
    assert!(messages[2].text.contains("viewer-b"));
    assert!(messages[2].text.contains("辣条"));

    let assistant_text = messages[3].text.clone();
    assert!(!assistant_text.trim().is_empty());
    assert_ne!(assistant_text, messages[2].text);

    let live2d = state.live2d.get_state().await?;
    assert_eq!(live2d.subtitle, "");
    assert_eq!(live2d.emotion, "normal");

    Ok(())
}
