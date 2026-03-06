export function OverlaysPage() {
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
      </div>
    </section>
  );
}
