import type { RecentChatLatencyResponse } from '../../generated/api';
import { Stat } from './Stats';

type ChatLatencyPanelProps = {
  chatLatency: RecentChatLatencyResponse;
};

export function ChatLatencyPanel({ chatLatency }: ChatLatencyPanelProps) {
  return (
    <article className="card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">聊天延迟</p>
          <h3>最近 /api/chat 分阶段耗时</h3>
        </div>
      </div>
      <dl className="definition-list">
        <Stat label="平均总耗时" value={`${chatLatency.avg_total_ms} ms`} />
        <Stat label="平均处理" value={`${chatLatency.avg_handle_ms} ms`} />
        <Stat label="平均收尾" value={`${chatLatency.avg_finalize_ms} ms`} />
        <Stat label="样本数" value={String(chatLatency.samples.length)} />
        {chatLatency.samples.length > 0 && (
          <Stat label="最近路径" value={chatLatency.samples[chatLatency.samples.length - 1].path} />
        )}
      </dl>
    </article>
  );
}