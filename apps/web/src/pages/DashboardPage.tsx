import { useEffect, useEffectEvent, useState } from 'react';
import { JsonBlock } from '../components/JsonBlock';
import type { ChatResponse, HealthResponse, RuntimeOverview, StoredMessage } from '../generated/api';
import { fetchHealth, fetchRuntimeOverview, listSessionMessages, queueTts, sendChat } from '../lib';

const SESSION_ID = 'web-demo';

export function DashboardPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [overview, setOverview] = useState<RuntimeOverview | null>(null);
  const [chat, setChat] = useState<ChatResponse | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [chatInput, setChatInput] = useState('快速检查一下当前统一运行时状态。');
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
      setError(nextError instanceof Error ? nextError.message : '运行时刷新失败。');
    }
  });

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">总控台</p>
        <h2>桌面端运行控制台</h2>
        <p className="page-copy">
          Rust 后端现在是系统主干。这里用于快速查看健康状态、消息数量，并直接向统一聊天链路发起探针。
        </p>
      </header>

      <section className="hero-panel">
        <div>
          <p className="eyebrow">运行态势</p>
          <h3>一个入口，一个数据库，一个控制平面。</h3>
          <p className="hero-copy">
            聊天入口、运行计数、适配器监管和会话持久化都收束到同一个后端边界内。
          </p>
        </div>
        <div className="hero-metrics">
          <Metric label="健康" value={health?.status ?? '加载中'} accent />
          <Metric label="消息" value={String(overview?.message_count ?? 0)} />
          <Metric label="任务" value={String(overview?.job_count ?? 0)} />
          <Metric label="档案" value={String(overview?.user_profile_count ?? 0)} />
        </div>
      </section>

      <div className="card-grid runtime-grid">
        <article className="card emphasis">
          <div className="card-heading">
            <div>
              <p className="eyebrow">实时快照</p>
              <h3>健康状态与存储占用</h3>
            </div>
            <button className="ghost" onClick={() => refresh()}>
              刷新
            </button>
          </div>
          <dl className="definition-grid">
            <Stat label="版本" value={health?.version ?? '...'} />
            <Stat label="模式" value={health?.runtime_mode ?? '...'} />
            <Stat label="数据库" value={health?.db_ready ? '就绪' : '检查中'} />
            <Stat label="记忆" value={String(overview?.memory_entry_count ?? 0)} />
            <Stat label="配置" value={String(overview?.config_artifact_count ?? 0)} />
          </dl>
          {error ? <p className="error">{error}</p> : null}
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">聊天探针</p>
              <h3>验证统一 API 链路</h3>
            </div>
          </div>
          <label className="field">
            <span>操作员消息</span>
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
              发送聊天
            </button>
            <button
              className="ghost"
              onClick={async () => {
                await queueTts({ session_id: SESSION_ID, text: chatInput, voice: 'edge-tts-zh' });
                await refresh();
              }}
            >
              派发 TTS
            </button>
          </div>
          <div className="stack-blocks">
            <JsonBlock title="最近响应" value={chat} empty="还没有聊天响应。" />
            <JsonBlock title="会话记录" value={messages} empty="还没有会话消息。" />
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
