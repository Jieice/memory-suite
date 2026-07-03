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
  cookie: string;
  signatureMode: string;
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
        <input value={cookie} onChange={(event) => onCookieChange(event.target.value)} />
      </label>
      <label className="field">
        <span>签名模式</span>
        <input
          value={signatureMode}
          onChange={(event) => onSignatureModeChange(event.target.value)}
        />
      </label>
      <label className="field">
        <span>当前会话</span>
        <input value={danmakuState?.session_id ?? nativeConnect?.session_id ?? '未建立'} readOnly />
      </label>
      <label className="field">
        <span>当前上游</span>
        <input value={danmakuState?.current_upstream_host ?? nativeConnect?.host ?? '未连接'} readOnly />
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
            });
            await onRefresh();
          }}
        >
          保存来源
        </button>
        <button
          className="ghost"
          onClick={async () => {
            onDanmakuBootstrapChange(await bootstrapDanmaku());
            await onRefresh();
          }}
        >
          初始化房间
        </button>
        <button
          className="ghost"
          onClick={async () => {
            onNativeProbeChange(await nativeProbeDanmaku());
            await onRefresh();
          }}
        >
          原生探测
        </button>
        <button
          className="ghost"
          onClick={async () => {
            const result = await nativeConnectDanmakuOnce();
            onNativeConnectChange(result);
            await onRefresh();
          }}
        >
          原生连接一次
        </button>
        <button
          className="ghost"
          onClick={async () => {
            await startNativeDanmakuSession();
            await onRefresh();
          }}
        >
          启动原生会话
        </button>
        <button
          className="ghost"
          onClick={async () => {
            await disconnectDanmaku();
            await onRefresh();
          }}
        >
          断开当前会话
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
  );
}
