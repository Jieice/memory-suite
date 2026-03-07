import { useEffect, useEffectEvent, useState } from 'react';
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
      setError(nextError instanceof Error ? nextError.message : 'Failed to refresh training lane.');
    }
  });

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">Training Lane</p>
        <h2>Train and eval from the unified supervisor</h2>
        <p className="page-copy">
          This replaces the old training.html workflow with the Rust-owned job queue. Queue
          creation, adapter runs, and execution history now live behind the same daemon.
        </p>
      </header>

      <section className="hero-panel">
        <div>
          <p className="eyebrow">Operator Flow</p>
          <h3>One queue for train, eval, and adapter supervision.</h3>
          <p className="hero-copy">
            Use this page for the day-to-day training loop: submit a run, inspect adapter state,
            and verify the latest queue records without leaving the unified console.
          </p>
        </div>
        <div className="hero-metrics">
          <Metric label="Queued jobs" value={String(jobs.length)} accent />
          <Metric label="Adapters" value={String(adapters.length)} />
          <Metric
            label="Running"
            value={String(adapters.filter((adapter) => adapter.status === 'running').length)}
          />
          <Metric
            label="Failures"
            value={String(jobs.filter((record) => record.status === 'failed').length)}
          />
        </div>
      </section>

      <div className="card-grid">
        <article className="card emphasis">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Queue Control</p>
              <h3>Submit a supervised run</h3>
            </div>
            <button className="ghost" onClick={() => refresh()}>
              Refresh
            </button>
          </div>
          <label className="field">
            <span>Input path</span>
            <input value={dataset} onChange={(event) => setDataset(event.target.value)} />
          </label>
          <label className="field">
            <span>Profile</span>
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
              Queue train
            </button>
            <button
              className="ghost"
              onClick={async () => {
                const response = await createEvalJob({ input: dataset, profile });
                setJob(response);
                await refresh();
              }}
            >
              Queue eval
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
          <JsonPanel title="Most recent submission" value={job} empty="No job queued yet." />
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Adapter Deck</p>
              <h3>Supervised Python edges</h3>
            </div>
            <span className="status-pill">{adapters.length} runs</span>
          </div>
          {adapters.length ? (
            <div className="record-list">
              {adapters.map((adapter) => (
                <article key={adapter.id} className="record-row">
                  <div>
                    <p className="record-label">{adapter.adapter_id}</p>
                    <strong>{adapter.python_executable}</strong>
                    <p className="record-meta">{adapter.args.join(' ') || 'no extra args'}</p>
                  </div>
                  <div className="job-meta">
                    <span className={`status-pill status-${adapter.status}`}>{adapter.status}</span>
                    <time>{new Date(adapter.updated_at).toLocaleString()}</time>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">No adapters supervised yet.</p>
          )}
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Queue History</p>
              <h3>Latest unified job records</h3>
            </div>
            <span className="status-pill">{jobs.length} records</span>
          </div>
          {jobs.length ? (
            <div className="record-list">
              {jobs.map((record) => (
                <article key={record.id} className="record-row">
                  <div>
                    <p className="record-label">{record.kind}</p>
                    <strong>{record.profile ?? 'default profile'}</strong>
                    <p className="record-meta">{record.input ?? 'no input path'}</p>
                  </div>
                  <div className="job-meta">
                    <span className={`status-pill status-${record.status}`}>{record.status}</span>
                    <time>{new Date(record.created_at).toLocaleString()}</time>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">No jobs recorded yet.</p>
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

function JsonPanel<T>({ title, value, empty }: { title: string; value: T | null; empty: string }) {
  return (
    <div className="json-block">
      <p className="eyebrow">{title}</p>
      <pre>{value ? JSON.stringify(value, null, 2) : empty}</pre>
    </div>
  );
}
