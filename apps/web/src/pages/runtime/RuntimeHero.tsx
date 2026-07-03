import type { RuntimeOverview } from '../../generated/api';
import { Metric } from './Stats';

type RuntimeHeroProps = {
  overview: RuntimeOverview | null;
};

export function RuntimeHero({ overview }: RuntimeHeroProps) {
  return (
    <article className="card runtime-hero">
      <div className="runtime-hero-copy">
        <p className="eyebrow">运行室</p>
        <h3>以桌面端方式观察和操作统一后端。</h3>
        <p className="muted-copy">
          界面、任务、适配器和实时控制都围绕同一个 HTTP 入口与 SQLite 运行库工作。
        </p>
      </div>
      <div className="hero-metrics">
        <Metric label="数据库" value={overview?.db_ready ? '就绪' : '检查'} accent />
        <Metric label="消息" value={String(overview?.message_count ?? 0)} />
        <Metric label="任务" value={String(overview?.job_count ?? 0)} />
        <Metric label="配置" value={String(overview?.config_artifact_count ?? 0)} />
      </div>
    </article>
  );
}