import type {
  AdapterRecord,
  AdapterStartRequest,
  ChatRequest,
  ChatResponse,
  HealthResponse,
  ImportRequest,
  ImportSummary,
  JobRequest,
  JobRecord,
  JobResponse,
  RuntimeEvent,
  RuntimeOverview,
  StoredMessage,
  TtsSpeakRequest,
  TtsSpeakResponse,
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

export async function listAdapters(): Promise<AdapterRecord[]> {
  return asJson<AdapterRecord[]>(await fetch('/api/runtime/adapters'));
}

export async function startAdapter(
  adapterId: string,
  body: AdapterStartRequest,
): Promise<AdapterRecord> {
  return asJson<AdapterRecord>(
    await fetch(`/api/runtime/adapters/${adapterId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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

export async function createTrainJob(body: JobRequest): Promise<JobResponse> {
  return asJson<JobResponse>(
    await fetch('/api/jobs/train', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function createEvalJob(body: JobRequest): Promise<JobResponse> {
  return asJson<JobResponse>(
    await fetch('/api/jobs/eval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function importLegacy(body: ImportRequest): Promise<ImportSummary> {
  return asJson<ImportSummary>(
    await fetch('/api/import/legacy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function listJobs(): Promise<JobRecord[]> {
  return asJson<JobRecord[]>(await fetch('/api/jobs'));
}

export async function listSessionMessages(sessionId: string): Promise<StoredMessage[]> {
  return asJson<StoredMessage[]>(await fetch(`/api/sessions/${sessionId}/messages`));
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
