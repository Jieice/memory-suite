import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import type { ImportSummary, ToolExecutionResponse, ToolManifestRecord } from '../generated/api';
import { executeTool, importLegacy, listToolExecutions, listToolManifests } from '../lib';

function suggestArgs(toolId: string): string {
  switch (toolId) {
    case 'echo':
      return '{\n  "message": "hello tool execution"\n}';
    case 'calculator':
      return '{\n  "expression": "2+3*4"\n}';
    case 'datetime':
      return '{\n  "format": "full"\n}';
    case 'random':
      return '{\n  "min": 1,\n  "max": 100,\n  "count": 1\n}';
    case 'manager_control':
      return '{\n  "action": "mu_live_status"\n}';
    default:
      return '{}';
  }
}

export function ToolsPage() {
  const [root, setRoot] = useState('.');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [manifests, setManifests] = useState<ToolManifestRecord[]>([]);
  const [history, setHistory] = useState<ToolExecutionResponse[]>([]);
  const [selectedToolId, setSelectedToolId] = useState('');
  const [argsJson, setArgsJson] = useState('{}');
  const [timeoutMs, setTimeoutMs] = useState('');
  const [latestExecution, setLatestExecution] = useState<ToolExecutionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executeError, setExecuteError] = useState<string | null>(null);

  const refreshTools = useEffectEvent(async () => {
    try {
      const next = await listToolManifests();
      setManifests(next);
      if (!next.length) {
        setSelectedToolId('');
        return;
      }
      if (!selectedToolId || !next.some((manifest) => manifest.id === selectedToolId)) {
        const firstId = next[0].id;
        setSelectedToolId(firstId);
        setArgsJson(suggestArgs(firstId));
      }
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to load tool manifests.');
    }
  });

  const refreshHistory = useEffectEvent(async () => {
    try {
      setHistory(await listToolExecutions(20));
      setExecuteError(null);
    } catch (nextError) {
      setExecuteError(
        nextError instanceof Error ? nextError.message : 'Failed to load tool execution history.',
      );
    }
  });

  const selectedManifest = useMemo(
    () => manifests.find((manifest) => manifest.id === selectedToolId) ?? null,
    [manifests, selectedToolId],
  );

  useEffect(() => {
    refreshTools();
    refreshHistory();
  }, [refreshHistory, refreshTools]);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">Tooling</p>
        <h2>Migration, generated types, and operator utilities</h2>
        <p className="page-copy">
          The old system is now only a migration source. Use this surface to import legacy data and
          keep the shared Rust-to-TypeScript contracts in sync.
        </p>
      </header>

      <div className="card-grid">
        <article className="card emphasis">
          <p className="eyebrow">Legacy Import</p>
          <h3>Ingest old memory and config artifacts</h3>
          <label className="field">
            <span>Source root</span>
            <input value={root} onChange={(event) => setRoot(event.target.value)} />
          </label>
          <div className="actions">
            <button
              onClick={async () => {
                try {
                  const response = await importLegacy({ root });
                  setSummary(response);
                  setError(null);
                  await refreshTools();
                } catch (nextError) {
                  setError(nextError instanceof Error ? nextError.message : 'Legacy import failed.');
                }
              }}
            >
              Import legacy data
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
          <pre>{summary ? JSON.stringify(summary, null, 2) : 'No import executed yet.'}</pre>
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Tool Registry</p>
              <h3>Manifest inventory from unified runtime</h3>
            </div>
            <span className="status-pill">{manifests.length} tools</span>
          </div>
          {manifests.length ? (
            <div className="record-list">
              {manifests.map((manifest) => (
                <article key={manifest.id} className="record-row">
                  <div>
                    <p className="record-label">{manifest.name}</p>
                    <strong>{manifest.id}</strong>
                    <p className="record-meta">
                      {manifest.runtime} | {manifest.schema_count} schema
                      {manifest.schema_count === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="job-meta">
                    <span className="status-pill">{manifest.access_level}</span>
                    <time>{manifest.version}</time>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">No tool manifests discovered.</p>
          )}
        </article>

        <article className="card">
          <p className="eyebrow">Tool Execution</p>
          <h3>Run real tool scripts from the unified daemon</h3>
          <label className="field">
            <span>Tool</span>
            <select
              value={selectedToolId}
              onChange={(event) => {
                const nextId = event.target.value;
                setSelectedToolId(nextId);
                setArgsJson(suggestArgs(nextId));
              }}
              disabled={!manifests.length}
            >
              {manifests.map((manifest) => (
                <option key={manifest.id} value={manifest.id}>
                  {manifest.name} ({manifest.id})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Arguments (JSON)</span>
            <textarea
              value={argsJson}
              onChange={(event) => setArgsJson(event.target.value)}
              placeholder='{"message":"hello"}'
            />
          </label>
          <label className="field">
            <span>Timeout (ms, optional)</span>
            <input
              value={timeoutMs}
              onChange={(event) => setTimeoutMs(event.target.value)}
              placeholder={String(selectedManifest?.schemas.length ? 5000 : 30000)}
            />
          </label>
          <div className="actions">
            <button
              onClick={async () => {
                if (!selectedToolId) {
                  return;
                }
                try {
                  const parsedArgs = argsJson.trim() ? JSON.parse(argsJson) : {};
                  const parsedTimeout = timeoutMs.trim() ? Number(timeoutMs) : null;
                  if (parsedTimeout !== null && (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0)) {
                    throw new Error('Timeout must be a positive number.');
                  }
                  const response = await executeTool({
                    tool_id: selectedToolId,
                    args: parsedArgs,
                    timeout_ms: parsedTimeout,
                  });
                  setLatestExecution(response);
                  setExecuteError(null);
                  await refreshHistory();
                } catch (nextError) {
                  setExecuteError(
                    nextError instanceof Error ? nextError.message : 'Tool execution failed.',
                  );
                }
              }}
              disabled={!selectedToolId}
            >
              Execute tool
            </button>
            <button className="ghost" onClick={refreshHistory}>
              Refresh history
            </button>
          </div>
          {executeError ? <p className="error">{executeError}</p> : null}
          <pre>{latestExecution ? JSON.stringify(latestExecution, null, 2) : 'No tool executed yet.'}</pre>
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Execution History</p>
              <h3>Recent tool calls</h3>
            </div>
            <span className="status-pill">{history.length} records</span>
          </div>
          {history.length ? (
            <div className="record-list">
              {history.map((record) => (
                <article key={record.execution_id} className="record-row">
                  <div>
                    <p className="record-label">{record.tool_id}</p>
                    <strong>{record.status}</strong>
                    <p className="record-meta">
                      duration {record.duration_ms}ms | exit{' '}
                      {record.exit_code === null ? 'n/a' : record.exit_code}
                    </p>
                    {record.error ? <p className="error">{record.error}</p> : null}
                  </div>
                  <div className="job-meta">
                    <span className={`status-pill ${record.ok ? 'status-running' : 'status-failed'}`}>
                      {record.ok ? 'ok' : 'failed'}
                    </span>
                    <time>{new Date(record.executed_at).toLocaleString()}</time>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">No tool execution history yet.</p>
          )}
        </article>

        <article className="card">
          <p className="eyebrow">Contracts</p>
          <h3>Shared API types</h3>
          <p className="muted-copy">
            Rust models in <code>crates/api-types</code> are exported into
            <code> apps/web/src/generated/api.ts</code>. The web console should only speak those
            shared shapes.
          </p>
        </article>
      </div>
    </section>
  );
}
