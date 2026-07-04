import type { AdapterRecord } from '../../generated/api';
import { startAdapter } from '../../lib';

type AdaptersPanelProps = {
  adapters: AdapterRecord[];
  onRefresh: () => void | Promise<void>;
};

export function AdaptersPanel({ adapters, onRefresh }: AdaptersPanelProps) {
  const startAndRefresh = async (adapterId: string) => {
    await startAdapter(adapterId);
    await onRefresh();
  };

  return (
    <article className="card emphasis runtime-column">
      <div className="card-heading">
        <div>
          <p className="eyebrow">适配器</p>
          <h3>TTS 适配器快速启动</h3>
        </div>
        <button className="ghost" onClick={() => onRefresh()}>
          刷新
        </button>
      </div>
      <div className="actions">
        <button onClick={() => startAndRefresh('edge_tts')}>启动 Edge TTS</button>
        <button className="ghost" onClick={() => startAndRefresh('sovits')}>
          启动 SoVITS
        </button>
      </div>
      {adapters.length ? (
        <div className="adapter-list scroll-region">
          {adapters.map((adapter) => (
            <article key={adapter.id} className="adapter-row">
              <div>
                <p className="adapter-name">{adapter.adapter_id}</p>
                <strong>{adapter.status === 'running' ? '受监管运行中' : '运行记录'}</strong>
                <p className="item-detail">
                  {adapter.last_error || `最近更新时间：${new Date(adapter.updated_at).toLocaleString()}`}
                </p>
              </div>
              <div className="side-meta">
                <span className={`status-pill status-${adapter.status}`}>{adapter.status}</span>
                <time>{new Date(adapter.started_at).toLocaleString()}</time>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="muted-copy">还没有启动受监管的适配器。</p>
      )}
    </article>
  );
}
