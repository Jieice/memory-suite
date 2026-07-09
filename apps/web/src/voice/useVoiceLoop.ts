import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatResponse } from '../generated/api';
import {
  createVoiceSessionSnapshot,
  transitionVoiceSession,
  type VoiceSessionSnapshot,
} from './sessionState';
import {
  createSileroVadEngine,
  encodeVadAudioToWavBase64,
  type VadEngine,
  type VadEngineOptions,
} from './vadEngine';

/**
 * useVoiceLoop —— 常开语音直播模式驱动器（对标 Neuro-sama 的自动交互）。
 *
 * 它把 Silero VAD 接到已有的 voice session 状态机上，形成闭环：
 *
 *   listening（常驻监听）
 *     → onSpeechStart          → vad_open      → speech_detected
 *     → onSpeechEnd(audio)     → vad_close     → finalizing_asr
 *     → /api/stt/transcribe    → stt_final     → thinking
 *     → /api/chat（喂 LLM）     → llm_completed → speaking（若本轮有 TTS）
 *                              → llm_completed_without_speech → cooldown（若空回复/无 TTS）
 *     → 等 TTS speech_completed → cooldown（带 watchdog 兜底）
 *     → 冷却结束               → 回到 listening
 *
 * 关键行为：
 * 1. 插话打断（barge-in）：bargeIn 开启（默认，耳机场景）时，角色 thinking/speaking
 *    期间保持麦克风监听。你一开口，handleSpeechStart 就 cancel 当前正在播的 speech
 *    + interrupt session，立刻切进你的新一轮。这是让"说话就打断"真正生效的关键。
 * 2. 回声防护（bargeIn 关闭时）：进入 thinking/speaking 时 pause VAD，回 cooldown/listening
 *    时 resume——用于麦克风能听到角色声音（外放）的场景，避免角色听到自己无限自问自答。
 *    注意：这与 barge-in 互斥，闭麦时插话打断不可能生效。
 * 3. 空句丢弃：VAD 误触发或转写为空时，直接回到 listening，不喂 LLM。
 */

export interface VoiceLoopHooks {
  /** 把最终转写文本喂进 chat 链路，返回 ChatResponse 以判断本轮是否需要等待 TTS。 */
  submitTranscript: (text: string, utteranceId: number) => Promise<ChatResponse>;
  /** 检测到新语音、需要打断当前正在播的回合。 */
  interruptActiveTurn: () => Promise<void>;
  /** 调用后端 STT，返回识别文本。 */
  transcribe: (wavBase64: string) => Promise<string>;
}

export interface VoiceLoopConfig {
  /** 是否启用常开语音模式。关掉时释放麦克风。 */
  enabled: boolean;
  /**
   * 插话打断（barge-in）。默认 true（耳机场景）：角色说话时麦克风保持监听，
   * 你一开口立刻打断当前回合、切进新一轮。
   * 设为 false 时退回"回声防护"模式：角色说话时闭麦，适合麦克风能收到角色外放声音的场景，
   * 但此时无法在角色说话中途打断它。
   */
  bargeIn?: boolean;
  /** 冷却时长（ms），TTS 播完后隔多久重新开听，避免立刻吃到尾音。 */
  cooldownMs?: number;
  /** speaking 状态最长等待时长（ms）。事件流丢失时用它兜底回监听。 */
  speechWatchdogMs?: number;
  /** VAD 灵敏度参数（透传）。 */
  vadOptions?: VadEngineOptions;
  hooks: VoiceLoopHooks;
}

export interface VoiceLoopStatus {
  snapshot: VoiceSessionSnapshot;
  /** 引擎是否已加载并在跑。 */
  engineReady: boolean;
  /** 最近一次引擎级错误（麦克风权限、模型加载等）。 */
  engineError: string | null;
  /**
   * 外部（运行时 WebSocket）在收到 speech_completed / speech_failed 时调用，
   * 推动 speaking → cooldown → listening 闭环。
   */
  notifySpeechCompleted: () => void;
}

const speechWaitStatuses = new Set(['ready', 'dispatching']);

function shouldWaitForSpeech(response: ChatResponse): boolean {
  return response.assistant_text.trim().length > 0 && speechWaitStatuses.has(response.speech.status);
}

function resolveSpeechWatchdogMs(response: ChatResponse, minimumMs: number): number {
  const plannedMs = Number.isFinite(response.speech.duration_ms) ? response.speech.duration_ms : 0;
  return Math.min(Math.max(plannedMs + 8000, minimumMs), 45000);
}

