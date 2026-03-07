import { useEffect, useState } from 'react';
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
        <p className="eyebrow">OBS Surface</p>
        <h2>Overlay Entry Points</h2>
      </header>
      <div className="card-grid">
        <article className="card">
          <h3>Live2D Overlay</h3>
          <p><a href="/overlay/live2d">/overlay/live2d</a></p>
        </article>
        <article className="card">
          <h3>Danmaku Overlay</h3>
          <p><a href="/overlay/danmaku">/overlay/danmaku</a></p>
        </article>
        <article className="card">
          <h3>Overlay Runtime Feed</h3>
          <pre>{events.length ? JSON.stringify(events, null, 2) : 'No overlay events yet.'}</pre>
        </article>
      </div>
    </section>
  );
}
