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
  return (
    <article className="card runtime-column">
      <p className="eyebrow">弹幕注入</p>
      <h3>不经过旧桥接，直接测试网关入口</h3>
      <label className="field">
        <span>消息</span>
        <input value={danmakuText} onChange={(event) => onDanmakuTextChange(event.target.value)} />
      </label>
      <div className="actions">
        <button
          onClick={async () => {
            await injectDanmaku({
              session_id: 'runtime-room',
              user_id: 'operator',
              text: danmakuText,
            });
            await onRefresh();
          }}
        >
          注入弹幕
        </button>
      </div>
    </article>
  );
}