import { useEffect, useEffectEvent, useState } from 'react';
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
      setError(nextError instanceof Error ? nextError.message : 'Failed to load jobs.');
    }
  });

  useEffect(() => {
    refreshJobs();
  }, [refreshJobs]);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">Long-running Tasks</p>
        <h2>Training and evaluation queue</h2>
        <p className="page-copy">
          This page tracks the new Rust-owned job lane. Queue creation is live; execution metadata
          will be shown here as adapters begin supervising train and eval workloads.
        </p>
      </header>

      <div className="card-grid">
        <article className="card emphasis">
          <p className="eyebrow">Queue Control</p>
          <h3>Launch a supervised job</h3>
          <label className="field">
            <span>Input path</span>
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
              Queue train
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
              Queue eval
            </button>
            <button className="ghost" onClick={() => refreshJobs()}>
              Refresh
            </button>
          </div>
          <JsonPanel title="Most recent submission" value={job} empty="No job queued yet." />
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Queue State</p>
              <h3>Job records from unified storage</h3>
            </div>
            <span className="status-pill">{jobs.length} records</span>
          </div>
          {error ? <p className="error">{error}</p> : null}
          {jobs.length ? (
            <div className="job-list">
              {jobs.map((record) => (
                <article key={record.id} className="job-row">
                  <div>
                    <p className="job-kind">{record.kind}</p>
                    <strong>{record.profile ?? 'default-profile'}</strong>
                    <p className="job-path">{record.input ?? 'no input path'}</p>
                  </div>
                  <div className="job-meta">
                    <span className={`status-pill status-${record.status}`}>{record.status}</span>
                    <time>{new Date(record.created_at).toLocaleString()}</time>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">No jobs loaded yet.</p>
          )}
        </article>
      </div>
    </section>
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
