import { useEffect, useEffectEvent, useState } from 'react';
import type { ChatResponse, HealthResponse, RuntimeOverview, StoredMessage } from '../generated/api';
import { fetchHealth, fetchRuntimeOverview, listSessionMessages, queueTts, sendChat } from '../lib';

const SESSION_ID = 'web-demo';

export function DashboardPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [overview, setOverview] = useState<RuntimeOverview | null>(null);
  const [chat, setChat] = useState<ChatResponse | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [chatInput, setChatInput] = useState('Run a quick status check for the unified runtime.');
  const [error, setError] = useState<string | null>(null);

  const refresh = useEffectEvent(async () => {
    try {
      const [nextHealth, nextOverview, nextMessages] = await Promise.all([
        fetchHealth(),
        fetchRuntimeOverview(),
        listSessionMessages(SESSION_ID).catch(() => []),
      ]);
      setHealth(nextHealth);
      setOverview(nextOverview);
      setMessages(nextMessages);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Runtime refresh failed.');
    }
  });

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">Control Surface</p>
        <h2>Single-process operator deck</h2>
        <p className="page-copy">
          The Rust daemon is now the runtime spine. This page is for fast operator checks: health,
          message throughput, and a direct chat probe into the unified path.
        </p>
      </header>

      <section className="hero-panel">
        <div>
          <p className="eyebrow">Runtime Posture</p>
          <h3>One entrypoint, one database, one control plane.</h3>
          <p className="hero-copy">
            The system now owns chat ingress, runtime counts, adapter supervision, and session
            persistence from the same process boundary.
          </p>
        </div>
        <div className="hero-metrics">
          <Metric label="Health" value={health?.status ?? 'Loading'} accent />
          <Metric label="Messages" value={String(overview?.message_count ?? 0)} />
          <Metric label="Jobs" value={String(overview?.job_count ?? 0)} />
          <Metric label="Profiles" value={String(overview?.user_profile_count ?? 0)} />
        </div>
      </section>

      <div className="card-grid runtime-grid">
        <article className="card emphasis">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Live Snapshot</p>
              <h3>Health and storage footprint</h3>
            </div>
            <button className="ghost" onClick={() => refresh()}>
              Refresh
            </button>
          </div>
          <dl className="definition-grid">
            <Stat label="Version" value={health?.version ?? '...'} />
            <Stat label="Mode" value={health?.runtime_mode ?? '...'} />
            <Stat label="Database" value={health?.db_ready ? 'ready' : 'checking'} />
            <Stat label="Memories" value={String(overview?.memory_entry_count ?? 0)} />
            <Stat label="Configs" value={String(overview?.config_artifact_count ?? 0)} />
          </dl>
          {error ? <p className="error">{error}</p> : null}
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Chat Probe</p>
              <h3>Exercise the unified API path</h3>
            </div>
          </div>
          <label className="field">
            <span>Operator message</span>
            <textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} />
          </label>
          <div className="actions">
            <button
              onClick={async () => {
                const response = await sendChat({
                  session_id: SESSION_ID,
                  user_id: 'operator',
                  text: chatInput,
                });
                setChat(response);
                await refresh();
              }}
            >
              Send chat
            </button>
            <button
              className="ghost"
              onClick={async () => {
                await queueTts({ session_id: SESSION_ID, text: chatInput, voice: 'edge-tts-en' });
                await refresh();
              }}
            >
              Dispatch TTS
            </button>
          </div>
          <div className="stack-blocks">
            <JsonBlock title="Last response" value={chat} empty="No chat response yet." />
            <JsonBlock title="Session transcript" value={messages} empty="No session messages yet." />
          </div>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="definition-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function JsonBlock<T>({ title, value, empty }: { title: string; value: T | null | T[]; empty: string }) {
  const hasValue = Array.isArray(value) ? value.length > 0 : value !== null;
  return (
    <div className="json-block">
      <p className="eyebrow">{title}</p>
      <pre>{hasValue ? JSON.stringify(value, null, 2) : empty}</pre>
    </div>
  );
}
