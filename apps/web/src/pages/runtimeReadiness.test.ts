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
import { evaluateRuntimeReadiness } from './runtimeReadiness';

function makeOverview(overrides: Partial<RuntimeOverview> = {}): RuntimeOverview {
  return {
    db_ready: true,
    message_count: 12,
    user_profile_count: 3,
    memory_entry_count: 9,
    config_artifact_count: 2,
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<AdapterRecord> = {}): AdapterRecord {
  return {
    id: 'adapter-1',
    adapter_id: 'edge_tts',
    status: 'running',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_error: null,
    ...overrides,
  };
}

function makeLive2d(overrides: Partial<Live2dStateRecord> = {}): Live2dStateRecord {
  return {
    subtitle: 'ready',
    subtitle_duration_ms: 3000,
    emotion: 'happy',
    updated_at: new Date().toISOString(),
    config: {
      scale: 0.25,
      x: 0.3,
      y: 0.5,
      updated_at: new Date().toISOString(),
    },
    ...overrides,
  };
}

function makeDanmakuSource(overrides: Partial<DanmakuSourceConfigRecord> = {}): DanmakuSourceConfigRecord {
  return {
    room_id: '556677',
    uid: 1024,
    buvid: 'memory-suite-buvid',
    has_cookie: true,
    signature_mode: 'cookie',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDanmakuState(overrides: Partial<DanmakuConnectionStateRecord> = {}): DanmakuConnectionStateRecord {
  return {
    status: 'connected',
    attempt_count: 1,
    consecutive_failures: 0,
    retry_delay_ms: 0,
    session_id: 'session-1',
    current_upstream_host: 'live.bilibili.com',
    last_connect_attempt_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    next_retry_at: null,
    last_error: null,
    last_close_reason: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makePersona(overrides: Partial<PersonaRuntimeStateRecord> = {}): PersonaRuntimeStateRecord {
  return {
    mode: 'stream',
    tone_profile: 'default',
    warmth: 0.8,
    sarcasm: 0.2,
    autonomy: 0.6,
    current_context: '',
    current_mood: 'neutral',
    fallback: {
      remote_successes: 8,
      remote_timeouts: 0,
      builtin_fallbacks: 0,
      last_path: 'remote',
    },
    ...overrides,
  };
}

function makeLatency(overrides: Partial<RecentChatLatencyResponse> = {}): RecentChatLatencyResponse {
  return {
    samples: [
      {
        handle_ms: 1200,
        finalize_ms: 900,
        total_ms: 2100,
        path: 'remote',
      },
    ],
    avg_total_ms: 2100,
    avg_handle_ms: 1200,
    avg_finalize_ms: 900,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'event-1',
    kind: 'speech_ready',
    source: 'media',
    detail: 'speech prepared',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('evaluateRuntimeReadiness', () => {
  test('returns ready when critical services are healthy and warnings are absent', () => {
    const readiness = evaluateRuntimeReadiness({
      overview: makeOverview(),
      adapters: [makeAdapter()],
      live2d: makeLive2d(),
      danmakuSource: makeDanmakuSource(),
      danmakuState: makeDanmakuState(),
      persona: makePersona(),
      chatLatency: makeLatency(),
      events: [makeEvent()],
    });

    expect(readiness.status).toBe('ready');
    expect(readiness.blockers).toEqual([]);
    expect(readiness.warnings).toEqual([]);
  });

  test('returns blocked when db is not ready and tts adapter is missing', () => {
    const readiness = evaluateRuntimeReadiness({
      overview: makeOverview({ db_ready: false }),
      adapters: [makeAdapter({ adapter_id: 'custom_python' })],
      live2d: makeLive2d(),
      danmakuSource: makeDanmakuSource(),
      danmakuState: makeDanmakuState(),
      persona: makePersona(),
      chatLatency: makeLatency(),
      events: [makeEvent()],
    });

    expect(readiness.status).toBe('blocked');
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('数据库'),
        expect.stringContaining('语音'),
      ]),
    );
  });

  test('returns warning when danmaku is disconnected, latency is high, and fallback is active', () => {
    const readiness = evaluateRuntimeReadiness({
      overview: makeOverview(),
      adapters: [makeAdapter()],
      live2d: makeLive2d(),
      danmakuSource: makeDanmakuSource(),
      danmakuState: makeDanmakuState({ status: 'disconnected', last_error: 'socket closed' }),
      persona: makePersona({
        fallback: {
          remote_successes: 8,
          remote_timeouts: 3,
          builtin_fallbacks: 2,
          last_path: 'builtin_timeout',
        },
      }),
      chatLatency: makeLatency({ avg_total_ms: 6500, avg_finalize_ms: 3200 }),
      events: [makeEvent()],
    });

    expect(readiness.status).toBe('warning');
    expect(readiness.blockers).toEqual([]);
    expect(readiness.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('弹幕'),
        expect.stringContaining('延迟'),
        expect.stringContaining('fallback'),
      ]),
    );
  });

  test('returns blocked when runtime event feed has not received anything yet', () => {
    const readiness = evaluateRuntimeReadiness({
      overview: makeOverview(),
      adapters: [makeAdapter()],
      live2d: makeLive2d(),
      danmakuSource: makeDanmakuSource(),
      danmakuState: makeDanmakuState(),
      persona: makePersona(),
      chatLatency: makeLatency(),
      events: [],
    });

    expect(readiness.status).toBe('blocked');
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([expect.stringContaining('事件流')]),
    );
  });
});
