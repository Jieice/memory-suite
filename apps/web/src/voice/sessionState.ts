export const voiceSessionStates = [
  'idle',
  'arming',
  'listening',
  'speech_detected',
  'finalizing_asr',
  'thinking',
  'speaking',
  'interrupted',
  'failed',
  'cooldown',
] as const;

export type VoiceSessionState = (typeof voiceSessionStates)[number];

export interface VoiceSessionSnapshot {
  state: VoiceSessionState;
  partialTranscript: string;
  finalTranscript: string;
  lastError: string | null;
  utteranceId: number;
}

export type VoiceSessionEvent =
  | { type: 'arm' }
  | { type: 'capture_started' }
  | { type: 'capture_stopped' }
  | { type: 'vad_open' }
  | { type: 'vad_close' }
  | { type: 'stt_partial'; text: string }
  | { type: 'stt_final'; text: string }
  | { type: 'stt_failed'; error: string }
  | { type: 'llm_started' }
  | { type: 'llm_completed' }
  | { type: 'llm_completed_without_speech' }
  | { type: 'llm_failed'; error: string }
  | { type: 'speech_completed' }
  | { type: 'interrupt'; reason?: string }
  | { type: 'cooldown_elapsed'; keepListening: boolean }
  | { type: 'reset' };

export function createVoiceSessionSnapshot(): VoiceSessionSnapshot {
  return {
    state: 'idle',
    partialTranscript: '',
    finalTranscript: '',
    lastError: null,
    utteranceId: 0,
  };
}

export function transitionVoiceSession(
  snapshot: VoiceSessionSnapshot,
  event: VoiceSessionEvent,
): VoiceSessionSnapshot {
  if (event.type === 'reset') {
    return createVoiceSessionSnapshot();
  }

  if (event.type === 'interrupt') {
    return {
      ...snapshot,
      state: 'interrupted',
      lastError: normalizeOptional(event.reason),
    };
  }

  switch (snapshot.state) {
    case 'idle':
      return transitionFromIdle(snapshot, event);
    case 'arming':
      return transitionFromArming(snapshot, event);
    case 'listening':
      return transitionFromListening(snapshot, event);
    case 'speech_detected':
      return transitionFromSpeechDetected(snapshot, event);
    case 'finalizing_asr':
      return transitionFromFinalizingAsr(snapshot, event);
    case 'thinking':
      return transitionFromThinking(snapshot, event);
    case 'speaking':
      return transitionFromSpeaking(snapshot, event);
    case 'cooldown':
    case 'failed':
    case 'interrupted':
      return transitionFromTerminal(snapshot, event);
  }
}

function transitionFromIdle(
  snapshot: VoiceSessionSnapshot,
  event: VoiceSessionEvent,
): VoiceSessionSnapshot {
  if (event.type === 'arm') {
    return {
      ...snapshot,
      state: 'arming',
      lastError: null,
    };
  }
  return reject(snapshot, event);
}

function transitionFromArming(
  snapshot: VoiceSessionSnapshot,
  event: VoiceSessionEvent,
): VoiceSessionSnapshot {
  if (event.type === 'capture_started') {
    return {
      ...snapshot,
      state: 'listening',
      lastError: null,
    };
  }
  if (event.type === 'stt_failed' || event.type === 'llm_failed') {
    return fail(snapshot, event.error);
  }
  return reject(snapshot, event);
}

function transitionFromListening(
  snapshot: VoiceSessionSnapshot,
  event: VoiceSessionEvent,
): VoiceSessionSnapshot {
  if (event.type === 'vad_open') {
    return {
      ...snapshot,
      state: 'speech_detected',
      partialTranscript: '',
      finalTranscript: '',
      lastError: null,
      utteranceId: snapshot.utteranceId + 1,
    };
  }
  if (event.type === 'capture_stopped') {
    return createVoiceSessionSnapshot();
  }
  return reject(snapshot, event);
}

function transitionFromSpeechDetected(
  snapshot: VoiceSessionSnapshot,
  event: VoiceSessionEvent,
): VoiceSessionSnapshot {
  if (event.type === 'stt_partial') {
    return {
      ...snapshot,
      partialTranscript: event.text,
    };
  }
  if (event.type === 'vad_close') {
    return {
      ...snapshot,
      state: 'finalizing_asr',
    };
  }
  if (event.type === 'capture_stopped') {
    return {
      ...snapshot,
      state: 'cooldown',
    };
  }
  return reject(snapshot, event);
}

function transitionFromFinalizingAsr(
  snapshot: VoiceSessionSnapshot,
  event: VoiceSessionEvent,
): VoiceSessionSnapshot {
  if (event.type === 'stt_partial') {
    return {
      ...snapshot,
      partialTranscript: event.text,
    };
  }
  if (event.type === 'stt_failed') {
    return fail(snapshot, event.error);
  }
  if (event.type === 'stt_final') {
    const finalTranscript = event.text.trim();
    if (!finalTranscript) {
      return {
        ...snapshot,
        state: 'cooldown',
        finalTranscript: '',
      };
    }
    return {
      ...snapshot,
      state: 'thinking',
      finalTranscript,
      partialTranscript: '',
      lastError: null,
    };
  }
  return reject(snapshot, event);
}

function transitionFromThinking(
  snapshot: VoiceSessionSnapshot,
  event: VoiceSessionEvent,
): VoiceSessionSnapshot {
  if (event.type === 'llm_started') {
    if (!snapshot.finalTranscript.trim()) {
      return reject(snapshot, event);
    }
    return snapshot;
  }
  if (event.type === 'llm_completed') {
    if (!snapshot.finalTranscript.trim()) {
      return reject(snapshot, event);
    }
    return {
      ...snapshot,
      state: 'speaking',
    };
  }
  if (event.type === 'llm_completed_without_speech') {
    if (!snapshot.finalTranscript.trim()) {
      return reject(snapshot, event);
    }
    return {
      ...snapshot,
      state: 'cooldown',
    };
  }
  if (event.type === 'llm_failed') {
    return fail(snapshot, event.error);
  }
  return reject(snapshot, event);
}

function transitionFromSpeaking(
  snapshot: VoiceSessionSnapshot,
  event: VoiceSessionEvent,
): VoiceSessionSnapshot {
  if (event.type === 'speech_completed') {
    return {
      ...snapshot,
      state: 'cooldown',
    };
  }
  return reject(snapshot, event);
}

function transitionFromTerminal(
  snapshot: VoiceSessionSnapshot,
  event: VoiceSessionEvent,
): VoiceSessionSnapshot {
  if (event.type === 'cooldown_elapsed') {
    return {
      ...snapshot,
      state: event.keepListening ? 'listening' : 'idle',
      partialTranscript: '',
      finalTranscript: '',
      lastError: null,
    };
  }
  return reject(snapshot, event);
}

function fail(snapshot: VoiceSessionSnapshot, error: string): VoiceSessionSnapshot {
  return {
    ...snapshot,
    state: 'failed',
    lastError: error.trim() || 'voice session failed',
  };
}

function reject(snapshot: VoiceSessionSnapshot, event: VoiceSessionEvent): never {
  throw new Error(`Invalid voice session transition: ${snapshot.state} -> ${event.type}`);
}

function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
