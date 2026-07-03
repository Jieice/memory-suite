import type { ReadinessResult } from '../runtimeReadiness';

type ReadinessCardProps = {
  readiness: ReadinessResult;
};

export function ReadinessCard({ readiness }: ReadinessCardProps) {
  const statusLabel =
    readiness.status === 'ready'
      ? '✅ 可开播'
      : readiness.status === 'warning'
        ? '⚠️ 警告'
        : '🚫 阻塞';
  const statusClass =
    readiness.status === 'ready'
      ? 'status-running'
      : readiness.status === 'warning'
        ? 'status-starting'
        : 'status-failed';

  return (
    <article className="card" style={{ borderLeft: '4px solid var(--accent, #7c3aed)' }}>
      <div className="card-heading">
        <div>
          <p className="eyebrow">开播检查</p>
          <h3>系统是否达到正式开播门槛</h3>
        </div>
        <span className={`status-pill ${statusClass}`}>{statusLabel}</span>
      </div>
      {readiness.blockers.length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <p className="eyebrow" style={{ color: 'var(--error, #dc2626)' }}>阻塞项（必须修复）</p>
          <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem', fontSize: '0.875rem' }}>
            {readiness.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}
      {readiness.warnings.length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <p className="eyebrow" style={{ color: 'var(--warn, #d97706)' }}>警告项（建议处理）</p>
          <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem', fontSize: '0.875rem' }}>
            {readiness.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {readiness.status === 'ready' && (
        <p className="muted-copy" style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>
          所有门禁通过，可以开始正式开播。
        </p>
      )}
    </article>
  );
}