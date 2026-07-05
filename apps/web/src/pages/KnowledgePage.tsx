import { useCallback, useEffect, useState } from 'react';
import type { KnowledgeCatalogResponse } from '../generated/api';
import { fetchKnowledgeCatalog } from '../lib';

export function KnowledgePage() {
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<KnowledgeCatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (search: string) => {
    try {
      const nextCatalog = await fetchKnowledgeCatalog(search, 18);
      setCatalog(nextCatalog);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '知识目录加载失败。');
    }
  }, []);

  useEffect(() => {
    void refresh('');
  }, []);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">知识库</p>
        <h2>统一记忆目录</h2>
        <p className="page-copy">
          这里替代旧的 knowledge.html 浏览器，由 Rust 后端直接读取存储。用户档案、记忆条目和配置产物都在这里检索。
        </p>
      </header>

      <section className="hero-panel">
        <div>
          <p className="eyebrow">目录搜索</p>
          <h3>浏览统一存储里真正记录的内容。</h3>
          <p className="hero-copy">
            旧调度面板不再是主入口。现在更重要的是 SQLite 中已有的数据，以及支撑运行时的配置产物。
          </p>
        </div>
        <div className="hero-metrics">
          <Metric label="档案" value={String(catalog?.profiles.length ?? 0)} accent />
          <Metric label="记忆条目" value={String(catalog?.memory_entries.length ?? 0)} />
          <Metric label="配置" value={String(catalog?.config_artifacts.length ?? 0)} />
        </div>
      </section>

      <article className="card emphasis">
        <div className="card-heading">
          <div>
            <p className="eyebrow">搜索</p>
            <h3>筛选知识目录</h3>
          </div>
          <button className="ghost" onClick={() => void refresh(query)}>
            刷新
          </button>
        </div>
        <div className="toolbar">
          <input
            value={query}
            placeholder="创作者、动画、配置、房间号..."
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void refresh(query);
              }
            }}
          />
          <button onClick={() => void refresh(query)}>搜索</button>
          <button
            className="ghost"
            onClick={() => {
              setQuery('');
              void refresh('');
            }}
          >
            清空
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </article>

      <div className="card-grid">
        <CatalogCard
          title="用户档案"
          empty="没有匹配的用户档案。"
          items={(catalog?.profiles ?? []).map((profile) => ({
            key: profile.user_id,
            title: profile.preferred_name ?? profile.user_id,
            subtitle: profile.user_id,
            meta: `${profile.interaction_count} 次互动`,
          }))}
        />
        <CatalogCard
          title="记忆条目"
          empty="没有匹配的记忆条目。"
          items={(catalog?.memory_entries ?? []).map((entry) => ({
            key: entry.id,
            title: `${entry.user_id} · ${entry.entry_type}`,
            subtitle: entry.source,
            meta: JSON.stringify(entry.payload),
          }))}
        />
        <CatalogCard
          title="配置产物"
          empty="没有匹配的配置产物。"
          items={(catalog?.config_artifacts ?? []).map((artifact) => ({
            key: artifact.id,
            title: artifact.kind,
            subtitle: artifact.path,
            meta: artifact.copied_to ?? '未复制',
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
          <p className="eyebrow">目录</p>
          <h3>{title}</h3>
        </div>
        <span className="status-pill">{items.length}</span>
      </div>
      {items.length ? (
        <div className="record-list scroll-region">
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
