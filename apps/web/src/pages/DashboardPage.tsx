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
  fetchHealth,
  listSessionMessages,
  queueTts,
  sendChat,
} from '../lib';
import type { RuntimeStreamStatus } from '../lib';
import type { VoiceSessionState } from '../voice/sessionState';
import { useVoiceRuntime, VOICE_SESSION_ID } from '../voice/VoiceRuntimeProvider';

export function DashboardPage() {
  const voiceRuntime = useVoiceRuntime();
  const sessionId = voiceRuntime.sessionId;
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [danmakuBootstrap, setDanmakuBootstrap] = useState<DanmakuBootstrapRecord | null>(null);
  const [chat, setChat] = useState<ChatResponse | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [chatInput, setChatInput] = useState('快速检查一下当前统一运行时状态。');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextHealth, nextMessages] = await Promise.all([
        fetchHealth(),
        listSessionMessages(sessionId).catch(() => []),
      ]);
      setHealth(nextHealth);
      setMessages(nextMessages.slice(-4));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '运行状态刷新失败。');
    }
  }, [sessionId]);

  // bootstrapDanmaku 偏重（要解析房间号拉 B 站 upstream），只在初始化和手动刷新时调，
  // 不跟常规 refresh 绑定，避免每轮聊天/TTS 派发都触发。
  const refreshBootstrap = useCallback(async () => {
    const nextDanmakuBootstrap = await bootstrapDanmaku().catch(() => null);
    setDanmakuBootstrap(nextDanmakuBootstrap);
    return nextDanmakuBootstrap;
  }, []);

  const manualRefresh = useCallback(async () => {
    await Promise.allSettled([refresh(), refreshBootstrap()]);
  }, [refresh, refreshBootstrap]);

  useEffect(() => {
    void refresh();
    void refreshBootstrap();
  }, [refresh, refreshBootstrap]);

  useEffect(() => {
    if (voiceRuntime.lastVoiceChat) {
      setChat(voiceRuntime.lastVoiceChat);
      void refresh();
    }
  }, [refresh, voiceRuntime.lastVoiceChat]);

  const ready = health?.status === 'ok' && health?.db_ready;
  const bilibiliLive = danmakuBootstrap?.live_status === 1;
  const bilibiliRoomLabel =
    danmakuBootstrap?.resolved_room_id || danmakuBootstrap?.requested_room_id || '未配置';

  const submitChatTurn = useCallback(
    async (text: string, userId: string) => {
      const response = await sendChat({
        session_id: sessionId,
        user_id: userId,
        text,
      });
      setChat(response);
      await refresh();
      return response;
    },
    [refresh, sessionId],
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
          <span
            className={`dashboard-badge ${voiceRuntime.runtimeStreamStatus === 'connected' ? 'ok' : voiceRuntime.runtimeStreamStatus === 'reconnecting' ? 'warn' : 'down'}`}
            title={`事件流：${runtimeStreamLabel(voiceRuntime.runtimeStreamStatus)}`}
          >
            事件流 {runtimeStreamLabel(voiceRuntime.runtimeStreamStatus)}
          </span>
          <button className="ghost" onClick={() => void manualRefresh()}>
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
          <span className="dashboard-chip subtle">Session · {VOICE_SESSION_ID}</span>
        </div>
        <VoiceLoopPanel
          enabled={voiceRuntime.enabled}
          state={voiceRuntime.snapshot.state}
          partialTranscript={voiceRuntime.snapshot.partialTranscript}
          finalTranscript={voiceRuntime.snapshot.finalTranscript}
          engineReady={voiceRuntime.engineReady}
          engineError={voiceRuntime.engineError}
        />
        <label className="field">
          <span className="setting-label">操作员消息</span>
          <textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} />
        </label>
        <p className="muted-copy">
          常开语音直播模式当前{voiceRuntime.enabled ? '已开启' : '已关闭'}
          （在配置中心切换）；下面的文字探针任何时候都可用。
        </p>
        <div className="actions">
          <button
            onClick={async () => {
              try {
                setError(null);
                await voiceRuntime.interruptActiveTurn();
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
                await queueTts({ session_id: sessionId, text: chatInput, voice: 'edge-tts-zh' });
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

const voiceStateLabels: Record<VoiceSessionState, string> = {
  idle: '待机',
  arming: '启动中',
  listening: '监听中',
  speech_detected: '正在听你说',
  finalizing_asr: '识别中',
  thinking: '思考中',
  speaking: '说话中',
  interrupted: '已打断',
  failed: '出错',
  cooldown: '冷却中',
};

// 哪些状态算“正在活跃地跑一轮”，用来给指示灯上色。
const voiceActiveStates = new Set<VoiceSessionState>([
  'speech_detected',
  'finalizing_asr',
  'thinking',
  'speaking',
]);

function VoiceLoopPanel({
  enabled,
  state,
  partialTranscript,
  finalTranscript,
  engineReady,
  engineError,
}: {
  enabled: boolean;
  state: VoiceSessionState;
  partialTranscript: string;
  finalTranscript: string;
  engineReady: boolean;
  engineError: string | null;
}) {
  if (!enabled) {
    return (
      <div className="voice-loop-panel voice-loop-off">
        <span className="voice-loop-dot off" />
        <div className="voice-loop-copy">
          <strong>常开语音已关闭</strong>
          <small className="muted-copy">在配置中心 → 外观设置里开启后，角色会自动听并回答。</small>
        </div>
      </div>
    );
  }

  const active = voiceActiveStates.has(state);
  const dotClass = engineError ? 'error' : active ? 'active' : engineReady ? 'ready' : 'warming';
  const transcript = partialTranscript || finalTranscript;

  return (
    <div className="voice-loop-panel">
      <span className={`voice-loop-dot ${dotClass}`} />
      <div className="voice-loop-copy">
        <div className="voice-loop-head">
          <strong>常开语音 · {voiceStateLabels[state]}</strong>
          <span className="voice-loop-sub muted-copy">
            {engineError
              ? engineError
              : engineReady
                ? '麦克风常驻监听，检测到你说话会自动识别并回答。'
                : '正在加载语音引擎（首次会载入本地模型）…'}
          </span>
        </div>
        {transcript ? (
          <p className="voice-loop-transcript">“{transcript}”</p>
        ) : (
          <p className="voice-loop-transcript muted-copy">（还没听到内容）</p>
        )}
      </div>
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

function runtimeStreamLabel(status: RuntimeStreamStatus): string {
  switch (status) {
    case 'connected':
      return '已连接';
    case 'reconnecting':
      return '重连中';
    case 'disconnected':
      return '已断开';
  }
}
