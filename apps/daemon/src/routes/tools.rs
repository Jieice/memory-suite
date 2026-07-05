use std::sync::Arc;

use api_types::{ToolExecutionRequest, ToolExecutionResponse, ToolManifestRecord};
use axum::{
    Json,
    extract::{Query, State},
};
use serde::Deserialize;

use crate::AppState;
use crate::tools::{ToolExecutionError, load_tool_manifests, run_tool_execution};

pub(crate) async fn list_tool_manifests()
-> Result<Json<Vec<ToolManifestRecord>>, axum::http::StatusCode> {
    let manifests =
        load_tool_manifests().map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(manifests))
}

#[derive(Debug, Deserialize)]
pub(crate) struct ToolExecutionHistoryParams {
    limit: Option<u32>,
}

pub(crate) async fn list_tool_executions(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ToolExecutionHistoryParams>,
) -> Result<Json<Vec<ToolExecutionResponse>>, axum::http::StatusCode> {
    let limit = params.limit.unwrap_or(20).clamp(1, 200) as usize;
    let history = state.tool_executions.read().await;
    let payload = history
        .iter()
        .rev()
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    Ok(Json(payload))
}

pub(crate) async fn execute_tool(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ToolExecutionRequest>,
) -> Result<Json<ToolExecutionResponse>, axum::http::StatusCode> {
    let response = run_tool_execution(request)
        .await
        .map_err(|error| match error {
            ToolExecutionError::NotFound => axum::http::StatusCode::NOT_FOUND,
            ToolExecutionError::UnsupportedRuntime => axum::http::StatusCode::BAD_REQUEST,
            ToolExecutionError::Internal => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        })?;
    push_tool_execution_history(&state, response.clone()).await;
    Ok(Json(response))
}

pub(crate) async fn push_tool_execution_history(
    state: &Arc<AppState>,
    response: ToolExecutionResponse,
) {
    const TOOL_EXECUTION_HISTORY_LIMIT: usize = 100;

    let mut history = state.tool_executions.write().await;
    if history.len() >= TOOL_EXECUTION_HISTORY_LIMIT {
        history.pop_front();
    }
    history.push_back(response);
}
