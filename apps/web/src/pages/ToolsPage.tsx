import { useState } from 'react';
import type { ImportSummary } from '../generated/api';
import { importLegacy } from '../lib';

export function ToolsPage() {
  const [root, setRoot] = useState('.');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          <p className="eyebrow">Contracts</p>
          <h3>Shared API types</h3>
          <p className="muted-copy">
            Rust models in <code>crates/api-types</code> are exported into
            <code> apps/web/src/generated/api.ts</code>. The web console should only speak those
            shared shapes.
          </p>
        </article>

        <article className="card">
          <p className="eyebrow">Cutover</p>
          <h3>Unified startup path</h3>
          <p className="muted-copy">
            The remaining steps are to move train/eval execution fully behind the daemon, update the
            bootstrap script, and retire the old multi-service startup flow.
          </p>
        </article>
      </div>
    </section>
  );
}
