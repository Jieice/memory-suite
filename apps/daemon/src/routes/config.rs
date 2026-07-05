use std::{sync::Arc, time::Instant};

use api_types::{
    RuntimeConfigSnapshot, RuntimeLlmConfigRecord, RuntimeLlmConfigUpdateRequest,
    RuntimeLlmConfigTestResponse, RuntimeSttConfigRecord, RuntimeSttConfigTestResponse,
    RuntimeSttConfigUpdateRequest, RuntimeTtsConfigRecord, RuntimeTtsConfigTestResponse,
    RuntimeTtsConfigUpdateRequest,
};
use app_config::{
    AppConfig, LlmConfig, SttConfig, TtsConfig, normalize_chat_completions_endpoint,
    normalize_health_path, normalize_service_endpoint,
    normalize_stt_endpoint,
};
use axum::{Json, extract::State, http::StatusCode};

use crate::{
    AppState,
    paths::{default_config_path, writable_config_path},
};

const LLM_TEST_PROMPT: &str =
    "This is a connectivity test. Reply with one very short confirmation only.";
const TTS_TEST_TEXT: &str = "TTS 配置测试成功。";

pub(crate) async fn runtime_config(
    State(_state): State<Arc<AppState>>,
) -> Result<Json<RuntimeConfigSnapshot>, StatusCode> {
    let config = AppConfig::load_from_file(&default_config_path())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(snapshot_from_config(&config)))
}

