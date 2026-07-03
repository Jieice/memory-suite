import type {
  AdapterRecord,
  DanmakuConnectionStateRecord,
  DanmakuSourceConfigRecord,
  Live2dStateRecord,
  PersonaRuntimeStateRecord,
  RecentChatLatencyResponse,
  RuntimeEvent,
  RuntimeOverview,
} from '../generated/api';

export type ReadinessStatus = 'ready' | 'warning' | 'blocked';

export interface ReadinessResult {
  status: ReadinessStatus;
  blockers: string[];
  warnings: string[];
}

export interface ReadinessInput {
  overview: RuntimeOverview | null;
  adapters: AdapterRecord[];
  live2d: Live2dStateRecord | null;
  danmakuSource: DanmakuSourceConfigRecord | null;
  danmakuState: DanmakuConnectionStateRecord | null;
  persona: PersonaRuntimeStateRecord | null;
  chatLatency: RecentChatLatencyResponse | null;
  events: RuntimeEvent[];
}

const LATENCY_WARN_MS = 5000;
const FINALIZE_WARN_MS = 2500;
const FALLBACK_TIMEOUT_THRESHOLD = 2;
const FALLBACK_BUILTIN_THRESHOLD = 2;
const SPEECH_ADAPTER_IDS = new Set(['edge_tts', 'sovits']);

export function evaluateRuntimeReadiness(input: ReadinessInput): ReadinessResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // --- BLOCKING gates ---

  // DB must be ready
  if (!input.overview?.db_ready) {
    blockers.push('数据库尚未就绪');
  }

  // Speech adapter must be running
  const ttsRunning = input.adapters.some(
    (a) => SPEECH_ADAPTER_IDS.has(a.adapter_id) && a.status === 'running',
  );
  if (!ttsRunning) {
    blockers.push('语音适配器未运行');
  }

  // Runtime event feed must have received at least one event
  if (input.events.length === 0) {
    blockers.push('运行时事件流还没有收到事件');
  }

  // --- WARNING gates ---

  // Danmaku disconnected is a warning (not a blocker – can recover without restart)
  const danmakuStatus = input.danmakuState?.status;
  if (danmakuStatus && danmakuStatus !== 'connected' && danmakuStatus !== 'connecting') {
    const errorSuffix = input.danmakuState?.last_error
      ? ` (${input.danmakuState.last_error})`
      : '';
    warnings.push(`弹幕连接状态为 ${danmakuStatus}${errorSuffix}`);
  }

  // High end-to-end latency
  if (input.chatLatency) {
    const totalMs = Number(input.chatLatency.avg_total_ms);
    const finalizeMs = Number(input.chatLatency.avg_finalize_ms);
    if (totalMs > LATENCY_WARN_MS || finalizeMs > FINALIZE_WARN_MS) {
      warnings.push(
        `聊天延迟偏高：avg_total=${totalMs}ms avg_finalize=${finalizeMs}ms`,
      );
    }
  }

  // Excessive LLM fallback or builtin fallback activity
  if (input.persona) {
    const { remote_timeouts, builtin_fallbacks } = input.persona.fallback;
    if (remote_timeouts >= FALLBACK_TIMEOUT_THRESHOLD || builtin_fallbacks >= FALLBACK_BUILTIN_THRESHOLD) {
      warnings.push(
        `LLM fallback 频繁：remote_timeouts=${remote_timeouts} builtin_fallbacks=${builtin_fallbacks}`,
      );
    }
  }

  // Derive overall status
  let status: ReadinessStatus;
  if (blockers.length > 0) {
    status = 'blocked';
  } else if (warnings.length > 0) {
    status = 'warning';
  } else {
    status = 'ready';
  }

  return { status, blockers, warnings };
}
