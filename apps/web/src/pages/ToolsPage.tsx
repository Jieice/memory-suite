import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { JsonBlock } from '../components/JsonBlock';
import type { ToolExecutionResponse, ToolManifestRecord } from '../generated/api';
import { executeTool, listToolExecutions, listToolManifests } from '../lib';

function suggestArgs(toolId: string): string {
  switch (toolId) {
    case 'echo':
      return '{\n  "message": "你好，工具执行"\n}';
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
      setError(nextError instanceof Error ? nextError.message : '工具清单加载失败。');
    }
  });

  const refreshHistory = useEffectEvent(async () => {
    try {
      setHistory(await listToolExecutions(20));
      setExecuteError(null);
    } catch (nextError) {
      setExecuteError(
        nextError instanceof Error ? nextError.message : '工具执行历史加载失败。',
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
        <p className="eyebrow">工具</p>
        <h2>类型契约与操作工具</h2>
        <p className="page-copy">
          这里用于查看 Rust 到 TypeScript 的共享契约，并从统一后端执行本地工具。
        </p>
      </header>

      <div className="card-grid">
        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">工具注册表</p>
              <h3>统一运行时中的工具清单</h3>
            </div>
            <span className="status-pill">{manifests.length} 个工具</span>
          </div>
          {manifests.length ? (
            <div className="record-list scroll-region">
              {manifests.map((manifest) => (
                <article key={manifest.id} className="record-row">
                  <div>
                    <p className="record-label">{manifest.name}</p>
                    <strong>{manifest.id}</strong>
                    <p className="record-meta">
                      {manifest.runtime} | {manifest.schema_count} 个 schema
                    </p>
                  </div>
                  <div className="side-meta">
                    <span className="status-pill">{manifest.access_level}</span>
                    <time>{manifest.version}</time>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">还没有发现工具清单。</p>
          )}
        </article>

        <article className="card">
          <p className="eyebrow">工具执行</p>
          <h3>从统一后端运行真实工具脚本</h3>
          <label className="field">
            <span>工具</span>
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
            <span>参数（JSON）</span>
            <textarea
              value={argsJson}
              onChange={(event) => setArgsJson(event.target.value)}
              placeholder='{"message":"hello"}'
            />
          </label>
          <label className="field">
            <span>超时（毫秒，可选）</span>
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
                    throw new Error('超时必须是正数。');
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
                    nextError instanceof Error ? nextError.message : '工具执行失败。',
                  );
                }
              }}
              disabled={!selectedToolId}
            >
              执行工具
            </button>
            <button className="ghost" onClick={refreshHistory}>
              刷新历史
            </button>
          </div>
          {executeError ? <p className="error">{executeError}</p> : null}
          <JsonBlock title="最近执行" value={latestExecution} empty="还没有执行工具。" />
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">执行历史</p>
              <h3>最近工具调用</h3>
            </div>
            <span className="status-pill">{history.length} 条记录</span>
          </div>
          {history.length ? (
            <div className="record-list scroll-region">
              {history.map((record) => (
                <article key={record.execution_id} className="record-row">
                  <div>
                    <p className="record-label">{record.tool_id}</p>
                    <strong>{record.status}</strong>
                    <p className="record-meta">
                      耗时 {record.duration_ms}ms | 退出码{' '}
                      {record.exit_code === null ? '无' : record.exit_code}
                    </p>
                    {record.error ? <p className="error">{record.error}</p> : null}
                  </div>
                  <div className="side-meta">
                    <span className={`status-pill ${record.ok ? 'status-running' : 'status-failed'}`}>
                      {record.ok ? '成功' : '失败'}
                    </span>
                    <time>{new Date(record.executed_at).toLocaleString()}</time>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">还没有工具执行历史。</p>
          )}
        </article>

        <article className="card">
          <p className="eyebrow">契约</p>
          <h3>共享 API 类型</h3>
          <p className="muted-copy">
            <code>crates/api-types</code> 中的 Rust 模型会导出到
            <code> apps/web/src/generated/api.ts</code>。桌面控制台只使用这些共享结构与后端通信。
          </p>
        </article>
      </div>
    </section>
  );
}
