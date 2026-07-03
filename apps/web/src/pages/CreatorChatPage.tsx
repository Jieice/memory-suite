import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { JsonBlock } from '../components/JsonBlock';
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
      setError(nextError instanceof Error ? nextError.message : '创作者会话刷新失败。');
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
        <p className="eyebrow">创作者通道</p>
        <h2>统一运行时上的后台聊天</h2>
        <p className="page-copy">
          这里替代旧的 creator-chat.html，用专属后台会话承载快捷指令、直接聊天、字幕推送和 TTS 派发。
        </p>
      </header>

      <section className="hero-panel">
        <div>
          <p className="eyebrow">后台通道</p>
          <h3>不用旧管理界面，也能发送私有指令。</h3>
          <p className="hero-copy">
            用独立创作者会话做开播检查、人工指令、短文本字幕或 TTS 推送。右侧运行计数给你一个快速的开播状态视图。
          </p>
        </div>
        <div className="hero-metrics">
          <Metric label="消息" value={String(messages.length)} accent />
          <Metric label="任务" value={String(overview?.job_count ?? 0)} />
          <Metric label="档案" value={String(overview?.user_profile_count ?? 0)} />
          <Metric label="配置" value={String(overview?.config_artifact_count ?? 0)} />
        </div>
      </section>

      <div className="card-grid creator-grid">
        <article className="card emphasis">
          <div className="card-heading">
            <div>
              <p className="eyebrow">指令面板</p>
              <h3>发送后台指令</h3>
            </div>
            <button className="ghost" onClick={() => refresh()}>
              刷新
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
            <span>创作者消息</span>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <div className="actions">
            <button onClick={() => submitMessage(draft)}>发送后台聊天</button>
            <button
              className="ghost"
              onClick={async () => {
                await updateLive2dSubtitle({ text: draft, duration_ms: 3200 });
              }}
            >
              推送字幕
            </button>
            <button
              className="ghost"
              onClick={async () => {
                await queueTts({ session_id: SESSION_ID, text: draft, voice: 'edge-tts-zh' });
              }}
            >
              排队 TTS
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
          <div className="stack-blocks">
            <JsonBlock title="最近响应" value={lastResponse} empty="还没有后台响应。" />
            <JsonBlock title="运行快照" value={overview} empty="还没有加载运行概览。" />
          </div>
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">记录</p>
              <h3>仅创作者可见的会话历史</h3>
            </div>
            <span className="status-pill">{messages.length} 条消息</span>
          </div>
          {messages.length ? (
            <div className="timeline scroll-region">
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
            <p className="muted-copy">还没有创作者消息。</p>
          )}
        </article>

        {persona && (
          <article className="card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">人格导演</p>
                <h3>语气与模式快速切换</h3>
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
                      current_mood: persona.current_mood,
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
                      current_mood: persona.current_mood,
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
                      current_mood: persona.current_mood,
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
                      current_mood: persona.current_mood,
                    });
                    setPersona(next);
                  }}
                >
                  {seg}
                </button>
              ))}
            </div>
            <div className="chip-row">
              {['neutral', 'curious', 'amused', 'tired', 'focused'].map((m) => (
                <button
                  key={m}
                  className={`ghost chip${persona.current_mood === m ? ' active' : ''}`}
                  onClick={async () => {
                    const next = await updatePersonaConfig({
                      mode: persona.mode,
                      tone_profile: persona.tone_profile,
                      warmth: persona.warmth,
                      sarcasm: persona.sarcasm,
                      autonomy: persona.autonomy,
                      current_context: persona.current_context,
                      current_mood: m,
                    });
                    setPersona(next);
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
            <JsonBlock title="人格状态" value={persona} empty="" />
          </article>
        )}

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">场景导演</p>
              <h3>场景事件与上下文</h3>
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
            <span>场景上下文描述</span>
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
              设置场景上下文
            </button>
          </div>
          {sceneContext && (
            <p className="muted-copy" style={{ fontSize: '0.85em' }}>
              当前：{sceneContext.description.slice(0, 80)}{sceneContext.description.length > 80 ? '…' : ''}
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
              获取建议
            </button>
          </div>
          {sceneSuggestion && (
            <div className="stack-blocks">
              <div className="json-block">
                <p className="eyebrow">建议</p>
                <p style={{ padding: '0.5rem 0' }}>{sceneSuggestion}</p>
                <button onClick={() => { setDraft(sceneSuggestion); setSceneSuggestion(''); }}>作为消息使用</button>
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
