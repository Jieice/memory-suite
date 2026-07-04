use anyhow::Result;
use app_config::{AppConfig, FeatureFlags, LlmConfig, PythonConfig, ServerConfig, StorageConfig, TtsConfig};
mod support;
use support::build_test_state;
use tempfile::tempdir;

#[tokio::test]
async fn updates_heartbeat_and_reconnect_schedule_under_rust_control() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = build_test_state(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18095,
        },
        storage: StorageConfig {
            database_path: runtime_root
                .join("memory-suite.db")
                .to_string_lossy()
                .to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: PythonConfig {
            executable: "python".into(),
            models_root: dir.path().join("python").to_string_lossy().to_string(),
        },
        features: FeatureFlags {
            enable_mock_tts: true,
        },
        tts: TtsConfig::default(),
        llm: LlmConfig::default(),
    })
    .await?;

    let heartbeat = state
        .gateway
        .heartbeat(Some("heartbeat.example".into()))
        .await?;
    assert_eq!(heartbeat.status, "connected");
    assert_eq!(
        heartbeat.current_upstream_host.as_deref(),
        Some("heartbeat.example")
    );
    assert_eq!(heartbeat.consecutive_failures, 0);
    assert!(heartbeat.last_heartbeat_at.is_some());

    let disconnect_one = state
        .gateway
        .report_disconnect("heartbeat timeout".into())
        .await?;
    assert_eq!(disconnect_one.status, "reconnecting");
    assert_eq!(disconnect_one.consecutive_failures, 1);
    assert_eq!(disconnect_one.retry_delay_ms, 1000);
    assert!(disconnect_one.next_retry_at.is_some());

    let disconnect_two = state
        .gateway
        .report_disconnect("socket closed".into())
        .await?;
    assert_eq!(disconnect_two.consecutive_failures, 2);
    assert_eq!(disconnect_two.retry_delay_ms, 2000);

    Ok(())
}

#[tokio::test]
async fn persists_native_session_lifecycle_state_inside_rust() -> Result<()> {
    let dir = tempdir()?;
    let runtime_root = dir.path().join("runtime");
    let state = build_test_state(AppConfig {
        server: ServerConfig {
            host: "127.0.0.1".into(),
            port: 18096,
        },
        storage: StorageConfig {
            database_path: runtime_root
                .join("memory-suite.db")
                .to_string_lossy()
                .to_string(),
            data_root: runtime_root.to_string_lossy().to_string(),
        },
        python: PythonConfig {
            executable: "python".into(),
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
        .session_open("sess-42".into(), "ws-primary.example".into())
        .await?;
    state
        .gateway
        .session_error("sess-42".into(), "protocol parse error".into())
        .await?;
    state
        .gateway
        .session_close("sess-42".into(), "normal closure".into())
        .await?;

    let payload = state.storage.get_danmaku_connection_state().await?;
    assert_eq!(payload.status, "disconnected");
    assert_eq!(payload.session_id.as_deref(), Some("sess-42"));
    assert_eq!(
        payload.current_upstream_host.as_deref(),
        Some("ws-primary.example")
    );
    assert_eq!(payload.last_error.as_deref(), Some("protocol parse error"));
    assert_eq!(payload.last_close_reason.as_deref(), Some("normal closure"));

    Ok(())
}