export function useVoiceLoop(config: VoiceLoopConfig): VoiceLoopStatus {
  const { enabled, hooks } = config;
  const cooldownMs = config.cooldownMs ?? 600;
  const speechWatchdogMs = config.speechWatchdogMs ?? 12000;
  // 插话打断：默认开（耳机场景，麦克风听不到角色声音）。开启时角色说话期间不闭麦，
  // 你一开口就能打断它。关闭时退回回声防护（thinking/speaking 闭麦），适合外放场景。
  const bargeIn = config.bargeIn ?? true;

  const [snapshot, setSnapshot] = useState<VoiceSessionSnapshot>(createVoiceSessionSnapshot);
  const [engineReady, setEngineReady] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);

  // 用 ref 持有最新 snapshot / hooks，避免 VAD 回调闭包吃到旧值。
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  const engineRef = useRef<VadEngine | null>(null);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 标记当前是不是因为 TTS 播放主动 pause 的（区别于彻底关闭）。
  const mutedForSpeechRef = useRef(false);

  // 状态机 dispatch：单点更新，方便日志与一致性。
  const dispatch = useCallback((event: Parameters<typeof transitionVoiceSession>[1]) => {
    setSnapshot((current) => {
      try {
        return transitionVoiceSession(current, event);
      } catch {
        // 非法迁移直接吞掉：VAD 是异步事件源，偶发乱序不应该崩掉整个循环。
        return current;
      }
    });
  }, []);

  const clearCooldownTimer = useCallback(() => {
    if (cooldownTimerRef.current) {
      clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }, []);

  const clearSpeechWatchdogTimer = useCallback(() => {
    if (speechWatchdogTimerRef.current) {
      clearTimeout(speechWatchdogTimerRef.current);
      speechWatchdogTimerRef.current = null;
    }
  }, []);

  const isCurrentUtterance = useCallback((utteranceId: number) => {
    return snapshotRef.current.utteranceId === utteranceId;
  }, []);

  // 失败/异常/无 TTS 后的冷却恢复：延迟后回到 listening。
  const scheduleCooldownRecovery = useCallback(() => {
    clearCooldownTimer();
    cooldownTimerRef.current = setTimeout(() => {
      dispatch({ type: 'cooldown_elapsed', keepListening: true });
    }, cooldownMs);
  }, [clearCooldownTimer, cooldownMs, dispatch]);

  const scheduleSpeechWatchdog = useCallback(
    (response: ChatResponse, utteranceId: number) => {
      clearSpeechWatchdogTimer();
      const timeoutMs = resolveSpeechWatchdogMs(response, speechWatchdogMs);
      speechWatchdogTimerRef.current = setTimeout(() => {
        if (!isCurrentUtterance(utteranceId) || snapshotRef.current.state !== 'speaking') {
          return;
        }
        dispatch({ type: 'speech_completed' });
        scheduleCooldownRecovery();
      }, timeoutMs);
    },
    [
      clearSpeechWatchdogTimer,
      dispatch,
      isCurrentUtterance,
      scheduleCooldownRecovery,
      speechWatchdogMs,
    ],
  );

  // VAD: 检测到人声起始
  const handleSpeechStart = useCallback(() => {
    const current = snapshotRef.current;
    // 如果角色正在思考或说话，用户又开口 = 打断意图。
    if (current.state === 'thinking' || current.state === 'speaking') {
      clearCooldownTimer();
      clearSpeechWatchdogTimer();
      void hooksRef.current.interruptActiveTurn().catch(() => {
        // 打断失败不阻塞后续；播放层还有自检兜底。
      });
      dispatch({ type: 'interrupt', reason: 'new speech detected' });
      // 打断后立刻把这次开口当作新回合起点。
      dispatch({ type: 'cooldown_elapsed', keepListening: true });
    }
    dispatch({ type: 'vad_open' });
  }, [clearCooldownTimer, clearSpeechWatchdogTimer, dispatch]);

  // VAD: 检测到人声结束，拿到整段音频
  const handleSpeechEnd = useCallback(
    (audio: Float32Array) => {
      dispatch({ type: 'vad_close' });
      const utteranceId = snapshotRef.current.utteranceId;

      void (async () => {
        let stage: 'stt' | 'llm' = 'stt';
        try {
          const wavBase64 = encodeVadAudioToWavBase64(audio);
          const text = await hooksRef.current.transcribe(wavBase64);
          if (!isCurrentUtterance(utteranceId)) {
            return;
          }
          const trimmed = text.trim();

          // 转写为空 = 误触发/纯噪音，直接回听，不喂 LLM。
          dispatch({ type: 'stt_final', text: trimmed });
          if (!trimmed) {
            dispatch({ type: 'cooldown_elapsed', keepListening: true });
            return;
          }

          // 有文本：进入 thinking，喂 LLM。此时应闭麦（下方 effect 会处理）。
          dispatch({ type: 'llm_started' });
          stage = 'llm';
          const response = await hooksRef.current.submitTranscript(trimmed, utteranceId);
          if (!isCurrentUtterance(utteranceId)) {
            return;
          }
          if (shouldWaitForSpeech(response)) {
            dispatch({ type: 'llm_completed' });
            scheduleSpeechWatchdog(response, utteranceId);
          } else {
            dispatch({ type: 'llm_completed_without_speech' });
            scheduleCooldownRecovery();
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'voice turn failed';
          if (!isCurrentUtterance(utteranceId)) {
            return;
          }
          dispatch(
            stage === 'stt'
              ? { type: 'stt_failed', error: message }
              : { type: 'llm_failed', error: message },
          );
          // 失败后短暂冷却再回听，避免抖动刷屏。
          scheduleCooldownRecovery();
        }
      })();
    },
    [dispatch, isCurrentUtterance, scheduleCooldownRecovery, scheduleSpeechWatchdog],
  );

  const handleMisfire = useCallback(() => {
    // 太短的片段，状态机可能已 vad_open；补一个 close + 回听。
    const current = snapshotRef.current;
    if (current.state === 'speech_detected') {
      dispatch({ type: 'vad_close' });
      dispatch({ type: 'stt_final', text: '' });
      dispatch({ type: 'cooldown_elapsed', keepListening: true });
    }
  }, [dispatch]);

  // ---- 引擎生命周期：随 enabled 开关创建/销毁 ----
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    let localEngine: VadEngine | null = null;

    void (async () => {
      try {
        setEngineError(null);
        const engine = await createSileroVadEngine(
          {
            onSpeechStart: handleSpeechStart,
            onSpeechEnd: handleSpeechEnd,
            onMisfire: handleMisfire,
            onError: (message) => setEngineError(message),
          },
          config.vadOptions,
        );
        if (cancelled) {
          void engine.destroy();
          return;
        }
        localEngine = engine;
        engineRef.current = engine;
        dispatch({ type: 'arm' });
        await engine.start();
        dispatch({ type: 'capture_started' });
        setEngineReady(true);
      } catch (error) {
        if (!cancelled) {
          setEngineError(
            error instanceof Error ? error.message : '语音引擎启动失败（检查麦克风权限）。',
          );
          setEngineReady(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      clearCooldownTimer();
      clearSpeechWatchdogTimer();
      const engine = localEngine ?? engineRef.current;
      engineRef.current = null;
      mutedForSpeechRef.current = false;
      setEngineReady(false);
      if (engine) {
        void engine.destroy();
      }
      dispatch({ type: 'reset' });
    };
    // handleSpeechStart/End/Misfire 用 ref 取最新值，故不入依赖，避免频繁重建引擎。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearCooldownTimer, clearSpeechWatchdogTimer, dispatch, enabled]);

  // ---- 回声防护 vs 插话打断 ----
  // bargeIn 开启（默认，耳机场景）：角色 thinking/speaking 时【不闭麦】，
  //   保持 VAD 常听，这样你一开口 onSpeechStart 就能触发 handleSpeechStart 里的打断逻辑。
  // bargeIn 关闭（外放/无耳机）：退回原回声防护，thinking/speaking 期间闭麦，
  //   避免角色把自己念的 TTS 又听进去、无限自问自答。
  useEffect(() => {
    if (bargeIn) {
      // 插话打断模式：确保引擎处于监听态（若之前被闭麦过则恢复）。
      const engine = engineRef.current;
      if (engine && engineReady && mutedForSpeechRef.current && !engine.isListening()) {
        mutedForSpeechRef.current = false;
        void engine.resume().catch(() => {
          setEngineError('语音监听恢复失败。');
        });
      }
      return;
    }
    const engine = engineRef.current;
    if (!engine || !engineReady) {
      return;
    }
    const shouldMute = snapshot.state === 'thinking' || snapshot.state === 'speaking';
    if (shouldMute && engine.isListening()) {
      mutedForSpeechRef.current = true;
      engine.pause();
    } else if (!shouldMute && mutedForSpeechRef.current && !engine.isListening()) {
      mutedForSpeechRef.current = false;
      void engine.resume().catch(() => {
        setEngineError('语音监听恢复失败。');
      });
    }
  }, [snapshot.state, engineReady, bargeIn]);

  // 外部运行时 WebSocket 收到 speech_completed / speech_failed 时调用：
  // 把正在 speaking 的回合推进到 cooldown，再由计时器回到 listening。
  const notifySpeechCompleted = useCallback(() => {
    const current = snapshotRef.current;
    // 只有确实在说话时才响应，避免乱序事件误推。
    if (current.state !== 'speaking') {
      return;
    }
    clearSpeechWatchdogTimer();
    dispatch({ type: 'speech_completed' });
    scheduleCooldownRecovery();
  }, [clearSpeechWatchdogTimer, dispatch, scheduleCooldownRecovery]);

  return { snapshot, engineReady, engineError, notifySpeechCompleted };
}
