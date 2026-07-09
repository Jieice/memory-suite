import { useState } from 'react';
import type {
  DanmakuBootstrapRecord,
  DanmakuConnectionStateRecord,
  DanmakuNativeConnectResponse,
  DanmakuNativeProbeResponse,
  DanmakuSourceConfigRecord,
} from '../../generated/api';
import {
  bootstrapDanmaku,
  disconnectDanmaku,
  nativeConnectDanmakuOnce,
  nativeProbeDanmaku,
  startNativeDanmakuSession,
  updateDanmakuSource,
} from '../../lib';

type DanmakuSourcePanelProps = {
  roomId: string;
  uid: string;
  buvid: string;
  // cookie 输入框的值。空串表示「不修改」——后端出于安全不回传真实 SESSDATA，
  // 所以刷新后这里保持空，由 has_cookie 决定是否给「已保存凭证」的提示。
  cookie: string;
  signatureMode: string;
  hasCookie: boolean;
  danmakuSource: DanmakuSourceConfigRecord | null;
  danmakuState: DanmakuConnectionStateRecord | null;
  danmakuBootstrap: DanmakuBootstrapRecord | null;
  nativeProbe: DanmakuNativeProbeResponse | null;
  nativeConnect: DanmakuNativeConnectResponse | null;
  onRoomIdChange: (roomId: string) => void;
  onUidChange: (uid: string) => void;
  onBuvidChange: (buvid: string) => void;
  onCookieChange: (cookie: string) => void;
  onSignatureModeChange: (signatureMode: string) => void;
  onDanmakuBootstrapChange: (bootstrap: DanmakuBootstrapRecord) => void;
  onNativeProbeChange: (probe: DanmakuNativeProbeResponse) => void;
  onNativeConnectChange: (connect: DanmakuNativeConnectResponse) => void;
  onRefresh: () => void | Promise<void>;
};

export function DanmakuSourcePanel({
  roomId,
  uid,
  buvid,
  cookie,
  signatureMode,
  hasCookie,
  danmakuSource,
  danmakuState,
  danmakuBootstrap,
  nativeProbe,
  nativeConnect,
  onRoomIdChange,
  onUidChange,
  onBuvidChange,
  onCookieChange,
  onSignatureModeChange,
  onDanmakuBootstrapChange,
  onNativeProbeChange,
  onNativeConnectChange,
  onRefresh,
}: DanmakuSourcePanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(`${label}中…`);
    try {
      await task();
      setStatus(`${label}完成。`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : `${label}失败。`);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  // 保存来源：cookie 留空 = 不修改，发 null 让后端保留原值；
  // 只有用户真的在框里输入了内容，才把它当新 cookie 提交。
  const saveSource = () =>
    run('保存来源', async () => {
      const parsedUid = Number.parseInt(uid, 10);
      const trimmedCookie = cookie.trim();
      await updateDanmakuSource({
        room_id: roomId,
        uid: Number.isNaN(parsedUid) ? 0 : parsedUid,
        buvid,
        cookie: trimmedCookie ? cookie : null,
        signature_mode: signatureMode,
      });
      await onRefresh();
    });

  const bootstrap = () =>
    run('初始化房间', async () => {
      onDanmakuBootstrapChange(await bootstrapDanmaku());
      await onRefresh();
    });

  const probe = () =>
    run('原生探测', async () => {
      onNativeProbeChange(await nativeProbeDanmaku());
      await onRefresh();
    });

  const connectOnce = () =>
    run('原生连接一次', async () => {
      onNativeConnectChange(await nativeConnectDanmakuOnce());
      await onRefresh();
    });

  const startSession = () =>
    run('启动原生会话', async () => {
      await startNativeDanmakuSession();
      await onRefresh();
    });

  const disconnect = () =>
    run('断开当前会话', async () => {
      await disconnectDanmaku();
      await onRefresh();
    });

  const configured =
    Boolean(danmakuSource?.room_id?.trim()) &&
    Boolean(danmakuSource?.buvid?.trim()) &&
    danmakuSource?.has_cookie;

  return (
    <article className="card runtime-column">
      <p className="eyebrow">弹幕源</p>
      <h3>真实上游控制面</h3>
      <label className="field">
        <span>房间 ID</span>
        <input value={roomId} onChange={(event) => onRoomIdChange(event.target.value)} />
      </label>
      <label className="field">
        <span>UID</span>
        <input value={uid} onChange={(event) => onUidChange(event.target.value)} />
      </label>
      <label className="field">
        <span>Buvid</span>
        <input value={buvid} onChange={(event) => onBuvidChange(event.target.value)} />
      </label>
      <label className="field">
        <span>Cookie</span>
        <input
          value={cookie}
          onChange={(event) => onCookieChange(event.target.value)}
          placeholder={hasCookie ? '已保存凭证，留空则不修改' : '粘贴 SESSDATA=... 后保存'}
        />
        <small className="muted-copy">
          {hasCookie
            ? '后端已保存凭证（出于安全不回传）。留空保存即保留原值。'
            : '尚未保存任何凭证。'}
        </small>
      </label>
      <label className="field">
        <span>签名模式</span>
        <select value={signatureMode} onChange={(event) => onSignatureModeChange(event.target.value)}>
          <option value="cookie">cookie</option>
          <option value="anonymous">anonymous</option>
          <option value="stored">stored</option>
        </select>
      </label>
      <div className="settings-runtime-stats">
        <span className={`status-pill ${configured ? 'status-running' : 'status-queued'}`}>
          {configured ? '配置完整' : '配置不全'}
        </span>
        <span className={`status-pill ${danmakuState?.status === 'connected' ? 'status-running' : 'status-down'}`}>
          {danmakuState?.status ?? '未连接'}
        </span>
        {danmakuState?.current_upstream_host ? (
          <span className="muted-copy">{danmakuState.current_upstream_host}</span>
        ) : null}
      </div>
      <div className="actions">
        <button disabled={busy} onClick={() => void saveSource()}>
          保存来源
        </button>
        <button className="ghost" disabled={busy} onClick={() => void bootstrap()}>
          初始化房间
        </button>
        <button className="ghost" disabled={busy} onClick={() => void probe()}>
          原生探测
        </button>
        <button className="ghost" disabled={busy} onClick={() => void connectOnce()}>
          原生连接一次
        </button>
        <button className="ghost" disabled={busy} onClick={() => void startSession()}>
          启动原生会话
        </button>
        <button className="ghost" disabled={busy} onClick={() => void disconnect()}>
          断开当前会话
        </button>
      </div>
      {status ? <p className="muted-copy">{status}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {danmakuState?.last_error ? (
        <p className="error">后端报错：{danmakuState.last_error}</p>
      ) : null}
    </article>
  );
}
