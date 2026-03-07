import { useEffect, useEffectEvent, useState } from 'react';
import type { KnowledgeCatalogResponse } from '../generated/api';
import { fetchKnowledgeCatalog } from '../lib';

export function KnowledgePage() {
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<KnowledgeCatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useEffectEvent(async (search = query) => {
    try {
      const nextCatalog = await fetchKnowledgeCatalog(search, 18);
      setCatalog(nextCatalog);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to load knowledge catalog.');
    }
  });

  useEffect(() => {
    refresh('');
  }, [refresh]);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">Knowledge</p>
        <h2>Unified memory and import catalog</h2>
        <p className="page-copy">
          This replaces the old knowledge.html browser with a storage-first catalog backed by the
          Rust daemon. Search imported profiles, memory entries, legacy events, and config artifacts
          from one surface.
        </p>
      </header>

      <section className="hero-panel">
        <div>
          <p className="eyebrow">Catalog Search</p>
          <h3>Browse what the unified store actually knows.</h3>
          <p className="hero-copy">
            The old scheduler panels are no longer the primary path. What matters now is the data
            already pulled into SQLite and the imported configuration artifacts that support cutover.
          </p>
        </div>
        <div className="hero-metrics">
          <Metric label="Profiles" value={String(catalog?.profiles.length ?? 0)} accent />
          <Metric label="Memory entries" value={String(catalog?.memory_entries.length ?? 0)} />
          <Metric label="Legacy events" value={String(catalog?.legacy_events.length ?? 0)} />
          <Metric label="Configs" value={String(catalog?.config_artifacts.length ?? 0)} />
        </div>
      </section>

      <article className="card emphasis">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Search</p>
            <h3>Filter the knowledge catalog</h3>
          </div>
          <button className="ghost" onClick={() => refresh(query)}>
            Refresh
          </button>
        </div>
        <div className="toolbar">
          <input
            value={query}
            placeholder="creator, anime, config, room id..."
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void refresh(query);
              }
            }}
          />
          <button onClick={() => refresh(query)}>Search</button>
          <button
            className="ghost"
            onClick={() => {
              setQuery('');
              void refresh('');
            }}
          >
            Clear
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </article>

      <div className="card-grid">
        <CatalogCard
          title="User profiles"
          empty="No profiles matched."
          items={(catalog?.profiles ?? []).map((profile) => ({
            key: profile.user_id,
            title: profile.preferred_name ?? profile.user_id,
            subtitle: profile.user_id,
            meta: `${profile.interaction_count} interactions`,
          }))}
        />
        <CatalogCard
          title="Memory entries"
          empty="No memory entries matched."
          items={(catalog?.memory_entries ?? []).map((entry) => ({
            key: entry.id,
            title: `${entry.user_id} · ${entry.entry_type}`,
            subtitle: entry.source,
            meta: JSON.stringify(entry.payload),
          }))}
        />
        <CatalogCard
          title="Legacy events"
          empty="No legacy events matched."
          items={(catalog?.legacy_events ?? []).map((event) => ({
            key: event.id,
            title: event.source_type,
            subtitle: event.source_path,
            meta: JSON.stringify(event.payload),
          }))}
        />
        <CatalogCard
          title="Config artifacts"
          empty="No config artifacts matched."
          items={(catalog?.config_artifacts ?? []).map((artifact) => ({
            key: artifact.id,
            title: artifact.kind,
            subtitle: artifact.path,
            meta: artifact.copied_to ?? 'not copied',
          }))}
        />
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

function CatalogCard({
  title,
  items,
  empty,
}: {
  title: string;
  items: Array<{ key: string; title: string; subtitle: string; meta: string }>;
  empty: string;
}) {
  return (
    <article className="card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Catalog</p>
          <h3>{title}</h3>
        </div>
        <span className="status-pill">{items.length}</span>
      </div>
      {items.length ? (
        <div className="record-list">
          {items.map((item) => (
            <article key={item.key} className="record-row">
              <div>
                <p className="record-label">{item.title}</p>
                <strong>{item.subtitle}</strong>
                <p className="record-meta record-wrap">{item.meta}</p>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="muted-copy">{empty}</p>
      )}
    </article>
  );
}
