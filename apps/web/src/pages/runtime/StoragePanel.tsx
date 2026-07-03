import type { RuntimeOverview } from '../../generated/api';
import { Stat } from './Stats';

type StoragePanelProps = {
  overview: RuntimeOverview | null;
  error: string | null;
};

export function StoragePanel({ overview, error }: StoragePanelProps) {
  return (
    <article className="card runtime-column">
      <p className="eyebrow">存储占用</p>
      <h3>当前统一数据库计数</h3>
      <dl className="definition-grid">
        <Stat label="消息" value={String(overview?.message_count ?? 0)} />
        <Stat label="档案" value={String(overview?.user_profile_count ?? 0)} />
        <Stat label="记忆" value={String(overview?.memory_entry_count ?? 0)} />
        <Stat label="配置" value={String(overview?.config_artifact_count ?? 0)} />
      </dl>
      {error ? <p className="error">{error}</p> : null}
    </article>
  );
}
