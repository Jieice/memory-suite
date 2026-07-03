import { useEffect, useState } from 'react';
import { JsonBlock } from '../components/JsonBlock';
import type { RuntimeEvent } from '../generated/api';
import { openOverlayStream } from '../lib';

export function OverlaysPage() {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);

  useEffect(() => {
    return openOverlayStream((event) => {
      setEvents((current) => [event, ...current].slice(0, 8));
    });
  }, []);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">浮窗入口</p>
        <h2>透明浮窗与 OBS 页面</h2>
      </header>
      <div className="card-grid">
        <article className="card">
          <h3>Live2D 透明浮窗</h3>
          <p><a href="/overlay/live2d?mode=pet">/overlay/live2d?mode=pet</a></p>
        </article>
        <article className="card">
          <h3>弹幕浮层</h3>
          <p><a href="/overlay/danmaku">/overlay/danmaku</a></p>
        </article>
        <article className="card">
          <h3>浮窗运行事件</h3>
          <JsonBlock title="最近事件" value={events} empty="还没有浮窗事件。" />
        </article>
      </div>
    </section>
  );
}
