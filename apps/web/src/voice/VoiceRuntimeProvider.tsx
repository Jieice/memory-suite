import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ChatResponse, RuntimeEvent } from '../generated/api';
import {
  cancelLive2dSpeech,
  interruptSession,
  openRuntimeStream,
  sendChat,
  transcribeMicAudio,
} from '../lib';
import type { RuntimeStreamStatus } from '../lib';
import { loadUiPreferences, subscribeUiPreferences } from '../preferences';
import { useVoiceLoop, type VoiceLoopStatus } from './useVoiceLoop';

export const VOICE_SESSION_ID = 'web-demo';

interface VoiceRuntimeContextValue {
  sessionId: string;
  enabled: boolean;
  snapshot: VoiceLoopStatus['snapshot'];
  engineReady: boolean;
  engineError: string | null;
  runtimeStreamStatus: RuntimeStreamStatus;
  lastVoiceChat: ChatResponse | null;
  interruptActiveTurn: () => Promise<void>;
}

const VoiceRuntimeContext = createContext<VoiceRuntimeContextValue | null>(null);

export function VoiceRuntimeProvider({ children }: { children: ReactNode }) {
  const [uiPreferences, setUiPreferences] = useState(loadUiPreferences);
  const [runtimeStreamStatus, setRuntimeStreamStatus] =
    useState<RuntimeStreamStatus>('disconnected');
  const [lastVoiceChat, setLastVoiceChat] = useState<ChatResponse | null>(null);

  useEffect(() => subscribeUiPreferences(setUiPreferences), []);

  const interruptActiveTurn = useCallback(async () => {
    await Promise.allSettled([
      cancelLive2dSpeech({ session_id: VOICE_SESSION_ID, reason: 'voice interrupt' }),
      interruptSession(VOICE_SESSION_ID),
    ]);
  }, []);

  const submitTranscript = useCallback(async (text: string, _utteranceId: number) => {
    const response = await sendChat({
      session_id: VOICE_SESSION_ID,
      user_id: 'voice',
      text,
    });
    setLastVoiceChat(response);
    return response;
  }, []);

  const transcribe = useCallback(async (wavBase64: string) => {
    const result = await transcribeMicAudio({
      audio_base64: wavBase64,
      mime_type: 'audio/wav',
      session_id: VOICE_SESSION_ID,
      user_id: 'voice',
      language: null,
      prompt: null,
    });
    if (!result.ok) {
      throw new Error(result.message || 'STT 转写失败');
    }
    return result.text;
  }, []);

  const voice = useVoiceLoop({
    enabled: uiPreferences.micChatEnabled,
    hooks: {
      submitTranscript,
      interruptActiveTurn,
      transcribe,
    },
  });

  const notifySpeechCompleted = voice.notifySpeechCompleted;
  useEffect(() => {
    if (!uiPreferences.micChatEnabled) {
      setRuntimeStreamStatus('disconnected');
      return;
    }
    return openRuntimeStream(
      (event: RuntimeEvent) => {
        // A streamed reply produces several speech segments (one per sentence),
        // each firing speech_completed as it finishes. Only the whole-turn
        // boundary (speech_turn_completed) means the reply is fully spoken, so
        // that — not a per-segment completion — is what returns us to listening.
        // speech_failed still ends the turn (interrupt / synthesis failure).
        if (event.kind === 'speech_turn_completed' || event.kind === 'speech_failed') {
          notifySpeechCompleted();
        }
      },
      (status) => setRuntimeStreamStatus(status),
    );
  }, [uiPreferences.micChatEnabled, notifySpeechCompleted]);

  const value = useMemo<VoiceRuntimeContextValue>(
    () => ({
      sessionId: VOICE_SESSION_ID,
      enabled: uiPreferences.micChatEnabled,
      snapshot: voice.snapshot,
      engineReady: voice.engineReady,
      engineError: voice.engineError,
      runtimeStreamStatus,
      lastVoiceChat,
      interruptActiveTurn,
    }),
    [
      interruptActiveTurn,
      lastVoiceChat,
      runtimeStreamStatus,
      uiPreferences.micChatEnabled,
      voice.engineError,
      voice.engineReady,
      voice.snapshot,
    ],
  );

  return <VoiceRuntimeContext.Provider value={value}>{children}</VoiceRuntimeContext.Provider>;
}

export function useVoiceRuntime(): VoiceRuntimeContextValue {
  const value = useContext(VoiceRuntimeContext);
  if (!value) {
    throw new Error('useVoiceRuntime must be used inside VoiceRuntimeProvider');
  }
  return value;
}
