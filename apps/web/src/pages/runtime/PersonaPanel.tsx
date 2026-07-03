import type { PersonaRuntimeStateRecord } from '../../generated/api';
import { Stat } from './Stats';

type PersonaPanelProps = {
  persona: PersonaRuntimeStateRecord;
};

export function PersonaPanel({ persona }: PersonaPanelProps) {
  return (
    <article className="card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">人格运行时</p>
          <h3>角色与兜底状态</h3>
        </div>
      </div>
      <dl className="definition-list">
        <Stat label="模式" value={persona.mode} />
        <Stat label="语气档案" value={persona.tone_profile} />
        <Stat label="温度" value={String(persona.warmth.toFixed(2))} />
        <Stat label="吐槽度" value={String(persona.sarcasm.toFixed(2))} />
        <Stat label="自主度" value={String(persona.autonomy.toFixed(2))} />
        <Stat label="远端成功" value={String(persona.fallback.remote_successes)} />
        <Stat label="远端超时" value={String(persona.fallback.remote_timeouts)} />
        <Stat label="内置兜底" value={String(persona.fallback.builtin_fallbacks)} />
        <Stat label="最近路径" value={persona.fallback.last_path} />
      </dl>
    </article>
  );
}