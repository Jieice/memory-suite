use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use api_types::{
    ToolExecutionRequest, ToolExecutionResponse, ToolManifestRecord, ToolSchemaRecord,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::{
    process::Command,
    time::{Duration, Instant, timeout},
};

use crate::paths::tools_root;

#[derive(Debug, Clone, Copy)]
pub(crate) enum ToolExecutionError {
    NotFound,
    UnsupportedRuntime,
    Internal,
}

pub(crate) async fn run_tool_execution(
    request: ToolExecutionRequest,
) -> std::result::Result<ToolExecutionResponse, ToolExecutionError> {
    let loaded = load_tool_manifest_by_id(&request.tool_id)
        .map_err(|_| ToolExecutionError::Internal)?
        .ok_or(ToolExecutionError::NotFound)?;

    if loaded.manifest.runtime != "node" {
        return Err(ToolExecutionError::UnsupportedRuntime);
    }

    let entry_path = resolve_tool_entry_path(&loaded.tool_dir, &loaded.manifest.entry)
        .map_err(|_| ToolExecutionError::Internal)?;

    let execution_id = uuid::Uuid::new_v4().to_string();
    let args = request.args;
    let args_json = serde_json::to_string(&args).map_err(|_| ToolExecutionError::Internal)?;

    let timeout_ms = request
        .timeout_ms
        .or(loaded.manifest.timeout)
        .unwrap_or(30_000)
        .clamp(1, 120_000);

    let mut command = Command::new("node");
    command
        .arg(&entry_path)
        .arg(&args_json)
        .current_dir(&loaded.tool_dir)
        .env("TOOL_CALL_ID", &execution_id)
        .env("TOOL_ARGS_JSON", &args_json)
        .kill_on_drop(true);

    let started = Instant::now();
    let outcome = timeout(Duration::from_millis(timeout_ms), command.output()).await;
    let duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let executed_at = chrono::Utc::now();

    match outcome {
        Err(_) => Ok(ToolExecutionResponse {
            execution_id,
            tool_id: loaded.manifest.id,
            args,
            ok: false,
            status: "timeout".into(),
            exit_code: None,
            timed_out: true,
            duration_ms,
            output: None,
            stdout: None,
            stderr: None,
            error: Some(format!(
                "tool execution exceeded timeout budget ({timeout_ms}ms)"
            )),
            executed_at,
        }),
        Ok(Err(error)) => Ok(ToolExecutionResponse {
            execution_id,
            tool_id: loaded.manifest.id,
            args,
            ok: false,
            status: "failed".into(),
            exit_code: None,
            timed_out: false,
            duration_ms,
            output: None,
            stdout: None,
            stderr: None,
            error: Some(format!("failed to start tool process: {error}")),
            executed_at,
        }),
        Ok(Ok(output)) => {
            let stdout = normalize_stdio(&String::from_utf8_lossy(&output.stdout));
            let stderr = normalize_stdio(&String::from_utf8_lossy(&output.stderr));
            let parsed_output = parse_tool_output(stdout.as_deref());
            let exit_code = output.status.code();
            let ok = output.status.success();
            let status = if ok { "succeeded" } else { "failed" }.to_string();
            let error = if ok {
                None
            } else {
                parsed_output
                    .as_ref()
                    .and_then(|value| value.get("error"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| stderr.clone())
                    .or_else(|| {
                        Some(match exit_code {
                            Some(code) => format!("tool exited with non-zero status code {code}"),
                            None => "tool process terminated by signal".into(),
                        })
                    })
            };

            Ok(ToolExecutionResponse {
                execution_id,
                tool_id: loaded.manifest.id,
                args,
                ok,
                status,
                exit_code,
                timed_out: false,
                duration_ms,
                output: parsed_output,
                stdout,
                stderr,
                error,
                executed_at,
            })
        }
    }
}

fn resolve_tool_entry_path(tool_dir: &Path, entry: &str) -> Result<PathBuf> {
    let tool_dir_canonical = fs::canonicalize(tool_dir)
        .with_context(|| format!("invalid tool dir {}", tool_dir.display()))?;
    let entry_candidate = tool_dir.join(entry);
    let entry_canonical = fs::canonicalize(&entry_candidate)
        .with_context(|| format!("missing tool entry {}", entry_candidate.display()))?;

    if !entry_canonical.starts_with(&tool_dir_canonical) {
        anyhow::bail!(
            "tool entry escapes manifest directory: {}",
            entry_canonical.display()
        );
    }

    Ok(entry_candidate)
}

fn parse_tool_output(stdout: Option<&str>) -> Option<Value> {
    let stdout = stdout?.trim();
    if stdout.is_empty() {
        return None;
    }

    if let Ok(value) = serde_json::from_str::<Value>(stdout) {
        return Some(value);
    }

    stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
}

fn normalize_stdio(raw: &str) -> Option<String> {
    const MAX_STDIO_BYTES: usize = 16_384;

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.len() <= MAX_STDIO_BYTES {
        return Some(trimmed.to_string());
    }

    let mut split_index = 0;
    for (index, _) in trimmed.char_indices() {
        if index > MAX_STDIO_BYTES {
            break;
        }
        split_index = index;
    }

    Some(format!("{}...[truncated]", &trimmed[..split_index]))
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ToolManifestFile {
    id: String,
    name: String,
    version: String,
    runtime: String,
    entry: String,
    enabled_by_default: Option<bool>,
    confirmation_level: Option<String>,
    access_level: Option<String>,
    schemas: Option<Vec<ToolSchemaFile>>,
    timeout: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
struct ToolSchemaFile {
    name: String,
    description: Option<String>,
    input: Option<Value>,
}

#[derive(Debug)]
struct LoadedToolManifest {
    tool_dir: PathBuf,
    manifest: ToolManifestFile,
}

pub(crate) fn load_tool_manifests() -> Result<Vec<ToolManifestRecord>> {
    let mut manifests = load_tool_manifest_files()?
        .into_iter()
        .map(|loaded| tool_manifest_record_from_file(&loaded.manifest))
        .collect::<Vec<_>>();
    manifests.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Ok(manifests)
}

fn load_tool_manifest_by_id(tool_id: &str) -> Result<Option<LoadedToolManifest>> {
    Ok(load_tool_manifest_files()?
        .into_iter()
        .find(|loaded| loaded.manifest.id == tool_id))
}

fn load_tool_manifest_files() -> Result<Vec<LoadedToolManifest>> {
    let mut manifests = Vec::new();
    let root = tools_root();
    if !root.exists() {
        return Ok(manifests);
    }

    for entry in
        fs::read_dir(&root).with_context(|| format!("failed to read {}", root.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }

        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }

        let raw = fs::read_to_string(&manifest_path)
            .with_context(|| format!("failed to read {}", manifest_path.display()))?;
        let manifest: ToolManifestFile = serde_json::from_str(&raw)
            .with_context(|| format!("invalid tool manifest {}", manifest_path.display()))?;
        manifests.push(LoadedToolManifest {
            tool_dir: entry.path(),
            manifest,
        });
    }

    Ok(manifests)
}

fn tool_manifest_record_from_file(manifest: &ToolManifestFile) -> ToolManifestRecord {
    let schemas = manifest
        .schemas
        .as_ref()
        .map(|schemas| {
            schemas
                .iter()
                .map(|schema| ToolSchemaRecord {
                    name: schema.name.clone(),
                    description: schema.description.clone(),
                    action_count: extract_schema_action_count(schema.input.as_ref()),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let description = schemas.iter().find_map(|schema| schema.description.clone());

    ToolManifestRecord {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        runtime: manifest.runtime.clone(),
        entry: manifest.entry.clone(),
        enabled_by_default: manifest.enabled_by_default.unwrap_or(false),
        access_level: manifest
            .access_level
            .clone()
            .unwrap_or_else(|| "operator".into()),
        confirmation_level: manifest.confirmation_level.clone(),
        description,
        schema_count: schemas.len() as u32,
        schemas,
    }
}

fn extract_schema_action_count(input: Option<&Value>) -> u32 {
    input
        .and_then(|value| value.get("properties"))
        .and_then(|value| value.get("action"))
        .and_then(|value| value.get("enum"))
        .and_then(Value::as_array)
        .map(|values| values.len() as u32)
        .unwrap_or(0)
}
