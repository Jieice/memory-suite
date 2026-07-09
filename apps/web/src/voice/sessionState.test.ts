import {
  createVoiceSessionSnapshot,
  transitionVoiceSession,
  voiceSessionStates,
  type VoiceSessionSnapshot,
} from './sessionState';

function apply(events: Parameters<typeof transitionVoiceSession>[1][]): VoiceSessionSnapshot {
  return events.reduce(transitionVoiceSession, createVoiceSessionSnapshot());
}

describe('voice session state model', () => {
  test('defines the approved voice session states', () => {
    expect(voiceSessionStates).toEqual([
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
    ]);
  });

  test('runs the normal voice turn flow', () => {
    const snapshot = apply([
      { type: 'arm' },
      { type: 'capture_started' },
      { type: 'vad_open' },
      { type: 'stt_partial', text: 'hel' },
      { type: 'vad_close' },
      { type: 'stt_final', text: ' hello ' },
      { type: 'llm_started' },
      { type: 'llm_completed' },
      { type: 'speech_completed' },
      { type: 'cooldown_elapsed', keepListening: true },
    ]);

    expect(snapshot.state).toBe('listening');
    expect(snapshot.finalTranscript).toBe('');
    expect(snapshot.partialTranscript).toBe('');
    expect(snapshot.utteranceId).toBe(1);
  });

  test('returns to listening after silence closes an empty utterance', () => {
    const snapshot = apply([
      { type: 'arm' },
      { type: 'capture_started' },
      { type: 'vad_open' },
      { type: 'vad_close' },
      { type: 'stt_final', text: '   ' },
      { type: 'cooldown_elapsed', keepListening: true },
    ]);

    expect(snapshot.state).toBe('listening');
    expect(snapshot.finalTranscript).toBe('');
    expect(snapshot.lastError).toBeNull();
  });

  test('returns to listening when chat completes without speech', () => {
    const snapshot = apply([
      { type: 'arm' },
      { type: 'capture_started' },
      { type: 'vad_open' },
      { type: 'vad_close' },
      { type: 'stt_final', text: '听得到吗' },
      { type: 'llm_started' },
      { type: 'llm_completed_without_speech' },
      { type: 'cooldown_elapsed', keepListening: true },
    ]);

    expect(snapshot.state).toBe('listening');
    expect(snapshot.finalTranscript).toBe('');
    expect(snapshot.lastError).toBeNull();
  });

  test('lands in failed when STT fails after VAD closes', () => {
    const snapshot = apply([
      { type: 'arm' },
      { type: 'capture_started' },
      { type: 'vad_open' },
      { type: 'vad_close' },
      { type: 'stt_failed', error: 'adapter timeout' },
    ]);

    expect(snapshot.state).toBe('failed');
    expect(snapshot.lastError).toBe('adapter timeout');
  });

  test('interrupts an active speaking turn', () => {
    const snapshot = apply([
      { type: 'arm' },
      { type: 'capture_started' },
      { type: 'vad_open' },
      { type: 'vad_close' },
      { type: 'stt_final', text: '打断测试' },
      { type: 'llm_completed' },
      { type: 'interrupt', reason: 'new speech detected' },
    ]);

    expect(snapshot.state).toBe('interrupted');
    expect(snapshot.lastError).toBe('new speech detected');
  });

  test('rejects thinking before a final transcript exists', () => {
    const snapshot = apply([{ type: 'arm' }, { type: 'capture_started' }]);

    expect(() => transitionVoiceSession(snapshot, { type: 'llm_started' })).toThrow(
      'Invalid voice session transition: listening -> llm_started',
    );
  });
});
