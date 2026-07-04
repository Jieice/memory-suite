import type {
  AdapterRecord,
  ChatRequest,
  ChatResponse,
  DanmakuBootstrapRecord,
  DanmakuConnectionActionResponse,
  DanmakuConnectionStateRecord,
  DanmakuInjectRequest,
  DanmakuNativeConnectResponse,
  DanmakuNativeProbeResponse,
  DanmakuSourceConfigRecord,
  DanmakuSourceUpdateRequest,
  DiaryEntryRecord,
  HealthResponse,
  KnowledgeCatalogResponse,
  Live2dConfigRequest,
  Live2dEmotionRequest,
  Live2dStateRecord,
  Live2dSubtitleRequest,
  PersonaRuntimeConfigUpdateRequest,
  PersonaRuntimeStateRecord,
  RuntimeEvent,
  RuntimeOverview,
  SceneContextRecord,
  SceneEventRecord,
  SceneSuggestionResponse,
  ShortContentResponse,
  StoredMessage,
  ToolExecutionRequest,
  ToolExecutionResponse,
  ToolManifestRecord,
  TtsSpeakRequest,
  TtsSpeakResponse,
  RecentChatLatencyResponse,
} from './generated/api';

async function asJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return asJson<HealthResponse>(await fetch('/api/health'));
}

export async function fetchRuntimeOverview(): Promise<RuntimeOverview> {
  return asJson<RuntimeOverview>(await fetch('/api/runtime/overview'));
}

export async function fetchChatLatency(): Promise<RecentChatLatencyResponse> {
  return asJson<RecentChatLatencyResponse>(await fetch('/api/runtime/chat-latency'));
}

export async function fetchKnowledgeCatalog(
  query?: string,
  limit = 24,
): Promise<KnowledgeCatalogResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (query && query.trim()) {
    params.set('query', query.trim());
  }
  return asJson<KnowledgeCatalogResponse>(await fetch(`/api/knowledge/catalog?${params.toString()}`));
}

export async function listToolManifests(): Promise<ToolManifestRecord[]> {
  return asJson<ToolManifestRecord[]>(await fetch('/api/tools/manifests'));
}

