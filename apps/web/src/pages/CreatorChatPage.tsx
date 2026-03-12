import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ChatResponse, PersonaRuntimeStateRecord, RuntimeOverview, SceneContextRecord, StoredMessage } from '../generated/api';
import { fetchPersonaState, fetchRuntimeOverview, fetchSceneContext, fetchSceneSuggestion, listSessionMessages, queueTts, sendChat, sendSceneEvent, setSceneContext, updateLive2dSubtitle, updatePersonaConfig } from '../lib';

const SESSION_ID = 'creator-backstage';
const QUICK_COMMANDS = ['/status', '/readiness', '/go', '/selfcheck', '/eval chat', '/train'];

export function CreatorChatPage() {
  const [overview, setOverview] = useState<RuntimeOverview | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [draft, setDraft] = useState('/status');
  const [lastResponse, setLastResponse] = useState<ChatResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [persona, setPersona] = useState<PersonaRuntimeStateRecord | null>(null);
  const [sceneContext, updateSceneContextState] = useState<SceneContextRecord | null>(null);
  const [sceneDraft, setSceneDraft] = useState('');
  const [sceneSuggestion, setSceneSuggestion] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const refresh = useEffectEvent(async () => {
    try {
      const [nextOverview, nextMessages, nextPersona, nextSceneCtx] = await Promise.all([
        fetchRuntimeOverview(),
        listSessionMessages(SESSION_ID),
        fetchPersonaState().catch(() => null),
        fetchSceneContext().catch(() => null),
      ]);
      setOverview(nextOverview);
      setMessages(nextMessages);
      setPersona(nextPersona);
      updateSceneContextState(nextSceneCtx);
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
    if (response.speech.status === 'ready' && response.speech.audio_url) {
      try {
        audioRef.current?.pause();
        const audio = new Audio(response.speech.audio_url);
        audioRef.current = audio;
        await audio.play();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : '自动播放语音失败。');
      }
    }
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

        {persona && (
          <article className="card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Persona Director</p>
                <h3>Tone &amp; mode quick-switch</h3>
              </div>
            </div>
            <div className="chip-row">
              {['stream', 'chat', 'idle'].map((mode) => (
                <button
                  key={mode}
                  className={`ghost chip${persona.mode === mode ? ' active' : ''}`}
                  onClick={async () => {
                    const next = await updatePersonaConfig({
                      mode,
                      tone_profile: persona.tone_profile,
                      warmth: persona.warmth,
                      sarcasm: persona.sarcasm,
                      autonomy: persona.autonomy,
                      current_context: persona.current_context,
                    });
                    setPersona(next);
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>
            <div className="chip-row">
              {['balanced', 'sharp-playful', 'gentle', 'cold'].map((tone) => (
                <button
                  key={tone}
                  className={`ghost chip${persona.tone_profile === tone ? ' active' : ''}`}
                  onClick={async () => {
                    const next = await updatePersonaConfig({
                      mode: persona.mode,
                      tone_profile: tone,
                      warmth: persona.warmth,
                      sarcasm: persona.sarcasm,
                      autonomy: persona.autonomy,
                      current_context: persona.current_context,
                    });
                    setPersona(next);
                  }}
                >
                  {tone}
                </button>
              ))}
            </div>
            <div className="chip-row">
              {['idle', 'opening', 'warmup', 'highlight', 'transition', 'closing'].map((ctx) => (
                <button
                  key={ctx}
                  className={`ghost chip${persona.current_context === ctx ? ' active' : ''}`}
                  onClick={async () => {
                    const next = await updatePersonaConfig({
                      mode: persona.mode,
                      tone_profile: persona.tone_profile,
                      warmth: persona.warmth,
                      sarcasm: persona.sarcasm,
                      autonomy: persona.autonomy,
                      current_context: ctx,
                    });
                    setPersona(next);
                  }}
                >
                  {ctx}
                </button>
              ))}
            </div>
            <div className="chip-row">
              {['tech_talk', 'casual_chat', 'quiz', 'roast'].map((seg) => (
                <button
                  key={seg}
                  className={`ghost chip${persona.current_context === seg ? ' active' : ''}`}
                  onClick={async () => {
                    const next = await updatePersonaConfig({
                      mode: persona.mode,
                      tone_profile: persona.tone_profile,
                      warmth: persona.warmth,
                      sarcasm: persona.sarcasm,
                      autonomy: persona.autonomy,
                      current_context: seg,
                    });
                    setPersona(next);
                  }}
                >
                  {seg}
                </button>
              ))}
            </div>
            <JsonBlock title="Persona state" value={persona} empty="" />
          </article>
        )}

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Scene Director</p>
              <h3>Scene events &amp; context</h3>
            </div>
          </div>
          <div className="chip-row">
            {['game_started', 'boss_fight', 'achievement', 'level_up', 'game_paused', 'error_occurred'].map((kind) => (
              <button
                key={kind}
                className="ghost chip"
                onClick={async () => {
                  await sendSceneEvent(kind);
                }}
              >
                {kind}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Scene context description</span>
            <textarea
              value={sceneDraft}
              onChange={(e) => setSceneDraft(e.target.value)}
              placeholder="e.g. 正在玩一个roguelike游戏，当前在第三层地牢..."
            />
          </label>
          <div className="actions">
            <button
              onClick={async () => {
                if (!sceneDraft.trim()) return;
                const ctx = await setSceneContext(sceneDraft);
                updateSceneContextState(ctx);
                setSceneDraft('');
              }}
            >
              Set scene context
            </button>
          </div>
          {sceneContext && (
            <p className="muted-copy" style={{ fontSize: '0.85em' }}>
              Active: {sceneContext.description.slice(0, 80)}{sceneContext.description.length > 80 ? '…' : ''}
            </p>
          )}
          <div className="actions">
            <button
              className="ghost"
              onClick={async () => {
                const s = await fetchSceneSuggestion();
                setSceneSuggestion(s.suggestion);
              }}
            >
              Get suggestion
            </button>
          </div>
          {sceneSuggestion && (
            <div className="stack-blocks">
              <div className="json-block">
                <p className="eyebrow">Suggestion</p>
                <p style={{ padding: '0.5rem 0' }}>{sceneSuggestion}</p>
                <button onClick={() => { setDraft(sceneSuggestion); setSceneSuggestion(''); }}>Use as message</button>
              </div>
            </div>
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
