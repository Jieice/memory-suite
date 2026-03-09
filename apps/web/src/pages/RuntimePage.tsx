import { startTransition, useEffect, useEffectEvent, useState } from 'react';
import type {
  AdapterRecord,
  DanmakuBootstrapRecord,
  DanmakuNativeConnectResponse,
  DanmakuConnectionStateRecord,
  DanmakuNativeProbeResponse,
  DanmakuProtocolEventType,
  DanmakuSourceConfigRecord,
  Live2dStateRecord,
  RuntimeEvent,
  RuntimeOverview,
} from '../generated/api';
import {
  bootstrapDanmaku,
  closeDanmakuSession,
  connectDanmaku,
  disconnectDanmaku,
  fetchDanmakuSource,
  fetchDanmakuState,
  fetchRuntimeOverview,
  fetchLive2dState,
  injectDanmaku,
  listAdapters,
  nativeConnectDanmakuOnce,
  nativeProbeDanmaku,
  openDanmakuSession,
  openRuntimeStream,
  sendDanmakuProtocolEvent,
  reportDanmakuSessionError,
  reportDanmakuDisconnect,
  sendDanmakuHeartbeat,
  startNativeDanmakuSession,
  startAdapter,
  updateDanmakuSource,
  updateLive2dConfig,
  updateLive2dEmotion,
  updateLive2dSubtitle,
} from '../lib';