pub(crate) async fn update_runtime_llm_config(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RuntimeLlmConfigUpdateRequest>,
) -> Result<Json<RuntimeConfigSnapshot>, StatusCode> {
    let source_path = default_config_path();
    let target_path = writable_config_path();
    let mut config =
        AppConfig::load_from_file(&source_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    config.llm = llm_config_from_request(request, config.llm.system_prompt.clone());

    config
        .save_to_file(&target_path)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    state.apply_llm_runtime_config(&config.llm);

    Ok(Json(snapshot_from_config(&config)))
}

pub(crate) async fn update_runtime_tts_config(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RuntimeTtsConfigUpdateRequest>,
) -> Result<Json<RuntimeConfigSnapshot>, StatusCode> {
    let source_path = default_config_path();
    let target_path = writable_config_path();
    let mut config =
        AppConfig::load_from_file(&source_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    config.tts = tts_config_from_request(request);

    config
        .save_to_file(&target_path)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    state.apply_tts_runtime_config(config.tts.clone());

    Ok(Json(snapshot_from_config(&config)))
}

pub(crate) async fn update_runtime_stt_config(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RuntimeSttConfigUpdateRequest>,
) -> Result<Json<RuntimeConfigSnapshot>, StatusCode> {
    let source_path = default_config_path();
    let target_path = writable_config_path();
    let mut config =
        AppConfig::load_from_file(&source_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    config.stt = stt_config_from_request(request);

    config
        .save_to_file(&target_path)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    state.apply_stt_runtime_config(config.stt.clone());

    Ok(Json(snapshot_from_config(&config)))
}

pub(crate) async fn test_runtime_llm_config(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RuntimeLlmConfigUpdateRequest>,
) -> Json<RuntimeLlmConfigTestResponse> {
    let config = llm_config_from_request(request, None);
    let endpoint = config.endpoint.clone().unwrap_or_default();
    let model = config
        .model
        .clone()
        .unwrap_or_else(|| "运行时默认模型".into());

    if endpoint.is_empty() {
        return Json(RuntimeLlmConfigTestResponse {
            ok: false,
            endpoint,
            model,
            latency_ms: None,
            reply_preview: None,
            message: "请先填写 LLM 地址。支持只填根地址，系统会自动补全到 /v1/chat/completions。"
                .into(),
        });
    }

    let started = Instant::now();
    match state.orchestrator.test_llm_config(&config, LLM_TEST_PROMPT).await {
        Ok(reply) => Json(RuntimeLlmConfigTestResponse {
            ok: true,
            endpoint,
            model,
            latency_ms: Some(elapsed_ms(started)),
            reply_preview: Some(reply.clone()),
            message: format!("LLM 连通测试通过，未写入文件。模型已返回：{reply}"),
        }),
        Err(error) => Json(RuntimeLlmConfigTestResponse {
            ok: false,
            endpoint,
            model,
            latency_ms: Some(elapsed_ms(started)),
            reply_preview: None,
            message: error.to_string(),
        }),
    }
}

pub(crate) async fn test_runtime_tts_config(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RuntimeTtsConfigUpdateRequest>,
) -> Json<RuntimeTtsConfigTestResponse> {
    let config = tts_config_from_request(request);
    let adapter_id = resolve_tts_adapter_id(&config).to_string();
    let endpoint = resolve_tts_endpoint(&config, &adapter_id);
    let health_path = resolve_tts_health_path(&config, &adapter_id);
    let voice = config
        .chat_voice
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "默认音色".into());

    let started = Instant::now();
    match state
        .tts
        .test_runtime_config(&config, TTS_TEST_TEXT, config.chat_voice.as_deref())
        .await
    {
        Ok(response) => {
            let audio_url = response
                .audio_path
                .as_ref()
                .map(|_| format!("/api/audio/{}", response.request_id));
            let message = if response.status == "mocked" {
                "TTS 测试走到了 mock 回退，未写入文件。当前没有真实音频输出。".to_string()
            } else if audio_url.is_some() {
                "TTS 连通测试通过，未写入文件。下方可直接试听。".to_string()
            } else {
                format!("TTS 连通测试通过，状态：{}。", response.status)
            };

            Json(RuntimeTtsConfigTestResponse {
                ok: true,
                endpoint,
                health_path,
                adapter_id,
                voice,
                status: response.status,
                latency_ms: Some(elapsed_ms(started)),
                audio_url,
                message,
            })
        }
        Err(error) => Json(RuntimeTtsConfigTestResponse {
            ok: false,
            endpoint,
            health_path,
            adapter_id,
            voice,
            status: "failed".into(),
            latency_ms: Some(elapsed_ms(started)),
            audio_url: None,
            message: error.to_string(),
        }),
    }
}

pub(crate) async fn test_runtime_stt_config(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RuntimeSttConfigUpdateRequest>,
) -> Json<RuntimeSttConfigTestResponse> {
    let config = stt_config_from_request(request);
    let provider = config.provider.clone().unwrap_or_else(|| "faster_whisper".into());
    let endpoint = config.endpoint.clone().unwrap_or_default();
    let model = config.model.clone().unwrap_or_else(|| default_stt_model(&config));

    match state.stt.test_runtime_config(&config).await {
        Ok(result) => Json(RuntimeSttConfigTestResponse {
            ok: result.ok,
            provider,
            endpoint,
            model,
            latency_ms: result.latency_ms,
            text_preview: (!result.text.trim().is_empty()).then_some(result.text),
            message: result.message,
        }),
        Err(error) => Json(RuntimeSttConfigTestResponse {
            ok: false,
            provider,
            endpoint,
            model,
            latency_ms: None,
            text_preview: None,
            message: error.to_string(),
        }),
    }
}

fn snapshot_from_config(config: &AppConfig) -> RuntimeConfigSnapshot {
    RuntimeConfigSnapshot {
        config_path: writable_config_path().to_string_lossy().to_string(),
        llm: RuntimeLlmConfigRecord {
            provider: config.llm.provider.clone(),
            endpoint: config
                .llm
                .endpoint
                .as_ref()
                .map(|value| normalize_chat_completions_endpoint(value)),
            model: config.llm.model.clone(),
            api_key: config.llm.api_key.clone(),
            temperature: config.llm.temperature.clone(),
            max_tokens: config.llm.max_tokens,
            remote_timeout_ms: config.llm.remote_timeout_ms,
            fallback_timeout_ms: config.llm.fallback_timeout_ms,
        },
        tts: RuntimeTtsConfigRecord {
            provider: config.tts.provider.clone(),
            endpoint: config
                .tts
                .endpoint
                .as_ref()
                .map(|value| normalize_service_endpoint(value)),
            health_path: config
                .tts
                .health_path
                .as_ref()
                .map(|value| normalize_health_path(value)),
            chat_voice: config.tts.chat_voice.clone(),
            speech_rate: config.tts.speech_rate.clone(),
        },
        stt: RuntimeSttConfigRecord {
            provider: config.stt.provider.clone(),
            endpoint: config.stt.endpoint.as_ref().map(|value| {
                normalize_stt_endpoint(value, config.stt.provider.as_deref())
            }),
            model: config.stt.model.clone(),
            api_key: config.stt.api_key.clone(),
            language: config.stt.language.clone(),
            prompt: config.stt.prompt.clone(),
        },
    }
}

fn llm_config_from_request(
    request: RuntimeLlmConfigUpdateRequest,
    system_prompt: Option<String>,
) -> LlmConfig {
    LlmConfig {
        provider: normalize_optional(request.provider),
        endpoint: normalize_optional(request.endpoint)
            .map(|value| normalize_chat_completions_endpoint(&value)),
        model: normalize_optional(request.model),
        api_key: normalize_optional(request.api_key),
        system_prompt,
        temperature: normalize_optional(request.temperature),
        max_tokens: request.max_tokens,
        remote_timeout_ms: request.remote_timeout_ms,
        fallback_timeout_ms: request.fallback_timeout_ms,
    }
}

fn tts_config_from_request(request: RuntimeTtsConfigUpdateRequest) -> TtsConfig {
    TtsConfig {
        provider: normalize_optional(request.provider),
        endpoint: normalize_optional(request.endpoint).map(|value| normalize_service_endpoint(&value)),
        health_path: normalize_optional(request.health_path).map(|value| normalize_health_path(&value)),
        chat_voice: normalize_optional(request.chat_voice),
        speech_rate: normalize_optional(request.speech_rate),
    }
}

fn stt_config_from_request(request: RuntimeSttConfigUpdateRequest) -> SttConfig {
    let provider = normalize_optional(request.provider);
    SttConfig {
        endpoint: normalize_optional(request.endpoint)
            .map(|value| normalize_stt_endpoint(&value, provider.as_deref())),
        provider,
        model: normalize_optional(request.model),
        api_key: normalize_optional(request.api_key),
        language: normalize_optional(request.language),
        prompt: normalize_optional(request.prompt),
    }
}

fn resolve_tts_adapter_id(config: &TtsConfig) -> &'static str {
    match config
        .provider
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .as_deref()
    {
        Some("sovits") => "sovits",
        _ => "edge_tts",
    }
}

fn resolve_tts_endpoint(config: &TtsConfig, adapter_id: &str) -> String {
    if let Some(endpoint) = config
        .endpoint
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return normalize_service_endpoint(endpoint);
    }

    match adapter_id {
        "sovits" => "http://127.0.0.1:9880".into(),
        _ => "http://127.0.0.1:9881".into(),
    }
}

