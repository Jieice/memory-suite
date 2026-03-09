import { useEffect, useEffectEvent, useState } from 'react';
import type { ChatResponse, RuntimeOverview, StoredMessage } from '../generated/api';
import { fetchRuntimeOverview, listSessionMessages, queueTts, sendChat, updateLive2dSubtitle } from '../lib';

const SESSION_ID = 'creator-backstage';
const QUICK_COMMANDS = ['/status', '/readiness', '/go', '/selfcheck', '/eval chat', '/train'];

export function CreatorChatPage() {
  const [overview, setOverview] = useState<RuntimeOverview | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [draft, setDraft] = useState('/status');
  const [lastResponse, setLastResponse] = useState<ChatResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useEffectEvent(async () => {
    try {
      const [nextOverview, nextMessages] = await Promise.all([
        fetchRuntimeOverview(),
        listSessionMessages(SESSION_ID),
      ]);
      setOverview(nextOverview);
      setMessages(nextMessages);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to refresh creator session.');
    }
  });

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function submitMessage(text: string) {
    const response = await sendChat({
      session_id: SESSION_ID,
      user_id: 'creator',
      text,
    });
    setLastResponse(response);
    setDraft('');
    await refresh();
  }

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">Creator Channel</p>
        <h2>Backstage chat on the unified runtime</h2>
        <p className="page-copy">
          This replaces creator-chat.html with a dedicated backstage session. Keep quick operator
          commands, direct chat, subtitle nudges, and TTS dispatch inside the same web console.
        </p>
      </header>

      <section className="hero-panel">
        <div>
          <p className="eyebrow">Backstage Lane</p>
          <h3>Private commands without reviving the old manager UI.</h3>
          <p className="hero-copy">
            Use a dedicated creator session for readiness checks, manual directives, and short text
            pushes into subtitle or TTS. The runtime counts on the right give you the fast “am I
            safe to go live?” view.
          </p>
        </div>
        <div className="hero-metrics">
          <Metric label="Messages" value={String(messages.length)} accent />
          <Metric label="Jobs" value={String(overview?.job_count ?? 0)} />
          <Metric label="Profiles" value={String(overview?.user_profile_count ?? 0)} />
          <Metric label="Configs" value={String(overview?.config_artifact_count ?? 0)} />
        </div>
      </section>

      <div className="card-grid creator-grid">
        <article className="card emphasis">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Command Deck</p>
              <h3>Send backstage instructions</h3>
            </div>
            <button className="ghost" onClick={() => refresh()}>
              Refresh
            </button>
          </div>
          <div className="chip-row">
            {QUICK_COMMANDS.map((command) => (
              <button key={command} className="ghost chip" onClick={() => setDraft(command)}>
                {command}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Creator message</span>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <div className="actions">
            <button onClick={() => submitMessage(draft)}>Send backstage chat</button>
            <button
              className="ghost"
              onClick={async () => {
                await updateLive2dSubtitle({ text: draft, duration_ms: 3200 });
              }}
            >
              Push subtitle
            </button>
            <button
              className="ghost"
              onClick={async () => {
                await queueTts({ session_id: SESSION_ID, text: draft, voice: 'edge-tts-zh' });
              }}
            >
              Queue TTS
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
          <div className="stack-blocks">
            <JsonBlock title="Last response" value={lastResponse} empty="No backstage response yet." />
            <JsonBlock title="Runtime snapshot" value={overview} empty="No overview loaded yet." />
          </div>
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Transcript</p>
              <h3>Creator-only session history</h3>
            </div>
            <span className="status-pill">{messages.length} messages</span>
          </div>
          {messages.length ? (
            <div className="timeline">
              {messages.map((message) => (
                <article key={message.id} className={`timeline-item role-${message.role}`}>
                  <div className="timeline-meta">
                    <strong>{message.role}</strong>
                    <time>{new Date(message.created_at).toLocaleString()}</time>
                  </div>
                  <p>{message.text}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">No creator messages yet.</p>
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

function JsonBlock<T>({ title, value, empty }: { title: string; value: T | null; empty: string }) {
  return (
    <div className="json-block">
      <p className="eyebrow">{title}</p>
      <pre>{value ? JSON.stringify(value, null, 2) : empty}</pre>
    </div>
  );
}
