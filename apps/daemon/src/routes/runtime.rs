use std::sync::Arc;

use api_types::{
    AudienceStateRecord, AudienceViewerRecord, ChatTimingRecord, HealthResponse,
    KnowledgeCatalogResponse, RecentChatLatencyResponse, RuntimeOverview,
};
use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
};
use serde::Deserialize;
use storage::AdapterRunRecord;

use crate::AppState;

pub(crate) async fn health(
    State(state): State<Arc<AppState>>,
) -> Result<Json<HealthResponse>, axum::http::StatusCode> {
    let db_ready = state
        .storage
        .health_check()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(HealthResponse {
        status: "ok".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        db_ready,
        runtime_mode: "rust_single_process".into(),
    }))
}

pub(crate) async fn shutdown_runtime(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    if let Err(error) = state.shutdown_runtime_services().await {
        tracing::warn!(error = %error, "failed to clean runtime services before shutdown");
    }

    state
        .shutdown_tx
        .send(true)
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({
        "ok": true,
        "message": "shutdown_requested"
    })))
}

pub(crate) async fn runtime_overview(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RuntimeOverview>, axum::http::StatusCode> {
    let db_ready = state
        .storage
        .health_check()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let counts = state
        .storage
        .runtime_counts()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(RuntimeOverview {
        db_ready,
        message_count: counts.messages.max(0) as u32,
        user_profile_count: counts.user_profiles.max(0) as u32,
        memory_entry_count: counts.memory_entries.max(0) as u32,
        config_artifact_count: counts.config_artifacts.max(0) as u32,
    }))
}

pub(crate) async fn chat_latency(
    State(state): State<Arc<AppState>>,
) -> Json<RecentChatLatencyResponse> {
    let samples = state.chat_latency_samples.read().await;
    let list: Vec<ChatTimingRecord> = samples.iter().cloned().collect();
    let count = list.len() as u64;
    let (avg_total, avg_handle, avg_finalize) = if count == 0 {
        (0, 0, 0)
    } else {
        (
            list.iter().map(|s| s.total_ms).sum::<u64>() / count,
            list.iter().map(|s| s.handle_ms).sum::<u64>() / count,
            list.iter().map(|s| s.finalize_ms).sum::<u64>() / count,
        )
    };
    Json(RecentChatLatencyResponse {
        samples: list,
        avg_total_ms: avg_total,
        avg_handle_ms: avg_handle,
        avg_finalize_ms: avg_finalize,
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct KnowledgeCatalogParams {
    query: Option<String>,
    limit: Option<u32>,
}

pub(crate) async fn knowledge_catalog(
    State(state): State<Arc<AppState>>,
    Query(params): Query<KnowledgeCatalogParams>,
) -> Result<Json<KnowledgeCatalogResponse>, axum::http::StatusCode> {
    let query = params
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let limit = params.limit.unwrap_or(24).clamp(1, 100);

    let (profiles, memory_entries, config_artifacts) = tokio::try_join!(
        state.storage.list_user_profiles(query, limit),
        state.storage.list_memory_entries(query, limit),
        state.storage.list_config_artifacts(query, limit.min(12)),
    )
    .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(KnowledgeCatalogResponse {
        query: query.map(ToOwned::to_owned),
        limit,
        profiles,
        memory_entries,
        config_artifacts,
    }))
}

pub(crate) async fn list_adapters(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<api_types::AdapterRecord>>, axum::http::StatusCode> {
    let adapters = state
        .adapters
        .list_runs()
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(
        adapters.into_iter().map(public_adapter_record).collect(),
    ))
}

pub(crate) async fn start_adapter(
    AxumPath(adapter_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<api_types::AdapterRecord>, axum::http::StatusCode> {
    let adapter = state
        .adapters
        .start_adapter(&adapter_id)
        .await
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("unsupported adapter") {
                axum::http::StatusCode::BAD_REQUEST
            } else {
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            }
        })?;
    Ok(Json(public_adapter_record(adapter)))
}

fn public_adapter_record(run: AdapterRunRecord) -> api_types::AdapterRecord {
    api_types::AdapterRecord {
        id: run.id,
        adapter_id: run.adapter_id,
        status: run.status,
        started_at: run.started_at,
        updated_at: run.updated_at,
        last_error: run.last_error,
    }
}

pub(crate) async fn list_session_messages(
    AxumPath(session_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<api_types::StoredMessage>>, axum::http::StatusCode> {
    let messages = state
        .storage
        .list_messages(&session_id)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(messages))
}

pub(crate) async fn get_audience_state(
    State(state): State<Arc<AppState>>,
) -> Json<AudienceStateRecord> {
    let audience = state.audience.read().await;
    let now = std::time::Instant::now();
    // Only count viewers active in last 5 minutes
    let active: Vec<_> = audience
        .iter()
        .filter(|(_, (_, _, last))| now.duration_since(*last).as_secs() < 300)
        .collect();

    let mut top: Vec<_> = active
        .iter()
        .map(|(uid, (count, msg, last))| AudienceViewerRecord {
            user_id: (*uid).clone(),
            message_count: *count,
            last_message: msg.chars().take(40).collect(),
            last_seen: chrono::Utc::now()
                - chrono::Duration::seconds(now.duration_since(*last).as_secs() as i64),
        })
        .collect();
    top.sort_by(|a, b| b.message_count.cmp(&a.message_count));
    top.truncate(10);

    Json(AudienceStateRecord {
        total_chatters: active.len() as u32,
        top_viewers: top,
    })
}