fn resolve_tts_health_path(config: &TtsConfig, adapter_id: &str) -> String {
    if let Some(path) = config
        .health_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return normalize_health_path(path);
    }

    match adapter_id {
        "sovits" => "/docs".into(),
        _ => "/voices".into(),
    }
}

fn default_stt_model(config: &SttConfig) -> String {
    match config
        .provider
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .as_deref()
    {
        Some("openai_compatible") => "whisper-1".into(),
        _ => "small".into(),
    }
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::{resolve_tts_health_path, stt_config_from_request, tts_config_from_request};
    use api_types::{RuntimeSttConfigUpdateRequest, RuntimeTtsConfigUpdateRequest};
    use app_config::{
        normalize_chat_completions_endpoint, normalize_health_path, normalize_stt_endpoint,
    };

    #[test]
    fn llm_endpoint_normalizer_handles_plain_base_and_v1_suffix() {
        assert_eq!(
            normalize_chat_completions_endpoint("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            normalize_chat_completions_endpoint("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn tts_request_normalizer_trims_endpoint_and_prefixes_health_path() {
        let config = tts_config_from_request(RuntimeTtsConfigUpdateRequest {
            provider: Some("edge_tts".into()),
            endpoint: Some("http://127.0.0.1:9881/".into()),
            health_path: Some("voices".into()),
            chat_voice: None,
            speech_rate: None,
        });

        assert_eq!(config.endpoint.as_deref(), Some("http://127.0.0.1:9881"));
        assert_eq!(config.health_path.as_deref(), Some("/voices"));
        assert_eq!(normalize_health_path("docs"), "/docs");
        assert_eq!(resolve_tts_health_path(&config, "edge_tts"), "/voices");
    }

    #[test]
    fn stt_request_normalizer_handles_local_and_openai_style_endpoints() {
        let local = stt_config_from_request(RuntimeSttConfigUpdateRequest {
            provider: Some("faster-whisper".into()),
            endpoint: Some("http://127.0.0.1:9882/".into()),
            model: None,
            api_key: None,
            language: None,
            prompt: None,
        });
        assert_eq!(local.endpoint.as_deref(), Some("http://127.0.0.1:9882/transcribe"));

        let remote = stt_config_from_request(RuntimeSttConfigUpdateRequest {
            provider: Some("openai-compatible".into()),
            endpoint: Some("https://api.openai.com".into()),
            model: None,
            api_key: None,
            language: None,
            prompt: None,
        });
        assert_eq!(
            remote.endpoint.as_deref(),
            Some("https://api.openai.com/v1/audio/transcriptions")
        );
        assert_eq!(
            normalize_stt_endpoint("https://api.openai.com/v1/", Some("openai-compatible")),
            "https://api.openai.com/v1/audio/transcriptions"
        );
    }
}
