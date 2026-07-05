import { useCallback, useEffect, useState } from 'react';
import { JsonBlock } from '../components/JsonBlock';
import type {
  ChatResponse,
  DanmakuBootstrapRecord,
  HealthResponse,
  StoredMessage,
} from '../generated/api';
import {
  bootstrapDanmaku,
  cancelLive2dSpeech,
  fetchHealth,
  interruptSession,
  listSessionMessages,
  queueTts,
  sendChat,
} from '../lib';
import { loadUiPreferences, subscribeUiPreferences } from '../preferences';

const SESSION_ID = 'web-demo';

export function DashboardPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [danmakuBootstrap, setDanmakuBootstrap] = useState<DanmakuBootstrapRecord | null>(null);
  const [chat, setChat] = useState<ChatResponse | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [chatInput, setChatInput] = useState('快速检查一下当前统一运行时状态。');
  const [error, setError] = useState<string | null>(null);
  const [uiPreferences, setUiPreferences] = useState(loadUiPreferences);

  const refresh = useCallback(async () => {
    try {
      const [nextHealth, nextMessages] = await Promise.all([
        fetchHealth(),
        listSessionMessages(SESSION_ID).catch(() => []),
      ]);
      const nextDanmakuBootstrap = await bootstrapDanmaku().catch(() => null);
      setHealth(nextHealth);
      setDanmakuBootstrap(nextDanmakuBootstrap);
      setMessages(nextMessages.slice(-4));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '运行状态刷新失败。');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribeUiPreferences(setUiPreferences), []);

  const ready = health?.status === 'ok' && health?.db_ready;
  const bilibiliLive = danmakuBootstrap?.live_status === 1;
  const bilibiliRoomLabel =
    danmakuBootstrap?.resolved_room_id || danmakuBootstrap?.requested_room_id || '未配置';

  const interruptActiveTurn = useCallback(async () => {
    await Promise.allSettled([
      cancelLive2dSpeech({ reason: 'manual interrupt' }),
      interruptSession(SESSION_ID),
    ]);
  }, []);

  const submitChatTurn = useCallback(
    async (text: string, userId: string) => {
      const response = await sendChat({
        session_id: SESSION_ID,
        user_id: userId,
        text,
      });
      setChat(response);
      await refresh();
      return response;
    },
    [refresh],
  );

  return (
    <section className="page dashboard-page dashboard-page-minimal">
      <header className="page-header dashboard-header">
        <div>
          <p className="dashboard-kicker">总控台</p>
          <h2>只保留必要控制</h2>
          <p className="page-copy">
            总控台现在只做两件事：告诉你现在能不能运行，以及给你一块链路探针。
          </p>
        </div>
        <div className="dashboard-header-side">
          <span className={`dashboard-badge ${bilibiliLive ? 'ok' : 'down'}`}>
            B站房间 {bilibiliLive ? '直播中' : '未开播'}
          </span>
          <button className="ghost" onClick={() => void refresh()}>
            刷新状态
          </button>
        </div>
      </header>

      <section className="card emphasis dashboard-runtime-light">
        <div className={`dashboard-runtime-dot ${ready ? 'ok' : 'down'}`} />
        <div className="dashboard-runtime-copy">
          <h3>{ready ? '当前运行正常' : '当前未就绪'}</h3>
          <p className="muted-copy">
            {ready
              ? `健康检查已通过，数据库已就绪，运行模式：${health?.runtime_mode ?? 'unknown'}。${
                  danmakuBootstrap
                    ? ` B站房间 ${bilibiliRoomLabel} 当前${bilibiliLive ? '已开播' : '未开播'}。`
                    : ''
                }`
              : '只要这里不是绿灯，就先别管别的页面，先修运行状态。'}
          </p>
        </div>
        <div className="dashboard-runtime-meta">
          <StatusRow label="健康" value={health?.status ?? '加载中'} />
          <StatusRow label="数据库" value={health?.db_ready ? '就绪' : '未就绪'} />
          <StatusRow label="版本" value={health?.version ?? '...'} />
          <StatusRow label="房间号" value={bilibiliRoomLabel} />
          <StatusRow label="开播态" value={formatLiveStatus(danmakuBootstrap)} />
        </div>
      </section>

      <article className="card dashboard-panel dashboard-probe dashboard-probe-wide">
        <div className="dashboard-panel-head">
          <div>
            <h3>链路探针</h3>
            <p className="muted-copy">这里只验证文字聊天链路和 TTS 派发。</p>
          </div>
          <span className="dashboard-chip subtle">Session · {SESSION_ID}</span>
        </div>
        <label className="field">
          <span className="setting-label">操作员消息</span>
          <textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} />
        </label>
        <p className="muted-copy">
          Mic 聊天当前{uiPreferences.micChatEnabled ? '已开启' : '已关闭'}；触发入口已从总控台移除，
          这里只保留文字探针。
        </p>
        <div className="actions">
          <button
            onClick={async () => {
              try {
                setError(null);
                await interruptActiveTurn();
                await submitChatTurn(chatInput, 'operator');
              } catch (nextError) {
                setError(nextError instanceof Error ? nextError.message : '聊天发送失败。');
              }
            }}
          >
            发送聊天
          </button>
          <button
            className="ghost"
            onClick={async () => {
              try {
                setError(null);
                await queueTts({ session_id: SESSION_ID, text: chatInput, voice: 'edge-tts-zh' });
                await refresh();
              } catch (nextError) {
                setError(nextError instanceof Error ? nextError.message : 'TTS 派发失败。');
              }
            }}
          >
            派发 TTS
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div className="dashboard-probe-stack">
          <JsonBlock title="最近响应" value={chat} empty="还没有聊天响应。" />
          <JsonBlock title="会话记录" value={messages} empty="还没有会话消息。" />
        </div>
      </article>
    </section>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dashboard-status-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatLiveStatus(bootstrap: DanmakuBootstrapRecord | null) {
  if (!bootstrap) {
    return '读取失败';
  }
  switch (bootstrap.live_status) {
    case 1:
      return '直播中';
    case 0:
      return '未开播';
    default:
      return `未知(${bootstrap.live_status})`;
  }
}