export async function executeTool(body: ToolExecutionRequest): Promise<ToolExecutionResponse> {
  return asJson<ToolExecutionResponse>(
    await fetch('/api/tools/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function listToolExecutions(limit = 20): Promise<ToolExecutionResponse[]> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  return asJson<ToolExecutionResponse[]>(await fetch(`/api/tools/executions?${params.toString()}`));
}

export async function fetchLive2dState(): Promise<Live2dStateRecord> {
  return asJson<Live2dStateRecord>(await fetch('/api/live2d/state'));
}

export async function fetchDanmakuSource(): Promise<DanmakuSourceConfigRecord> {
  return asJson<DanmakuSourceConfigRecord>(await fetch('/api/danmaku/source'));
}

export async function updateDanmakuSource(
  body: DanmakuSourceUpdateRequest,
): Promise<DanmakuSourceConfigRecord> {
  return asJson<DanmakuSourceConfigRecord>(
    await fetch('/api/danmaku/source', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function fetchDanmakuState(): Promise<DanmakuConnectionStateRecord> {
  return asJson<DanmakuConnectionStateRecord>(await fetch('/api/danmaku/state'));
}

export async function bootstrapDanmaku(): Promise<DanmakuBootstrapRecord> {
  return asJson<DanmakuBootstrapRecord>(
    await fetch('/api/danmaku/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
}

export async function nativeProbeDanmaku(): Promise<DanmakuNativeProbeResponse> {
  return asJson<DanmakuNativeProbeResponse>(
    await fetch('/api/danmaku/native-probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
}

export async function nativeConnectDanmakuOnce(): Promise<DanmakuNativeConnectResponse> {
  return asJson<DanmakuNativeConnectResponse>(
    await fetch('/api/danmaku/native-connect-once', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
}

export async function startNativeDanmakuSession(): Promise<DanmakuConnectionActionResponse> {
  return asJson<DanmakuConnectionActionResponse>(
    await fetch('/api/danmaku/native-session/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
}

export async function disconnectDanmaku(): Promise<DanmakuConnectionActionResponse> {
  return asJson<DanmakuConnectionActionResponse>(
    await fetch('/api/danmaku/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
}

export async function updateLive2dSubtitle(
  body: Live2dSubtitleRequest,
): Promise<Live2dStateRecord> {
  return asJson<Live2dStateRecord>(
    await fetch('/api/live2d/subtitle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function updateLive2dEmotion(
  body: Live2dEmotionRequest,
): Promise<Live2dStateRecord> {
  return asJson<Live2dStateRecord>(
    await fetch('/api/live2d/emotion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function updateLive2dConfig(
  body: Live2dConfigRequest,
): Promise<Live2dStateRecord> {
  return asJson<Live2dStateRecord>(
    await fetch('/api/live2d/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function listAdapters(): Promise<AdapterRecord[]> {
  return asJson<AdapterRecord[]>(await fetch('/api/runtime/adapters'));
}

export async function startAdapter(
  adapterId: string,
): Promise<AdapterRecord> {
  return asJson<AdapterRecord>(
    await fetch(`/api/runtime/adapters/${adapterId}/start`, {
      method: 'POST',
    }),
  );
}

export async function sendChat(body: ChatRequest): Promise<ChatResponse> {
  return asJson<ChatResponse>(
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function queueTts(body: TtsSpeakRequest): Promise<TtsSpeakResponse> {
  return asJson<TtsSpeakResponse>(
    await fetch('/api/tts/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function listSessionMessages(sessionId: string): Promise<StoredMessage[]> {
  return asJson<StoredMessage[]>(await fetch(`/api/sessions/${sessionId}/messages`));
}

export async function injectDanmaku(body: DanmakuInjectRequest): Promise<ChatResponse> {
  return asJson<ChatResponse>(
    await fetch('/api/gateway/danmaku', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export function openRuntimeStream(onEvent: (event: RuntimeEvent) => void): () => void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws/runtime`);

  socket.addEventListener('message', (message) => {
    try {
      const event = JSON.parse(message.data) as RuntimeEvent;
      onEvent(event);
    } catch {
      // Ignore malformed events so the console stays connected.
    }
  });

  return () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  };
}

export function openOverlayStream(onEvent: (event: RuntimeEvent) => void): () => void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws/overlay`);

  socket.addEventListener('message', (message) => {
    try {
      const event = JSON.parse(message.data) as RuntimeEvent;
      onEvent(event);
    } catch {
      // Ignore malformed events so the overlay inspector stays connected.
    }
  });

  return () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  };
}

export async function fetchPersonaState(): Promise<PersonaRuntimeStateRecord> {
  return asJson<PersonaRuntimeStateRecord>(await fetch('/api/persona/state'));
}

export async function updatePersonaConfig(
  update: PersonaRuntimeConfigUpdateRequest,
): Promise<PersonaRuntimeStateRecord> {
  return asJson<PersonaRuntimeStateRecord>(
    await fetch('/api/persona/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    }),
  );
}
export async function sendSceneEvent(kind: string, detail?: string): Promise<SceneEventRecord> {
  return asJson<SceneEventRecord>(
    await fetch('/api/scene/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, detail: detail ?? null }),
    }),
  );
}

export async function setSceneContext(description: string, ttlTurns?: number): Promise<SceneContextRecord> {
  return asJson<SceneContextRecord>(
    await fetch('/api/scene/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description, ttl_turns: ttlTurns ?? 5 }),
    }),
  );
}

export async function fetchSceneContext(): Promise<SceneContextRecord | null> {
  const res = await fetch('/api/scene/context');
  if (!res.ok) return null;
  return res.json();
}
export async function fetchSceneSuggestion(): Promise<SceneSuggestionResponse> {
  return asJson<SceneSuggestionResponse>(await fetch('/api/scene/suggest'));
}
export async function fetchCharacterDiary(): Promise<DiaryEntryRecord[]> {
  const res = await fetch('/api/character/diary');
  if (!res.ok) return [];
  const data = await res.json();
  return data.entries ?? [];
}

export async function generateDiaryEntry(): Promise<DiaryEntryRecord | null> {
  const res = await fetch('/api/character/diary', { method: 'POST' });
  if (!res.ok) return null;
  return res.json();
}

export async function fetchCharacterClips(): Promise<RuntimeEvent[]> {
  const res = await fetch('/api/character/clips');
  if (!res.ok) return [];
  return res.json();
}

export async function generateShortContent(): Promise<ShortContentResponse | null> {
  const res = await fetch('/api/character/generate-short', { method: 'POST' });
  if (!res.ok) return null;
  return res.json();
}
