use std::{
    env,
    sync::{
        Arc, RwLock as StdRwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use app_config::{LlmConfig, normalize_chat_completions_endpoint};
use api_types::{ChatRequest, MemoryEntryRecord, StoredMessage};
use serde_json::{Value, json};
use storage::{RuntimeCounts, Storage};

use crate::heuristics::{built_in_response, should_prefer_built_in_response};
use crate::persona;
use crate::prompt::build_remote_messages;
use crate::text::{limit_chars, truncate_for_log};
use crate::{
    DEFAULT_MODEL, DEFAULT_REMOTE_FALLBACK_TIMEOUT_MS, DEFAULT_REMOTE_TIMEOUT_MS, MAX_REPLY_CHARS,
};

#[derive(Debug, Clone)]
pub(crate) struct RemoteModelConfig {
    pub(crate) endpoint: String,
    pub(crate) model: String,
    pub(crate) api_key: Option<String>,
    pub(crate) temperature: f32,
    pub(crate) max_tokens: u32,
}

#[derive(Clone)]
pub(crate) struct ChatEngine {
    client: Arc<StdRwLock<reqwest::Client>>,
    remote: Arc<StdRwLock<Option<RemoteModelConfig>>>,
    fallback_timeout_ms: Arc<AtomicU64>,
}

impl ChatEngine {
    pub(crate) fn from_env() -> Self {
        let endpoint = env::var("MEMORY_SUITE_LLM_ENDPOINT")
            .ok()
            .or_else(|| {
                env::var("MEMORY_SUITE_LLM_BASE_URL")
                    .ok()
                    .map(|base| normalize_chat_completions_endpoint(&base))
            })
            .map(|endpoint| normalize_chat_completions_endpoint(&endpoint))
            .filter(|value| !value.is_empty());
        let timeout_ms = parse_u64_env("MEMORY_SUITE_LLM_TIMEOUT_MS", DEFAULT_REMOTE_TIMEOUT_MS);
        let fallback_timeout_ms = parse_u64_env(
            "MEMORY_SUITE_LLM_FALLBACK_TIMEOUT_MS",
            DEFAULT_REMOTE_FALLBACK_TIMEOUT_MS,
        );
        let client = build_http_client(timeout_ms);

        let remote = endpoint.map(|endpoint| RemoteModelConfig {
            endpoint,
            model: env::var("MEMORY_SUITE_LLM_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()),
            api_key: env::var("MEMORY_SUITE_LLM_API_KEY")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            temperature: parse_f32_env("MEMORY_SUITE_LLM_TEMPERATURE", 0.65),
            max_tokens: parse_u32_env("MEMORY_SUITE_LLM_MAX_TOKENS", 420),
        });

        Self {
            client: Arc::new(StdRwLock::new(client)),
            remote: Arc::new(StdRwLock::new(remote)),
            fallback_timeout_ms: Arc::new(AtomicU64::new(fallback_timeout_ms)),
        }
    }

    pub(crate) fn apply_llm_config(&self, llm: &LlmConfig) {
        let timeout_ms = llm.remote_timeout_ms.unwrap_or(DEFAULT_REMOTE_TIMEOUT_MS);
        let fallback_timeout_ms = llm
            .fallback_timeout_ms
            .unwrap_or(DEFAULT_REMOTE_FALLBACK_TIMEOUT_MS);
        let client = build_http_client(timeout_ms);
        let remote = llm
            .endpoint
            .clone()
            .map(|endpoint| normalize_chat_completions_endpoint(&endpoint))
            .filter(|value| !value.is_empty())
            .map(|endpoint| RemoteModelConfig {
                endpoint,
                model: llm.model.clone().unwrap_or_else(|| DEFAULT_MODEL.into()),
                api_key: llm
                    .api_key
                    .clone()
                    .filter(|value| !value.trim().is_empty()),
                temperature: llm
                    .temperature
                    .as_deref()
                    .and_then(|value| value.parse::<f32>().ok())
                    .unwrap_or(0.65),
                max_tokens: llm.max_tokens.unwrap_or(420),
            });

        if let Ok(mut guard) = self.client.write() {
            *guard = client;
        }
        if let Ok(mut guard) = self.remote.write() {
            *guard = remote;
        }
        self.fallback_timeout_ms
            .store(fallback_timeout_ms, Ordering::Relaxed);
    }

    pub(crate) async fn generate(
        &self,
        request: &ChatRequest,
        history: &[StoredMessage],
        memory_entries: &[MemoryEntryRecord],
        runtime_counts: Option<RuntimeCounts>,
        canon: &persona::PersonaCanon,
        tone_profile: &str,
        current_context: &str,
        relationship_type: Option<&str>,
        scene_hint: Option<&str>,
        storage: &Storage,
    ) -> Result<String> {
        let client = self
            .client
            .read()
            .ok()
            .map(|guard| guard.clone())
            .unwrap_or_else(reqwest::Client::new);
        let remote = self.remote.read().ok().and_then(|guard| guard.clone());
        let fallback_timeout_ms = self.fallback_timeout_ms.load(Ordering::Relaxed);
        let built_in = built_in_response(
            request,
            history,
            memory_entries,
            runtime_counts,
            scene_hint,
        );
        if should_prefer_built_in_response(request) {
            return Ok(built_in.unwrap_or_default());
        }

        if let Some(remote) = remote.as_ref() {
            match tokio::time::timeout(
                Duration::from_millis(fallback_timeout_ms),
                self.complete_remote(
                    &client,
                    remote,
                    request,
                    history,
                    memory_entries,
                    canon,
                    tone_profile,
                    current_context,
                    relationship_type,
                    scene_hint,
                ),
            )
            .await
            {
                Ok(Ok(text)) if !text.trim().is_empty() => {
                    let _ = storage.bump_fallback_stat("remote").await;
                    return Ok(limit_chars(&text, MAX_REPLY_CHARS));
                }
                Ok(Ok(_)) => {
                    tracing::warn!("remote llm returned empty text, using built-in response path");
                    let _ = storage.bump_fallback_stat("builtin_empty").await;
                }
                Ok(Err(error)) => {
                    tracing::warn!("remote llm failed, using built-in response path: {error}");
                    let _ = storage.bump_fallback_stat("builtin_error").await;
                }
                Err(_) => {
                    tracing::warn!(
                        "remote llm exceeded fallback timeout ({} ms), using built-in response path",
                        fallback_timeout_ms
                    );
                    let _ = storage.bump_fallback_stat("builtin_timeout").await;
                }
            }
        }

        if built_in.is_none() {
            let _ = storage.bump_fallback_stat("no_reply").await;
        }

        Ok(built_in.unwrap_or_default())
    }

    /// One-shot utility completion (reflection, summaries) outside the chat
    /// pipeline. Returns `None` when no remote model is configured or the
    /// call fails — callers should skip their side effect in that case.
    pub(crate) async fn complete_utility_prompt(&self, prompt: &str) -> Option<String> {
        let client = self.client.read().ok().map(|guard| guard.clone())?;
        let remote = self.remote.read().ok().and_then(|guard| guard.clone())?;
        let result = self
            .complete_utility_prompt_with_remote(&client, &remote, prompt)
            .await;

        match result {
            Ok(text) if !text.trim().is_empty() => Some(limit_chars(&text, MAX_REPLY_CHARS)),
            Ok(_) => None,
            Err(error) => {
                tracing::warn!("utility prompt completion failed: {error}");
                None
            }
        }
    }

    pub(crate) async fn test_config(&self, llm: &LlmConfig, prompt: &str) -> Result<String> {
        let endpoint = llm
            .endpoint
            .as_deref()
            .map(normalize_chat_completions_endpoint)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("llm endpoint is empty"))?;
        let timeout_ms = llm.remote_timeout_ms.unwrap_or(DEFAULT_REMOTE_TIMEOUT_MS);
        let remote = RemoteModelConfig {
            endpoint,
            model: llm.model.clone().unwrap_or_else(|| DEFAULT_MODEL.into()),
            api_key: llm
                .api_key
                .clone()
                .filter(|value| !value.trim().is_empty()),
            temperature: llm
                .temperature
                .as_deref()
                .and_then(|value| value.parse::<f32>().ok())
                .unwrap_or(0.65),
            max_tokens: llm.max_tokens.unwrap_or(80),
        };
        let client = build_http_client(timeout_ms);

        self.complete_utility_prompt_with_remote(&client, &remote, prompt)
            .await
            .map(|text| limit_chars(&text, MAX_REPLY_CHARS))
    }

    async fn complete_remote(
        &self,
        client: &reqwest::Client,
        remote: &RemoteModelConfig,
        request: &ChatRequest,
        history: &[StoredMessage],
        memory_entries: &[MemoryEntryRecord],
        canon: &persona::PersonaCanon,
        tone_profile: &str,
        current_context: &str,
        relationship_type: Option<&str>,
        scene_hint: Option<&str>,
    ) -> Result<String> {
        let payload = json!({
            "model": remote.model,
            "messages": build_remote_messages(remote, request, history, memory_entries, canon, tone_profile, current_context, relationship_type, scene_hint),
            "temperature": remote.temperature,
            "max_tokens": remote.max_tokens,
            "stream": false
        });

        let mut req = client.post(&remote.endpoint).json(&payload);
        if let Some(key) = &remote.api_key {
            req = req.bearer_auth(key);
        }
        let response = req.send().await.context("send llm request")?;
        let status = response.status();
        let raw = response.text().await.context("read llm response body")?;
        if !status.is_success() {
            return Err(anyhow!(
                "llm status {status}: {}",
                truncate_for_log(&raw, 260)
            ));
        }

        let parsed: Value = serde_json::from_str(&raw).context("parse llm response json")?;
        extract_response_text(&parsed).ok_or_else(|| anyhow!("llm response has no text content"))
    }

    async fn complete_utility_prompt_with_remote(
        &self,
        client: &reqwest::Client,
        remote: &RemoteModelConfig,
        prompt: &str,
    ) -> Result<String> {
        let payload = json!({
            "model": remote.model,
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": remote.temperature,
            "max_tokens": remote.max_tokens,
            "stream": false
        });

        let mut req = client.post(&remote.endpoint).json(&payload);
        if let Some(key) = &remote.api_key {
            req = req.bearer_auth(key);
        }

        let response = req.send().await.context("send llm request")?;
        let status = response.status();
        let raw = response.text().await.context("read llm response body")?;
        if !status.is_success() {
            return Err(anyhow!(
                "llm status {status}: {}",
                truncate_for_log(&raw, 260)
            ));
        }
        let parsed: Value = serde_json::from_str(&raw).context("parse llm response json")?;
        extract_response_text(&parsed).ok_or_else(|| anyhow!("llm response has no text content"))
    }
}

fn build_http_client(timeout_ms: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .unwrap_or_else(|error| {
            tracing::warn!("failed to build reqwest client with timeout: {error}");
            reqwest::Client::new()
        })
}

pub(crate) fn extract_response_text(payload: &Value) -> Option<String> {
    if let Some(text) = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        return Some(text.trim().to_string());
    }

    if let Some(content) = payload.pointer("/choices/0/message/content") {
        if let Some(parts) = content.as_array() {
            let text = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }

    for pointer in [
        "/choices/0/text",
        "/output_text",
        "/response",
        "/text",
        "/data/text",
    ] {
        if let Some(text) = payload.pointer(pointer).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

pub(crate) fn parse_u64_env(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(fallback)
}

pub(crate) fn parse_u32_env(name: &str, fallback: u32) -> u32 {
    env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<u32>().ok())
        .unwrap_or(fallback)
}

pub(crate) fn parse_f32_env(name: &str, fallback: f32) -> f32 {
    env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<f32>().ok())
        .unwrap_or(fallback)
}