export function RuntimePage() {
  const [overview, setOverview] = useState<RuntimeOverview | null>(null);
  const [adapters, setAdapters] = useState<AdapterRecord[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [live2d, setLive2d] = useState<Live2dStateRecord | null>(null);
  const [danmakuBootstrap, setDanmakuBootstrap] = useState<DanmakuBootstrapRecord | null>(null);
  const [nativeConnect, setNativeConnect] = useState<DanmakuNativeConnectResponse | null>(null);
  const [nativeProbe, setNativeProbe] = useState<DanmakuNativeProbeResponse | null>(null);
  const [danmakuSource, setDanmakuSource] = useState<DanmakuSourceConfigRecord | null>(null);
  const [danmakuState, setDanmakuState] = useState<DanmakuConnectionStateRecord | null>(null);
  const [roomId, setRoomId] = useState('556677');
  const [uid, setUid] = useState('1024');
  const [buvid, setBuvid] = useState('memory-suite-buvid');
  const [cookie, setCookie] = useState('SESSDATA=redacted;');
  const [signatureMode, setSignatureMode] = useState('cookie');
  const [connectionMode, setConnectionMode] = useState('native_websocket');
  const [sessionId, setSessionId] = useState('helper-session-1');
  const [sessionReason, setSessionReason] = useState('helper close');
  const [protocolEventType, setProtocolEventType] = useState<DanmakuProtocolEventType>('danmaku');
  const [protocolUsername, setProtocolUsername] = useState('helper-user');
  const [protocolMessage, setProtocolMessage] = useState('raw helper event');
  const [protocolCount, setProtocolCount] = useState('1');
  const [subtitleText, setSubtitleText] = useState('Overlay sync check');
  const [emotion, setEmotion] = useState('happy');
  const [modelScale, setModelScale] = useState('0.25');
  const [modelX, setModelX] = useState('0.30');
  const [modelY, setModelY] = useState('0.50');
  const [danmakuText, setDanmakuText] = useState('hello from runtime console');
  const [error, setError] = useState<string | null>(null);

  const refresh = useEffectEvent(async () => {
    try {
      const [nextOverview, nextAdapters] = await Promise.all([
        fetchRuntimeOverview(),
        listAdapters(),
      ]);
      setOverview(nextOverview);
      setAdapters(nextAdapters);
      const [nextLive2d, nextDanmakuSource, nextDanmakuState] = await Promise.all([
        fetchLive2dState(),
        fetchDanmakuSource(),
        fetchDanmakuState(),
      ]);
      setLive2d(nextLive2d);
      setDanmakuSource(nextDanmakuSource);
      setDanmakuState(nextDanmakuState);
      setRoomId(nextDanmakuSource.room_id || '556677');
      setUid(String(nextDanmakuSource.uid || 0));
      setBuvid(nextDanmakuSource.buvid || 'memory-suite-buvid');
      setCookie(nextDanmakuSource.has_cookie ? 'SESSDATA=stored;' : '');
      setSignatureMode(nextDanmakuSource.signature_mode || 'cookie');
      setConnectionMode(nextDanmakuSource.connection_mode || 'native_websocket');
      setModelScale(String(nextLive2d.config.scale ?? 0.25));
      setModelX(String(nextLive2d.config.x ?? 0.3));
      setModelY(String(nextLive2d.config.y ?? 0.5));
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
          This is the live runtime surface: adapter supervision, event feed, and runtime counts in
          one place.
        </p>
      </header>

      <section className="runtime-stage">
        <article className="card runtime-hero">
          <div className="runtime-hero-copy">
            <p className="eyebrow">Operations Room</p>
            <h3>Observe the daemon the same way you will operate it after cutover.</h3>
            <p className="muted-copy">
              Web UI, jobs, adapters, and live runtime controls now orbit one HTTP entrypoint and
              one SQLite-backed runtime.
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
            <p className="eyebrow">Danmaku Source</p>
            <h3>Real upstream control plane</h3>
            <label className="field">
              <span>Room ID</span>
              <input value={roomId} onChange={(event) => setRoomId(event.target.value)} />
            </label>
            <label className="field">
              <span>UID</span>
              <input value={uid} onChange={(event) => setUid(event.target.value)} />
            </label>
            <label className="field">
              <span>Buvid</span>
              <input value={buvid} onChange={(event) => setBuvid(event.target.value)} />
            </label>
            <label className="field">
              <span>Cookie</span>
              <input value={cookie} onChange={(event) => setCookie(event.target.value)} />
            </label>
            <label className="field">
              <span>Signature mode</span>
              <input
                value={signatureMode}
                onChange={(event) => setSignatureMode(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Connection mode</span>
              <input
                value={connectionMode}
                onChange={(event) => setConnectionMode(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Session ID</span>
              <input value={sessionId} onChange={(event) => setSessionId(event.target.value)} />
            </label>
            <label className="field">
              <span>Session reason</span>
              <input
                value={sessionReason}
                onChange={(event) => setSessionReason(event.target.value)}
              />
            </label>
            <div className="actions">
              <button
                onClick={async () => {
                  const parsedUid = Number.parseInt(uid, 10);
                  await updateDanmakuSource({
                    room_id: roomId,
                    uid: Number.isNaN(parsedUid) ? 0 : parsedUid,
                    buvid,
                    cookie: cookie.trim() ? cookie : null,
                    signature_mode: signatureMode,
                    connection_mode: connectionMode,
                  });
                  await refresh();
                }}
              >
                Save source
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  setDanmakuBootstrap(await bootstrapDanmaku());
                  await refresh();
                }}
              >
                Bootstrap room
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  setNativeProbe(await nativeProbeDanmaku());
                  await refresh();
                }}
              >
                Native probe
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  const result = await nativeConnectDanmakuOnce();
                  setNativeConnect(result);
                  setSessionId(result.session_id);
                  await refresh();
                }}
              >
                Native connect once
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  const result = await startNativeDanmakuSession();
                  setSessionId(result.state.session_id ?? sessionId);
                  await refresh();
                }}
              >
                Start native session
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await connectDanmaku();
                  await refresh();
                }}
              >
                Connect
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await disconnectDanmaku();
                  await refresh();
                }}
              >
                Disconnect
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await sendDanmakuHeartbeat({
                    upstream_host: danmakuState?.current_upstream_host ?? 'runtime-heartbeat',
                  });
                  await refresh();
                }}
              >
                Mark heartbeat
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await reportDanmakuDisconnect({ reason: 'runtime console drop simulation' });
                  await refresh();
                }}
              >
                Report drop
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await openDanmakuSession({
                    session_id: sessionId,
                    upstream_host: danmakuState?.current_upstream_host ?? 'runtime-session',
                  });
                  await refresh();
                }}
              >
                Session open
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await reportDanmakuSessionError({
                    session_id: sessionId,
                    reason: sessionReason,
                  });
                  await refresh();
                }}
              >
                Session error
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await closeDanmakuSession({
                    session_id: sessionId,
                    reason: sessionReason,
                  });
                  await refresh();
                }}
              >
                Session close
              </button>
            </div>
            <pre>
              {JSON.stringify(
                {
                  configured:
                    Boolean(danmakuSource?.room_id?.trim()) &&
                    Boolean(danmakuSource?.buvid?.trim()) &&
                    danmakuSource?.has_cookie,
                  source: danmakuSource,
                  state: danmakuState,
                  bootstrap: danmakuBootstrap,
                  nativeProbe,
                  nativeConnect,
                },
                null,
                2,
              )}
            </pre>
          </article>

          <article className="card runtime-column">
            <p className="eyebrow">Protocol Event</p>
            <h3>Decoded helper event to Rust semantic path</h3>
            <label className="field">
              <span>Type</span>
              <input
                value={protocolEventType}
                onChange={(event) => setProtocolEventType(event.target.value as DanmakuProtocolEventType)}
              />
            </label>
            <label className="field">
              <span>Username</span>
              <input
                value={protocolUsername}
                onChange={(event) => setProtocolUsername(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Message</span>
              <input
                value={protocolMessage}
                onChange={(event) => setProtocolMessage(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Count</span>
              <input
                value={protocolCount}
                onChange={(event) => setProtocolCount(event.target.value)}
              />
            </label>
            <div className="actions">
              <button
                onClick={async () => {
                  const parsedCount = Number.parseInt(protocolCount, 10);
                  await sendDanmakuProtocolEvent({
                    session_id: 'runtime-room',
                    event_type: protocolEventType,
                    username: protocolUsername,
                    message: protocolMessage,
                    count: Number.isNaN(parsedCount) ? null : parsedCount,
                  });
                  await refresh();
                }}
              >
                Send protocol event
              </button>
            </div>
          </article>

          <article className="card runtime-column">
            <p className="eyebrow">Live2D State</p>
            <h3>Model, subtitle, and emotion controls</h3>
            <label className="field">
              <span>Subtitle</span>
              <input value={subtitleText} onChange={(event) => setSubtitleText(event.target.value)} />
            </label>
            <label className="field">
              <span>Emotion</span>
              <input value={emotion} onChange={(event) => setEmotion(event.target.value)} />
            </label>
            <label className="field">
              <span>Scale</span>
              <input value={modelScale} onChange={(event) => setModelScale(event.target.value)} />
            </label>
            <label className="field">
              <span>X</span>
              <input value={modelX} onChange={(event) => setModelX(event.target.value)} />
            </label>
            <label className="field">
              <span>Y</span>
              <input value={modelY} onChange={(event) => setModelY(event.target.value)} />
            </label>
            <div className="actions">
              <button
                onClick={async () => {
                  await updateLive2dSubtitle({ text: subtitleText, duration_ms: 2200 });
                  setLive2d(await fetchLive2dState());
                }}
              >
                Push subtitle
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await updateLive2dEmotion({ emotion });
                  setLive2d(await fetchLive2dState());
                }}
              >
                Push emotion
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await updateLive2dConfig({
                    scale: Number.parseFloat(modelScale) || 0.25,
                    x: Number.parseFloat(modelX) || 0.3,
                    y: Number.parseFloat(modelY) || 0.5,
                  });
                  setLive2d(await fetchLive2dState());
                }}
              >
                Push config
              </button>
            </div>
            <pre>{live2d ? JSON.stringify(live2d, null, 2) : 'No live2d state loaded yet.'}</pre>
          </article>

          <article className="card runtime-column">
            <p className="eyebrow">Danmaku Injection</p>
            <h3>Test gateway ingress without legacy bridge</h3>
            <label className="field">
              <span>Message</span>
              <input value={danmakuText} onChange={(event) => setDanmakuText(event.target.value)} />
            </label>
            <div className="actions">
              <button
                onClick={async () => {
                  await injectDanmaku({
                    session_id: 'runtime-room',
                    user_id: 'operator',
                    text: danmakuText,
                  });
                  await refresh();
                }}
              >
                Inject danmaku
              </button>
            </div>
          </article>

          <article className="card runtime-column">
            <p className="eyebrow">Storage Footprint</p>
            <h3>Current unified database counts</h3>
            <dl className="definition-grid">
              <Stat label="Messages" value={String(overview?.message_count ?? 0)} />
              <Stat label="Jobs" value={String(overview?.job_count ?? 0)} />
              <Stat label="Profiles" value={String(overview?.user_profile_count ?? 0)} />
              <Stat label="Memories" value={String(overview?.memory_entry_count ?? 0)} />
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
