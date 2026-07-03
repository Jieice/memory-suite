import type { RuntimeEvent } from '../../generated/api';

type EventFeedPanelProps = {
  events: RuntimeEvent[];
};

export function EventFeedPanel({ events }: EventFeedPanelProps) {
  return (
    <article className="card runtime-column">
      <div className="card-heading">
        <div>
          <p className="eyebrow">事件流</p>
          <h3>来自聊天、任务和适配器的实时总线</h3>
        </div>
        <span className="status-pill">{events.length} 条缓存</span>
      </div>
      {events.length ? (
        <div className="event-list scroll-region">
          {events.map((event) => (
            <article key={event.id} className="event-row">
              <span className={`event-marker event-${event.kind}`} />
              <div>
                <p className="job-kind">{event.kind}</p>
                <strong>{event.source}</strong>
                <p className="job-path">{event.detail ?? '无详情'}</p>
              </div>
              <time>{new Date(event.created_at).toLocaleTimeString()}</time>
            </article>
          ))}
        </div>
      ) : (
        <p className="muted-copy">还没有收到运行时事件。</p>
      )}
    </article>
  );
}
