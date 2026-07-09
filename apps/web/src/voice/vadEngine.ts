import { MicVAD, utils } from '@ricky0123/vad-web';

/**
 * VAD 引擎抽象层。
 *
 * 目前只有 Silero（神经 VAD）一种实现，但接口刻意做成可替换：
 * 如果 Silero 在某些机器上有问题，可以在这里再加一个纯音量阈值（RMS）实现，
 * 上层 useVoiceLoop 不需要改动。
 *
 * 离线保证：模型/worklet/wasm 全部从本地 /vad/ 提供，不走 CDN。
 * 资源由 scripts/sync-vad-assets.mjs 在 build/dev 前同步到 public/vad/。
 */

export interface VadEngineCallbacks {
  /** 检测到语音开始（人声起始）。 */
  onSpeechStart: () => void;
  /** 检测到语音结束。audio 是 16kHz 单声道 Float32 PCM（-1..1）。 */
  onSpeechEnd: (audio: Float32Array) => void;
  /** 误触发（太短的片段，不足以构成一句话）。 */
  onMisfire?: () => void;
  /** 引擎级错误。 */
  onError?: (error: string) => void;
}

export interface VadEngineOptions {
  /**
   * 语音判定阈值（0..1）。越高越"确定是人声才触发"，抗噪更强但可能漏掉轻声。
   * Silero v5 默认 0.5 左右比较稳。
   */
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  /**
   * 停顿多少毫秒后判定说完。越大越"等你说完整句"，越小越"话音刚落就切"。
   * 直播场景建议偏大一点（如 400ms），避免把一句话中间的短停顿切碎。
   */
  redemptionMs?: number;
  /** 一段有效语音的最小时长（ms），低于这个数当误触发丢弃（滤掉咳嗽/短杂音）。 */
  minSpeechMs?: number;
  /** 语音起始前多补多少毫秒，避免吃掉句子开头。 */
  preSpeechPadMs?: number;
}

export interface VadEngine {
  /** 开始监听（常驻录音 + VAD）。 */
  start: () => Promise<void>;
  /** 暂停监听（TTS 播放时用来闭麦防回声）。 */
  pause: () => void;
  /** 恢复监听。 */
  resume: () => Promise<void>;
  /** 彻底销毁，释放麦克风。 */
  destroy: () => Promise<void>;
  /** 当前是否在监听。 */
  isListening: () => boolean;
}

const VAD_ASSET_BASE = '/vad/';

/**
 * 把 VAD 给出的 16kHz Float32 PCM 编码成 WAV base64（不含 data: 前缀），
 * 直接可作为 SttTranscribeRequest.audio_base64 发给后端 faster-whisper。
 */
export function encodeVadAudioToWavBase64(audio: Float32Array): string {
  // vad-web 自带的 encodeWAV：采样率固定 16000，单声道。
  const wavBuffer = utils.encodeWAV(audio);
  return utils.arrayBufferToBase64(wavBuffer);
}

/**
 * 创建基于 Silero 的 VAD 引擎。所有资源本地加载，完全离线。
 */
export async function createSileroVadEngine(
  callbacks: VadEngineCallbacks,
  options: VadEngineOptions = {},
): Promise<VadEngine> {
  const vad = await MicVAD.new({
    model: 'v5',
    // 本地离线资源路径
    baseAssetPath: VAD_ASSET_BASE,
    onnxWASMBasePath: VAD_ASSET_BASE,
    // 不在加载后自动开始，由上层显式 start，避免和状态机抢时序
    startOnLoad: false,
    positiveSpeechThreshold: options.positiveSpeechThreshold ?? 0.5,
    negativeSpeechThreshold: options.negativeSpeechThreshold ?? 0.35,
    redemptionMs: options.redemptionMs ?? 400,
    minSpeechMs: options.minSpeechMs ?? 160,
    preSpeechPadMs: options.preSpeechPadMs ?? 120,
    onSpeechStart: () => {
      callbacks.onSpeechStart();
    },
    onSpeechEnd: (audio) => {
      callbacks.onSpeechEnd(audio);
    },
    onVADMisfire: () => {
      callbacks.onMisfire?.();
    },
  });

  let listening = false;

  return {
    start: async () => {
      await vad.start();
      listening = true;
    },
    pause: () => {
      void vad.pause();
      listening = false;
    },
    resume: async () => {
      await vad.start();
      listening = true;
    },
    destroy: async () => {
      listening = false;
      await vad.destroy();
    },
    isListening: () => listening,
  };
}
