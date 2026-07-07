use std::{
    env,
    sync::{
        Arc, RwLock as StdRwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use api_types::{ChatRequest, MemoryEntryRecord, StoredMessage};
use app_config::{LlmConfig, normalize_chat_completions_endpoint};
use futures_util::StreamExt;
use serde_json::{Value, json};
use storage::{RuntimeCounts, Storage};
use tokio::sync::mpsc;

use crate::heuristics::{built_in_response, route_to_cloud, should_prefer_built_in_response};
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
    /// Optional higher-quality cloud tier for the hybrid router. `None` = pure
    /// local. When set, "deep" turns route here while ordinary chat stays local.
    cloud: Arc<StdRwLock<Option<RemoteModelConfig>>>,
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

        // Optional cloud tier for the hybrid router: only enabled when a cloud
        // endpoint is configured. Absent → pure local, no behavior change.
        let cloud = env::var("MEMORY_SUITE_LLM_CLOUD_ENDPOINT")
            .ok()
            .map(|endpoint| normalize_chat_completions_endpoint(&endpoint))
            .filter(|value| !value.is_empty())
            .map(|endpoint| RemoteModelConfig {
                endpoint,
                model: env::var("MEMORY_SUITE_LLM_CLOUD_MODEL")
                    .unwrap_or_else(|_| DEFAULT_MODEL.into()),
                api_key: env::var("MEMORY_SUITE_LLM_CLOUD_API_KEY")
                    .ok()
                    .filter(|value| !value.trim().is_empty()),
                temperature: parse_f32_env("MEMORY_SUITE_LLM_TEMPERATURE", 0.65),
                max_tokens: parse_u32_env("MEMORY_SUITE_LLM_CLOUD_MAX_TOKENS", 420),
            });

        Self {
            client: Arc::new(StdRwLock::new(client)),
            remote: Arc::new(StdRwLock::new(remote)),
            cloud: Arc::new(StdRwLock::new(cloud)),
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
                api_key: llm.api_key.clone().filter(|value| !value.trim().is_empty()),
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
        let cloud = llm
            .cloud_endpoint
            .clone()
            .map(|endpoint| normalize_chat_completions_endpoint(&endpoint))
            .filter(|value| !value.is_empty())
            .map(|endpoint| RemoteModelConfig {
                endpoint,
                model: llm
                    .cloud_model
                    .clone()
                    .unwrap_or_else(|| DEFAULT_MODEL.into()),
                api_key: llm
                    .cloud_api_key
                    .clone()
                    .filter(|value| !value.trim().is_empty()),
                temperature: llm
                    .temperature
                    .as_deref()
                    .and_then(|value| value.parse::<f32>().ok())
                    .unwrap_or(0.65),
                max_tokens: llm.cloud_max_tokens.or(llm.max_tokens).unwrap_or(420),
            });

        if let Ok(mut guard) = self.remote.write() {
            *guard = remote;
        }
        if let Ok(mut guard) = self.cloud.write() {
            *guard = cloud;
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
        let built_in =
            built_in_response(request, history, memory_entries, runtime_counts, scene_hint);
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
            api_key: llm.api_key.clone().filter(|value| !value.trim().is_empty()),
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

    /// Streaming counterpart to [`generate`]. Streams tokens from the remote
    /// model over SSE and emits complete sentences to `sentence_tx` as soon as
    /// each sentence boundary is crossed, so downstream TTS can start on
    /// sentence 1 while the model is still generating sentence 2+. Returns the
    /// full accumulated reply for persistence. Falls back to the built-in
    /// response (also sent to `sentence_tx`) only when the remote call fails
    /// before emitting anything, to avoid double-speaking a partial reply.
    pub(crate) async fn generate_streaming(
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
        sentence_tx: &mpsc::UnboundedSender<String>,
    ) -> Result<String> {
        let client = self
            .client
            .read()
            .ok()
            .map(|guard| guard.clone())
            .unwrap_or_else(reqwest::Client::new);
        // Hybrid routing: when a cloud tier is configured AND this turn looks
        // like a "deep" question, try the higher-quality cloud model first and
        // fall back to the fast local model if cloud fails; otherwise stay local.
        // Pure-local deployments (no cloud tier) are unaffected.
        let local = self.remote.read().ok().and_then(|guard| guard.clone());
        let cloud = self.cloud.read().ok().and_then(|guard| guard.clone());
        let routed_cloud = cloud.is_some() && route_to_cloud(request);

        // Ordered endpoints to attempt. When routed to cloud, local is kept as a
        // resilience fallback so a dead/unauthorized cloud channel never strands
        // the turn on the empty voice fallback — it degrades to local instead.
        let mut candidates: Vec<(RemoteModelConfig, &'static str)> = Vec::new();
        if routed_cloud {
            tracing::info!("hybrid router: routing turn to cloud tier for quality");
            if let Some(cloud_cfg) = cloud {
                candidates.push((cloud_cfg, "cloud"));
            }
            if let Some(local_cfg) = local {
                candidates.push((local_cfg, "local_fallback"));
            }
        } else if let Some(local_cfg) = local {
            candidates.push((local_cfg, "local"));
        }

        let fallback_timeout_ms = self.fallback_timeout_ms.load(Ordering::Relaxed);
        let built_in =
            built_in_response(request, history, memory_entries, runtime_counts, scene_hint);
        if should_prefer_built_in_response(request) {
            let text = built_in.unwrap_or_default();
            if !text.trim().is_empty() {
                let _ = sentence_tx.send(text.clone());
            }
            return Ok(text);
        }

        // Try each endpoint in order. A `None` result guarantees no sentences
        // were emitted (both stream_remote's empty/error paths and the
        // non-streaming retry emit nothing when they yield None), so advancing to
        // the next endpoint cannot double-speak.
        for (remote, label) in &candidates {
            if let Some(text) = self
                .try_remote_endpoint(
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
                    fallback_timeout_ms,
                    sentence_tx,
                    storage,
                )
                .await
            {
                return Ok(limit_chars(&text, MAX_REPLY_CHARS));
            }
            tracing::warn!(endpoint = label, "remote endpoint yielded no reply");
        }

        if built_in.is_none() {
            let _ = storage.bump_fallback_stat("no_reply").await;
        }
        let text = built_in.unwrap_or_default();
        if !text.trim().is_empty() {
            let _ = sentence_tx.send(text.clone());
        }
        Ok(text)
    }

    /// Attempts a single remote endpoint end to end: stream first, then a
    /// non-streaming retry if the stream yields nothing usable. Returns
    /// `Some(text)` on a real reply, `None` when this endpoint produced no
    /// spoken sentences (so the caller may safely try the next endpoint or fall
    /// through to the built-in response without double-speaking).
    #[allow(clippy::too_many_arguments)]
    async fn try_remote_endpoint(
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
        fallback_timeout_ms: u64,
        sentence_tx: &mpsc::UnboundedSender<String>,
        storage: &Storage,
    ) -> Option<String> {
        match self
            .stream_remote(
                client,
                remote,
                request,
                history,
                memory_entries,
                canon,
                tone_profile,
                current_context,
                relationship_type,
                scene_hint,
                fallback_timeout_ms,
                sentence_tx,
            )
            .await
        {
            Ok(text) if !text.trim().is_empty() => {
                let _ = storage.bump_fallback_stat("remote").await;
                Some(text)
            }
            // The stream produced nothing usable. Retry once non-streaming: some
            // endpoints reject `stream:true`, emit a delta shape we don't parse
            // (e.g. reasoning-model `reasoning_content`), or return an SSE body we
            // can't decode. `complete_remote` is the proven path. Only reached
            // when streaming emitted zero sentences, so there is no double-speak.
            Ok(_) => {
                tracing::warn!("remote llm stream returned empty text, retrying non-streaming");
                self.complete_remote_after_stream_miss(
                    client,
                    remote,
                    request,
                    history,
                    memory_entries,
                    canon,
                    tone_profile,
                    current_context,
                    relationship_type,
                    scene_hint,
                    sentence_tx,
                    storage,
                )
                .await
            }
            Err(error) => {
                tracing::warn!("remote llm stream failed ({error}), retrying non-streaming");
                self.complete_remote_after_stream_miss(
                    client,
                    remote,
                    request,
                    history,
                    memory_entries,
                    canon,
                    tone_profile,
                    current_context,
                    relationship_type,
                    scene_hint,
                    sentence_tx,
                    storage,
                )
                .await
            }
        }
    }

    /// Non-streaming recovery when `stream_remote` yields nothing usable.
    /// Runs the proven `complete_remote`, then splits the full reply into
    /// sentences and feeds them to `sentence_tx` so the downstream per-sentence
    /// TTS pipeline still works (just without token-level streaming for this
    /// turn). Returns `Some(text)` on a real reply, `None` when this path also
    /// comes up empty so the caller can fall through to the built-in response.
    #[allow(clippy::too_many_arguments)]
    async fn complete_remote_after_stream_miss(
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
        sentence_tx: &mpsc::UnboundedSender<String>,
        storage: &Storage,
    ) -> Option<String> {
        let text = match self
            .complete_remote(
                client,
                remote,
                request,
                history,
                memory_entries,
                canon,
                tone_profile,
                current_context,
                relationship_type,
                scene_hint,
            )
            .await
        {
            Ok(text) if !text.trim().is_empty() => text,
            Ok(_) => return None,
            Err(error) => {
                tracing::warn!("non-streaming retry after stream miss also failed: {error}");
                return None;
            }
        };

        // Split into the same sentence units the streaming path would emit, so
        // TTS is still dispatched per sentence. Feed the whole reply through the
        // splitter, then flush any trailing partial as a final sentence.
        let mut buf = text.clone();
        for sentence in drain_sentences(&mut buf) {
            if sentence_tx.send(sentence).is_err() {
                break;
            }
        }
        let tail = buf.trim();
        if !tail.is_empty() {
            let _ = sentence_tx.send(tail.to_string());
        }

        let _ = storage.bump_fallback_stat("remote").await;
        Some(limit_chars(&text, MAX_REPLY_CHARS))
    }

    /// Sends a `stream: true` chat completion and forwards each completed
    /// sentence to `sentence_tx`. The `fallback_timeout_ms` budget applies only
    /// to establishing the response (connect + headers) — once tokens flow we
    /// let generation run to completion so partial replies are never discarded.
    /// Returns `Err` only when the call fails before any sentence is emitted;
    /// a mid-stream error after ≥1 sentence returns the accumulated text so the
    /// caller does not double-speak a built-in fallback.
    #[allow(clippy::too_many_arguments)]
    async fn stream_remote(
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
        fallback_timeout_ms: u64,
        sentence_tx: &mpsc::UnboundedSender<String>,
    ) -> Result<String> {
        let payload = json!({
            "model": remote.model,
            "messages": build_remote_messages(remote, request, history, memory_entries, canon, tone_profile, current_context, relationship_type, scene_hint),
            "temperature": remote.temperature,
            "max_tokens": remote.max_tokens,
            "stream": true
        });

        let mut req = client.post(&remote.endpoint).json(&payload);
        if let Some(key) = &remote.api_key {
            req = req.bearer_auth(key);
        }
        let response =
            tokio::time::timeout(Duration::from_millis(fallback_timeout_ms), req.send())
                .await
                .context("llm stream connect exceeded fallback timeout")?
                .context("send llm stream request")?;
        let status = response.status();
        if !status.is_success() {
            let raw = response.text().await.unwrap_or_default();
            return Err(anyhow!("llm status {status}: {}", truncate_for_log(&raw, 260)));
        }

        let mut stream = response.bytes_stream();
        let mut sse_buf = String::new();
        let mut sentence_buf = String::new();
        let mut full = String::new();
        let mut sent_any = false;
        // Log the first delta we can't extract text from, once per turn, so an
        // unfamiliar SSE shape is diagnosable without spamming the log.
        let mut logged_unparsed_delta = false;

        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    if sent_any {
                        break;
                    }
                    return Err(error).context("read llm stream chunk");
                }
            };
            sse_buf.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(newline) = sse_buf.find('\n') {
                let line: String = sse_buf.drain(..=newline).collect();
                let line = line.trim();
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                match extract_stream_delta(&value) {
                    Some(delta) if !delta.is_empty() => {
                        full.push_str(&delta);
                        sentence_buf.push_str(&delta);
                        for sentence in drain_sentences(&mut sentence_buf) {
                            if sentence_tx.send(sentence).is_err() {
                                // Consumer dropped (e.g. turn interrupted); stop early.
                                return Ok(full.trim().to_string());
                            }
                            sent_any = true;
                        }
                    }
                    _ => {
                        // Log the first chunk we couldn't pull text from, so an
                        // unfamiliar delta shape (reasoning models, non-OpenAI
                        // frameworks) is diagnosable instead of silently empty.
                        // The non-streaming retry in `generate_streaming` still
                        // recovers a real reply for this turn.
                        if !logged_unparsed_delta && full.is_empty() {
                            tracing::warn!(
                                "llm stream delta had no recognizable text content; \
                                 sample chunk: {}",
                                truncate_for_log(data, 300)
                            );
                            logged_unparsed_delta = true;
                        }
                    }
                }
            }
        }

        let tail = sentence_buf.trim();
        if !tail.is_empty() {
            let _ = sentence_tx.send(tail.to_string());
        }

        Ok(full.trim().to_string())
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

/// Extracts the incremental text from one streamed SSE chunk. Handles the
/// common OpenAI-compatible shapes:
/// - `choices[0].delta.content` as a plain string (OpenAI, vLLM, most gateways)
/// - `choices[0].delta.content` as an array of `{type,text}` parts (some
///   Anthropic-compatible bridges)
/// - `choices[0].text` (legacy completion-style streaming)
///
/// Returns `None` for role-only / tool-call / usage deltas that carry no text,
/// and for shapes we don't recognize (the caller logs a sample of the latter).
fn extract_stream_delta(value: &Value) -> Option<String> {
    if let Some(text) = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        return Some(text.to_string());
    }

    if let Some(parts) = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_array)
    {
        let text: String = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect();
        if !text.is_empty() {
            return Some(text);
        }
    }

    if let Some(text) = value.pointer("/choices/0/text").and_then(Value::as_str) {
        return Some(text.to_string());
    }

    None
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

/// CJK full-width terminators always end a sentence. ASCII `.!?` only end a
/// sentence when followed by whitespace or end-of-buffer, so decimals ("3.14")
/// and abbreviations don't split mid-token. `\n` (hard break) always ends.
const CJK_TERMINATORS: [char; 4] = ['。', '！', '？', '…'];
const ASCII_TERMINATORS: [char; 3] = ['.', '!', '?'];

/// Minimum sentence length (in chars) before a boundary flush. Prevents a lone
/// terminator (e.g. "?" or a numbered list "1.") from being spoken on its own.
const MIN_SENTENCE_CHARS: usize = 4;

/// Drains all complete sentences from `buf`, leaving any trailing partial
/// sentence in place. Each returned sentence includes its terminating
/// punctuation. Runs of consecutive terminators (e.g. "?!" or ".\n") are kept
/// with the sentence rather than emitted as empty fragments.
fn drain_sentences(buf: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        // Find the first terminator that leaves a long-enough head.
        let boundary = buf.char_indices().find_map(|(idx, ch)| {
            let after = &buf[idx + ch.len_utf8()..];
            let is_terminator = if CJK_TERMINATORS.contains(&ch) || ch == '\n' {
                true
            } else if ASCII_TERMINATORS.contains(&ch) {
                // Only a real boundary when nothing follows or the next char is
                // whitespace — keeps "3.14" and "e.g." from splitting.
                after
                    .chars()
                    .next()
                    .map(|next| next.is_whitespace())
                    .unwrap_or(true)
            } else {
                false
            };
            if !is_terminator {
                return None;
            }
            let head_chars = buf[..idx].chars().count();
            if head_chars + 1 < MIN_SENTENCE_CHARS {
                return None;
            }
            // Extend past any trailing terminators/whitespace so "?!" and ". "
            // ride along with the sentence instead of starting a new fragment.
            let mut end = idx + ch.len_utf8();
            while let Some(next) = buf[end..].chars().next() {
                if CJK_TERMINATORS.contains(&next)
                    || ASCII_TERMINATORS.contains(&next)
                    || next == ' '
                    || next == '\t'
                    || next == '\n'
                {
                    end += next.len_utf8();
                } else {
                    break;
                }
            }
            Some(end)
        });

        let Some(end) = boundary else {
            break;
        };
        let sentence: String = buf.drain(..end).collect();
        let trimmed = sentence.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
    }
    out
}

#[cfg(test)]
mod sentence_tests {
    use super::drain_sentences;

    #[test]
    fn drains_complete_cjk_sentence_and_keeps_partial_tail() {
        let mut buf = String::from("你好呀，今天不错。还有别的");
        let out = drain_sentences(&mut buf);
        assert_eq!(out, vec!["你好呀，今天不错。".to_string()]);
        assert_eq!(buf, "还有别的");
    }

    #[test]
    fn keeps_decimals_and_abbreviations_intact() {
        let mut buf = String::from("圆周率约为3.14而已");
        let out = drain_sentences(&mut buf);
        assert!(out.is_empty(), "3.14 must not split: {out:?}");
        assert_eq!(buf, "圆周率约为3.14而已");
    }

    #[test]
    fn splits_ascii_sentence_when_followed_by_space() {
        let mut buf = String::from("Hello there. And more text");
        let out = drain_sentences(&mut buf);
        assert_eq!(out, vec!["Hello there.".to_string()]);
        assert_eq!(buf, "And more text");
    }

    #[test]
    fn merges_runs_of_terminators() {
        let mut buf = String::from("真的吗？！太好了");
        let out = drain_sentences(&mut buf);
        assert_eq!(out, vec!["真的吗？！".to_string()]);
        assert_eq!(buf, "太好了");
    }

    #[test]
    fn short_leading_fragment_rides_into_next_clause() {
        let mut buf = String::from("好。这次真的说完整了。");
        let out = drain_sentences(&mut buf);
        // "好。" is under the min length, so it merges with the following clause.
        assert_eq!(out, vec!["好。这次真的说完整了。".to_string()]);
        assert!(buf.is_empty());
    }
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
