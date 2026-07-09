/**
 * 屏幕识别采集引擎。
 *
 * 职责：拿到一路屏幕/窗口视频流，按节流间隔抓帧，只在画面发生「明显变化」
 * 时把降采样后的 JPEG 发给后端 /api/vision/observe。视觉调用很贵（一次几百 ms
 * 到几秒），所以两道闸门缺一不可：
 *   1. 最小间隔节流（intervalMs）——再怎么变也不会比这个更频繁。
 *   2. 帧差门控（diffThreshold）——画面基本没动就跳过，省钱省算力。
 *
 * 三种模式（都走同一套采集，只是流来源和给后端的 mode 提示不同）：
 *   - stream：看自己的直播/游戏画面（用户在系统弹窗里挑对应窗口）
 *   - desktop / monitor：看操作员整块桌面（挑「整个屏幕」）
 *
 * 采集用标准 getDisplayMedia，浏览器 dev 和 Electron 都能用（Electron 侧
 * 需要主进程挂 display-media 请求处理器，见 apps/electron/main.cjs）。
 */

export type CaptureMode = 'stream' | 'desktop' | 'monitor';

export interface ScreenCaptureOptions {
  /** 给后端的画面来源提示，影响描述提示词。 */
  mode: CaptureMode;
  /** 两次「送去识别」之间的最小间隔（ms）。默认 6000。 */
  intervalMs?: number;
  /**
   * 是否启用帧差门控。开启后，画面相较上一帧变化不足 diffThreshold 就跳过，
   * 只在「持续监看」模式下有意义（省算力）。stream/desktop 模式通常关掉，
   * 每到间隔就识别一次。默认 false。
   */
  diffGating?: boolean;
  /** 帧差阈值（0..1）。归一化平均像素差超过它才算「变了」。默认 0.06。 */
  diffThreshold?: number;
  /** 降采样后最长边像素。默认 768，和后端提示一致。 */
  maxEdgePx?: number;
  /** JPEG 质量（0..1）。默认 0.6，够视觉模型看清且体积小。 */
  jpegQuality?: number;
}

export interface ScreenCaptureCallbacks {
  /** 有一帧「变化够大」需要送识别时回调，返回不含 data: 前缀的 JPEG base64。 */
  onFrame: (imageBase64: string, mode: CaptureMode) => void | Promise<void>;
  /** 帧差门控判定「画面基本没动」而跳过一次采样时回调（用于统计展示）。 */
  onSkip?: () => void;
  /** 用户在系统弹窗里取消选源，或流被外部结束（点了「停止共享」）。 */
  onStreamEnded?: () => void;
  /** 引擎级错误（拿流失败、抓帧异常等）。 */
  onError?: (error: string) => void;
}

export interface ScreenCaptureEngine {
  /** 弹出选源对话框并开始采集循环。 */
  start: () => Promise<void>;
  /** 停止采集并释放屏幕流。 */
  stop: () => void;
  /** 当前是否在采集。 */
  isRunning: () => boolean;
}

/**
 * 把一帧视频画到离屏 canvas，降采样到 maxEdgePx，返回 {缩略数据, JPEG base64}。
 * 缩略数据用于帧差比较（低分辨率灰度足矣），JPEG 用于真正上送。
 */
interface SampledFrame {
  /** 用于帧差的低分辨率灰度采样（固定 32x32）。 */
  diffSample: Uint8ClampedArray;
  /** 送识别的 JPEG base64（不含 data: 前缀）。 */
  jpegBase64: string;
}

const DIFF_GRID = 32; // 32x32 灰度缩略，帧差比较用，够灵敏又极省。

type ScreenCaptureSourceType = 'screen' | 'window';

