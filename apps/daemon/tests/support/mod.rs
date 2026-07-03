#![allow(dead_code)]

use std::sync::{Mutex, MutexGuard};

use anyhow::Result;
use app_config::AppConfig;
use daemon::{AppState, AppStateOptions};

pub static NATIVE_ENV_LOCK: Mutex<()> = Mutex::new(());

pub fn native_env_lock() -> MutexGuard<'static, ()> {
    NATIVE_ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct EnvVarGuard {
    key: &'static str,
    original: Option<String>,
}

impl EnvVarGuard {
    pub fn set(key: &'static str, value: String) -> Self {
        let original = std::env::var(key).ok();
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, original }
    }

    pub fn remove(key: &'static str) -> Self {
        let original = std::env::var(key).ok();
        unsafe {
            std::env::remove_var(key);
        }
        Self { key, original }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        unsafe {
            if let Some(value) = &self.original {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }
}

pub async fn build_test_state(config: AppConfig) -> Result<AppState> {
    build_test_state_with_options(config, AppStateOptions::isolated()).await
}

pub async fn build_test_state_with_options(
    config: AppConfig,
    options: AppStateOptions,
) -> Result<AppState> {
    AppState::from_config_with_options(config, options).await
}
