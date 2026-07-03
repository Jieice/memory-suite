import { useEffect, useEffectEvent, useState } from 'react';
import { JsonBlock } from '../components/JsonBlock';
import type { AdapterRecord, JobRecord, JobResponse } from '../generated/api';
import { createEvalJob, createTrainJob, listAdapters, listJobs } from '../lib';

export function TrainingPage() {
  const [dataset, setDataset] = useState('data/training/anime-corpus');
  const [profile, setProfile] = useState('anime');
  const [job, setJob] = useState<JobResponse | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [adapters, setAdapters] = useState<AdapterRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useEffectEvent(async () => {
    try {
      const [nextJobs, nextAdapters] = await Promise.all([listJobs(), listAdapters()]);
      setJobs(nextJobs);
      setAdapters(nextAdapters);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '训练通道刷新失败。');
    }
  });

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">训练通道</p>
        <h2>从统一监管器发起训练与评测</h2>
        <p className="page-copy">
          这里替代旧的 training.html 工作流。任务提交、适配器运行与执行历史都归同一个后端管理。
        </p>
      </header>

      <section className="hero-panel">
        <div>
          <p className="eyebrow">操作流程</p>
          <h3>训练、评测和适配器监管共用一个队列。</h3>
          <p className="hero-copy">
            日常训练循环可以直接在这里完成：提交运行、检查适配器状态、确认最新队列记录。
          </p>
        </div>
        <div className="hero-metrics">
          <Metric label="队列任务" value={String(jobs.length)} accent />
          <Metric label="适配器" value={String(adapters.length)} />
          <Metric
            label="运行中"
            value={String(adapters.filter((adapter) => adapter.status === 'running').length)}
          />
          <Metric
            label="失败"
            value={String(jobs.filter((record) => record.status === 'failed').length)}
          />
        </div>
      </section>

      <div className="card-grid">
        <article className="card emphasis">
          <div className="card-heading">
            <div>
              <p className="eyebrow">队列控制</p>
              <h3>提交受监管运行</h3>
            </div>
            <button className="ghost" onClick={() => refresh()}>
              刷新
            </button>
          </div>
          <label className="field">
            <span>输入路径</span>
            <input value={dataset} onChange={(event) => setDataset(event.target.value)} />
          </label>
          <label className="field">
            <span>档案</span>
            <input value={profile} onChange={(event) => setProfile(event.target.value)} />
          </label>
          <div className="actions">
            <button
              onClick={async () => {
                const response = await createTrainJob({ input: dataset, profile });
                setJob(response);
                await refresh();
              }}
            >
              排队训练
            </button>
            <button
              className="ghost"
              onClick={async () => {
                const response = await createEvalJob({ input: dataset, profile });
                setJob(response);
                await refresh();
              }}
            >
              排队评测
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
          <JsonBlock title="最近提交" value={job} empty="还没有排队任务。" />
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">适配器面板</p>
              <h3>受监管的 Python 边缘执行</h3>
            </div>
            <span className="status-pill">{adapters.length} 次运行</span>
          </div>
          {adapters.length ? (
            <div className="record-list scroll-region">
              {adapters.map((adapter) => (
                <article key={adapter.id} className="record-row">
                  <div>
                    <p className="record-label">{adapter.adapter_id}</p>
                    <strong>{adapter.python_executable}</strong>
                    <p className="record-meta">{adapter.args.join(' ') || '无额外参数'}</p>
                  </div>
                  <div className="job-meta">
                    <span className={`status-pill status-${adapter.status}`}>{adapter.status}</span>
                    <time>{new Date(adapter.updated_at).toLocaleString()}</time>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">还没有受监管的适配器。</p>
          )}
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">队列历史</p>
              <h3>最新统一任务记录</h3>
            </div>
            <span className="status-pill">{jobs.length} 条记录</span>
          </div>
          {jobs.length ? (
            <div className="record-list scroll-region">
              {jobs.map((record) => (
                <article key={record.id} className="record-row">
                  <div>
                    <p className="record-label">{record.kind}</p>
                    <strong>{record.profile ?? '默认档案'}</strong>
                    <p className="record-meta">{record.input ?? '无输入路径'}</p>
                  </div>
                  <div className="job-meta">
                    <span className={`status-pill status-${record.status}`}>{record.status}</span>
                    <time>{new Date(record.created_at).toLocaleString()}</time>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">还没有任务记录。</p>
          )}
        </article>
      </div>
    </section>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <article className={`metric-card${accent ? ' accent' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
