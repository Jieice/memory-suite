import { useEffect, useEffectEvent, useState } from 'react';
import { JsonBlock } from '../components/JsonBlock';
import type { JobRecord, JobResponse } from '../generated/api';
import { createEvalJob, createTrainJob, listJobs } from '../lib';

export function JobsPage() {
  const [dataset, setDataset] = useState('data/training/anime-corpus');
  const [job, setJob] = useState<JobResponse | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshJobs = useEffectEvent(async () => {
    try {
      setJobs(await listJobs());
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '任务加载失败。');
    }
  });

  useEffect(() => {
    refreshJobs();
  }, [refreshJobs]);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">长任务</p>
        <h2>训练与评测队列</h2>
        <p className="page-copy">
          这里跟踪由 Rust 后端接管的任务队列。提交任务后，适配器执行状态会在这里同步显示。
        </p>
      </header>

      <div className="card-grid">
        <article className="card emphasis">
          <p className="eyebrow">队列控制</p>
          <h3>启动受监管任务</h3>
          <label className="field">
            <span>输入路径</span>
            <input value={dataset} onChange={(event) => setDataset(event.target.value)} />
          </label>
          <div className="actions">
            <button
              onClick={async () => {
                const response = await createTrainJob({ input: dataset, profile: 'anime' });
                setJob(response);
                await refreshJobs();
              }}
            >
              排队训练
            </button>
            <button
              className="ghost"
              onClick={async () => {
                const response = await createEvalJob({
                  input: 'eval/intelligence/dataset.v2.json',
                  profile: 'smoke',
                });
                setJob(response);
                await refreshJobs();
              }}
            >
              排队评测
            </button>
            <button className="ghost" onClick={() => refreshJobs()}>
              刷新
            </button>
          </div>
          <JsonBlock title="最近提交" value={job} empty="还没有排队任务。" />
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">队列状态</p>
              <h3>统一存储中的任务记录</h3>
            </div>
            <span className="status-pill">{jobs.length} 条记录</span>
          </div>
          {error ? <p className="error">{error}</p> : null}
          {jobs.length ? (
            <div className="job-list scroll-region">
              {jobs.map((record) => (
                <article key={record.id} className="job-row">
                  <div>
                    <p className="job-kind">{record.kind}</p>
                    <strong>{record.profile ?? '默认档案'}</strong>
                    <p className="job-path">{record.input ?? '无输入路径'}</p>
                  </div>
                  <div className="job-meta">
                    <span className={`status-pill status-${record.status}`}>{record.status}</span>
                    <time>{new Date(record.created_at).toLocaleString()}</time>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">还没有加载任务。</p>
          )}
        </article>
      </div>
    </section>
  );
}
