import { startTransition, useEffect, useEffectEvent, useState } from 'react';
import type { AdapterRecord, ImportSummary, RuntimeEvent, RuntimeOverview } from '../generated/api';
import {
  fetchRuntimeOverview,
  importLegacy,
  listAdapters,
  openRuntimeStream,
  startAdapter,
} from '../lib';

export function RuntimePage() {
  const [overview, setOverview] = useState<RuntimeOverview | null>(null);
  const [adapters, setAdapters] = useState<AdapterRecord[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [root, setRoot] = useState('.');
  const [error, setError] = useState<string | null>(null);

  const refresh = useEffectEvent(async () => {
    try {
      const [nextOverview, nextAdapters] = await Promise.all([
        fetchRuntimeOverview(),
        listAdapters(),
      ]);
      setOverview(nextOverview);
      setAdapters(nextAdapters);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Runtime refresh failed.');
    }
  });

  const handleEvent = useEffectEvent((event: RuntimeEvent) => {
    startTransition(() => {
      setEvents((current) => [event, ...current].slice(0, 16));
    });
    void refresh();
  });

  useEffect(() => {
    void refresh();
    return openRuntimeStream(handleEvent);
  }, [handleEvent, refresh]);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">Runtime Console</p>
        <h2>Supervisor wall for the unified daemon</h2>
        <p className="page-copy">
          This is the live cutover surface: adapter supervision, event feed, runtime counts, and a
          direct migration trigger without touching the old manager pages.
        </p>
      </header>

      <section className="runtime-stage">
        <article className="card runtime-hero">
          <div className="runtime-hero-copy">
            <p className="eyebrow">Operations Room</p>
            <h3>Observe the daemon the same way you will operate it after cutover.</h3>
            <p className="muted-copy">
              Web UI, jobs, adapters, and migration controls now orbit one HTTP entrypoint and one
              SQLite-backed runtime.
            </p>
          </div>
          <div className="hero-metrics">
            <Metric label="DB" value={overview?.db_ready ? 'ready' : 'check'} accent />
            <Metric label="Msgs" value={String(overview?.message_count ?? 0)} />
            <Metric label="Jobs" value={String(overview?.job_count ?? 0)} />
            <Metric label="Imports" value={String(overview?.config_artifact_count ?? 0)} />
          </div>
        </article>

        <div className="runtime-columns">
          <article className="card emphasis runtime-column">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Adapters</p>
                <h3>Supervisor quick-start</h3>
              </div>
              <button className="ghost" onClick={() => refresh()}>
                Refresh
              </button>
            </div>
            <div className="actions">
              <button
                onClick={async () => {
                  await startAdapter('tts', { args: [] });
                  await refresh();
                }}
              >
                Start TTS
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await startAdapter('train', { args: [] });
                  await refresh();
                }}
              >
                Start train
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await startAdapter('eval', { args: [] });
                  await refresh();
                }}
              >
                Start eval
              </button>
            </div>
            {adapters.length ? (
              <div className="adapter-list">
                {adapters.map((adapter) => (
                  <article key={adapter.id} className="adapter-row">
                    <div>
                      <p className="adapter-name">{adapter.adapter_id}</p>
                      <strong>{adapter.python_executable}</strong>
                      <p className="job-path">{adapter.args.join(' ') || '(default args)'}</p>
                    </div>
                    <div className="job-meta">
                      <span className={`status-pill status-${adapter.status}`}>{adapter.status}</span>
                      <time>{new Date(adapter.started_at).toLocaleString()}</time>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted-copy">No supervised adapters have started yet.</p>
            )}
          </article>

          <article className="card runtime-column">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Event Feed</p>
                <h3>Live bus from chat, jobs, and adapters</h3>
              </div>
              <span className="status-pill">{events.length} buffered</span>
            </div>
            {events.length ? (
              <div className="event-list">
                {events.map((event) => (
                  <article key={event.id} className="event-row">
                    <span className={`event-marker event-${event.kind}`} />
                    <div>
                      <p className="job-kind">{event.kind}</p>
                      <strong>{event.source}</strong>
                      <p className="job-path">{event.detail ?? 'No detail'}</p>
                    </div>
                    <time>{new Date(event.created_at).toLocaleTimeString()}</time>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted-copy">No runtime events received yet.</p>
            )}
          </article>
        </div>

        <div className="runtime-columns">
          <article className="card runtime-column">
            <p className="eyebrow">Import Summary</p>
            <h3>Legacy data ingestion</h3>
            <label className="field">
              <span>Source root</span>
              <input value={root} onChange={(event) => setRoot(event.target.value)} />
            </label>
            <div className="actions">
              <button
                onClick={async () => {
                  try {
                    const imported = await importLegacy({ root });
                    setSummary(imported);
                    await refresh();
                  } catch (nextError) {
                    setError(nextError instanceof Error ? nextError.message : 'Import failed.');
                  }
                }}
              >
                Run import
              </button>
            </div>
            <pre>{summary ? JSON.stringify(summary, null, 2) : 'No import executed from this console yet.'}</pre>
          </article>

          <article className="card runtime-column">
            <p className="eyebrow">Storage Footprint</p>
            <h3>Current unified database counts</h3>
            <dl className="definition-grid">
              <Stat label="Messages" value={String(overview?.message_count ?? 0)} />
              <Stat label="Jobs" value={String(overview?.job_count ?? 0)} />
              <Stat label="Profiles" value={String(overview?.user_profile_count ?? 0)} />
              <Stat label="Memories" value={String(overview?.memory_entry_count ?? 0)} />
              <Stat label="Events" value={String(overview?.legacy_event_count ?? 0)} />
              <Stat label="Configs" value={String(overview?.config_artifact_count ?? 0)} />
            </dl>
            {error ? <p className="error">{error}</p> : null}
          </article>
        </div>
      </section>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="definition-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
