import { useEffect, useEffectEvent, useState } from 'react';
import type { ImportSummary, ToolManifestRecord } from '../generated/api';
import { importLegacy, listToolManifests } from '../lib';

export function ToolsPage() {
  const [root, setRoot] = useState('.');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [manifests, setManifests] = useState<ToolManifestRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshTools = useEffectEvent(async () => {
    try {
      setManifests(await listToolManifests());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to load tool manifests.');
    }
  });

  useEffect(() => {
    refreshTools();
  }, [refreshTools]);

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
                      {manifest.runtime} · {manifest.schema_count} schema
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