export function createScreenCaptureEngine(
  callbacks: ScreenCaptureCallbacks,
  options: ScreenCaptureOptions,
): ScreenCaptureEngine {
  const intervalMs = Math.max(1500, options.intervalMs ?? 6000);
  const diffThreshold = clamp01(options.diffThreshold ?? 0.06);
  const maxEdgePx = Math.max(256, options.maxEdgePx ?? 768);
  const jpegQuality = clamp01(options.jpegQuality ?? 0.6);
  const mode = options.mode;
  const diffGating = options.diffGating ?? false;

  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let frameCanvas: HTMLCanvasElement | null = null;
  let diffCanvas: HTMLCanvasElement | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastDiffSample: Uint8ClampedArray | null = null;
  let ticking = false;

  const cleanup = () => {
    running = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
    if (video) {
      video.srcObject = null;
      video = null;
    }
    frameCanvas = null;
    diffCanvas = null;
    lastDiffSample = null;
  };

  const sampleFrame = (): SampledFrame | null => {
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(1, maxEdgePx / Math.max(vw, vh));
    const dw = Math.max(1, Math.round(vw * scale));
    const dh = Math.max(1, Math.round(vh * scale));

    if (!frameCanvas) {
      frameCanvas = document.createElement('canvas');
    }
    frameCanvas.width = dw;
    frameCanvas.height = dh;
    const fctx = frameCanvas.getContext('2d');
    if (!fctx) return null;
    fctx.drawImage(video, 0, 0, dw, dh);
    const dataUrl = frameCanvas.toDataURL('image/jpeg', jpegQuality);
    const jpegBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);

    // 帧差缩略：固定 32x32 灰度。
    if (!diffCanvas) {
      diffCanvas = document.createElement('canvas');
      diffCanvas.width = DIFF_GRID;
      diffCanvas.height = DIFF_GRID;
    }
    const dctx = diffCanvas.getContext('2d', { willReadFrequently: true });
    if (!dctx) return null;
    dctx.drawImage(video, 0, 0, DIFF_GRID, DIFF_GRID);
    const rgba = dctx.getImageData(0, 0, DIFF_GRID, DIFF_GRID).data;
    const gray = new Uint8ClampedArray(DIFF_GRID * DIFF_GRID);
    for (let i = 0; i < gray.length; i += 1) {
      const r = rgba[i * 4];
      const g = rgba[i * 4 + 1];
      const b = rgba[i * 4 + 2];
      // 感知亮度权重。
      gray[i] = (r * 0.299 + g * 0.587 + b * 0.114) as number;
    }
    return { diffSample: gray, jpegBase64 };
  };

  /** 归一化平均像素差（0..1）。 */
  const frameDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
    if (a.length !== b.length || a.length === 0) return 1;
    let total = 0;
    for (let i = 0; i < a.length; i += 1) {
      total += Math.abs(a[i] - b[i]);
    }
    return total / (a.length * 255);
  };

  const preferredSourceTypes = (): ScreenCaptureSourceType[] => {
    return mode === 'stream' ? ['window', 'screen'] : ['screen', 'window'];
  };

  const prepareElectronCapture = async () => {
    const setPreferredSourceTypes = window.memorySuiteScreenCapture?.setPreferredSourceTypes;
    if (!setPreferredSourceTypes) {
      return;
    }
    await setPreferredSourceTypes(preferredSourceTypes());
  };

  const tick = async () => {
    if (!running || ticking) return;
    ticking = true;
    try {
      const sampled = sampleFrame();
      if (!sampled) return;
      // 帧差门控只在开启时生效（持续监看模式）。其余模式每到间隔就送识别。
      if (diffGating) {
        const changed =
          lastDiffSample === null || frameDiff(lastDiffSample, sampled.diffSample) >= diffThreshold;
        if (!changed) {
          callbacks.onSkip?.();
          return;
        }
      }
      lastDiffSample = sampled.diffSample;
      await callbacks.onFrame(sampled.jpegBase64, mode);
    } catch (error) {
      callbacks.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      ticking = false;
    }
  };

  return {
    start: async () => {
      if (running) return;
      try {
        await prepareElectronCapture();
        // 约束保持最宽松：帧率由 setInterval 控制，音频不参与视觉识别。
        // Electron 桌面壳会在主进程里根据模式选择 screen/window source。
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
        });
      } catch (error) {
        // 用户取消选源也会走到这里，视为正常结束而非报错。
        const message = error instanceof Error ? error.message : String(error);
        if (/Permission denied|NotAllowed|cancel/i.test(message)) {
          callbacks.onStreamEnded?.();
        } else if (/Invalid capture constraints/i.test(message)) {
          callbacks.onError?.('屏幕采集约束无效。请关闭并重新启动桌面壳后再试；如果仍失败，使用 debug-start.bat 查看 Electron 日志。');
        } else {
          callbacks.onError?.(message);
        }
        cleanup();
        return;
      }

      // 用户在系统 UI 点「停止共享」时结束采集。
      const [track] = stream.getVideoTracks();
      if (track) {
        track.addEventListener('ended', () => {
          if (running) {
            cleanup();
            callbacks.onStreamEnded?.();
          }
        });
      }

      video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      await video.play().catch(() => {
        // 自动播放偶发失败不致命，抓帧时会再检查 videoWidth。
      });

      running = true;
      // 立刻抓一帧建立基线，之后按间隔轮询。
      void tick();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop: () => {
      cleanup();
    },
    isRunning: () => running,
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
