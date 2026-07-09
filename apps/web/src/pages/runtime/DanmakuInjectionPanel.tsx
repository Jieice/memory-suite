import { useState } from 'react';
import { injectDanmaku } from '../../lib';

type DanmakuInjectionPanelProps = {
  danmakuText: string;
  onDanmakuTextChange: (text: string) => void;
  onRefresh: () => void | Promise<void>;
};

export function DanmakuInjectionPanel({
  danmakuText,
  onDanmakuTextChange,
  onRefresh,
}: DanmakuInjectionPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const inject = async () => {
    if (!danmakuText.trim()) {
      setError('消息不能为空。');
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await injectDanmaku({
        session_id: 'runtime-room',
        user_id: 'operator',
        text: danmakuText,
      });
      setStatus('已注入。');
      await onRefresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '注入失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card runtime-column">
      <p className="eyebrow">弹幕注入</p>
      <h3>不经过旧桥接，直接测试网关入口</h3>
      <label className="field">
        <span>消息</span>
        <input value={danmakuText} onChange={(event) => onDanmakuTextChange(event.target.value)} />
      </label>
      <div className="actions">
        <button disabled={busy} onClick={() => void inject()}>
          注入弹幕
        </button>
      </div>
      {status ? <p className="muted-copy">{status}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </article>
  );
}
