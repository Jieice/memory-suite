import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  RuntimeVisionConfigRecord,
  RuntimeVisionConfigUpdateRequest,
} from '../../generated/api';
import {
  observeVisionFrame,
  testRuntimeVisionConfig,
  updateRuntimeVisionConfig,
} from '../../lib';
import {
  createScreenCaptureEngine,
  type CaptureMode,
  type ScreenCaptureEngine,
} from '../../vision/screenCapture';

export interface VisionDraft {
  enabled: boolean;
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  prompt: string;
  ttlTurns: string;
  timeoutMs: string;
  maxTokens: string;
}

export const emptyVisionDraft: VisionDraft = {
  enabled: false,
  provider: '',
  endpoint: '',
  model: '',
  apiKey: '',
  prompt: '',
  ttlTurns: '',
  timeoutMs: '',
  maxTokens: '',
};

// 供应商预设：本地 VLM 和云端都走 OpenAI 兼容的 /chat/completions image_url 格式，
// 差别只是地址/模型/密钥，所以切换只是填不同的预设值。
const providerPresets: Record<string, Partial<VisionDraft>> = {
  'local-vlm': {
    // Ollama / LM Studio / vLLM 等本地多模态服务，OpenAI 兼容端口。
    endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
    model: 'qwen2.5vl',
  },
  'openai-compatible': {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
  },
};

const CAPTURE_MODES: ReadonlyArray<{ id: CaptureMode; label: string; hint: string }> = [
  { id: 'stream', label: '看自己直播/游戏', hint: '选中你的游戏窗口或直播预览' },
  { id: 'desktop', label: '看操作员桌面', hint: '共享整块屏幕给忆当眼睛' },
  { id: 'monitor', label: '持续监看变化', hint: '只在画面明显变化时才识别，省算力' },
];

// 采样间隔预设（最小间隔，单位毫秒）。持续监看用较长间隔避免刷屏 + 省钱。
const INTERVAL_PRESETS: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 3000, label: '3 秒' },
  { ms: 6000, label: '6 秒' },
  { ms: 12000, label: '12 秒' },
  { ms: 30000, label: '30 秒' },
];

type CapturePhase = 'idle' | 'selecting' | 'running';

export function visionDraftFromRecord(record: RuntimeVisionConfigRecord | null): VisionDraft {
  if (!record) return emptyVisionDraft;
  return {
    enabled: record.enabled,
    provider: record.provider ?? '',
    endpoint: record.endpoint ?? '',
    model: record.model ?? '',
    apiKey: '',
    prompt: record.prompt ?? '',
    ttlTurns: record.ttl_turns != null ? String(record.ttl_turns) : '',
    timeoutMs: record.timeout_ms != null ? String(record.timeout_ms) : '',
    maxTokens: record.max_tokens != null ? String(record.max_tokens) : '',
  };
}

function requestFromDraft(draft: VisionDraft): RuntimeVisionConfigUpdateRequest {
  const num = (value: string) => {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const str = (value: string) => {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };
  return {
    enabled: draft.enabled,
    provider: str(draft.provider),
    endpoint: str(draft.endpoint),
    model: str(draft.model),
    // 留空 = 不修改，后端保留原密钥。这里发 null。
    api_key: str(draft.apiKey),
    prompt: str(draft.prompt),
    ttl_turns: num(draft.ttlTurns),
    timeout_ms: num(draft.timeoutMs),
    max_tokens: num(draft.maxTokens),
  };
}

// 配置 draft 和 record 由父组件 SettingsPage 持有（与 llm/tts/stt 一致），
// 这样切到别的标签页再切回来（面板会 unmount/remount）时未保存的编辑不会丢。
// 采集运行态（phase/engine/帧计数）仍留在面板本地——它本就该在离开时停掉、
// 回来重开，engine 也必须随卸载释放屏幕流。
export function ScreenVisionPanel({
  vision,
  setVision,
  draft,
  setDraft,
}: {
  vision: RuntimeVisionConfigRecord | null;
  setVision: (record: RuntimeVisionConfigRecord | null) => void;
  draft: VisionDraft;
  setDraft: Dispatch<SetStateAction<VisionDraft>>;
}) {
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const [captureMode, setCaptureMode] = useState<CaptureMode>('stream');
  const [intervalMs, setIntervalMs] = useState(6000);
  const [capturePhase, setCapturePhase] = useState<CapturePhase>('idle');
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const [lastDescription, setLastDescription] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);

  const engineRef = useRef<ScreenCaptureEngine | null>(null);
  const hasCloudKey = Boolean(vision?.api_key);
  const capturing = capturePhase !== 'idle';
  const captureModeInfo = CAPTURE_MODES.find((mode) => mode.id === captureMode) ?? CAPTURE_MODES[0];
  const intervalLabel =
    INTERVAL_PRESETS.find((preset) => preset.ms === intervalMs)?.label ?? `${Math.round(intervalMs / 1000)} 秒`;
  const capturePhaseLabel =
    capturePhase === 'selecting'
      ? '等待选择窗口'
      : capturePhase === 'running'
        ? '采集中'
        : '未采集';
  const configStatusTone =
    status && /失败|错误|未配置|401|403|invalid|Invalid/i.test(status) ? 'error' : 'success';

  // 配置由父组件在进入配置中心时统一拉取（refreshRuntimeConfig），面板不再自己
  // 拉——否则每次切回来都会用后端值覆盖未保存的编辑，正是「切页就没了」的根因。

  // 卸载时确保停止采集，释放屏幕流。
  useEffect(() => {
    return () => {
      engineRef.current?.stop();
      engineRef.current = null;
    };
  }, []);

  const applyProviderPreset = (provider: string) => {
    const preset = providerPresets[provider];
    setDraft((prev) => ({
      ...prev,
      provider,
      endpoint: preset?.endpoint ?? prev.endpoint,
      model: preset?.model ?? prev.model,
    }));
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const snapshot = await updateRuntimeVisionConfig(requestFromDraft(draft));
      setVision(snapshot.vision);
      setDraft((prev) => ({ ...visionDraftFromRecord(snapshot.vision), apiKey: '' }));
      setStatus('已保存视觉配置。');
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setStatus(null);
    try {
      const result = await testRuntimeVisionConfig(requestFromDraft(draft));
      if (result.ok) {
        const preview = result.description_preview?.trim();
        setStatus(
          `连通成功（${result.latency_ms ?? '?'}ms）：${preview || result.message || '模型已响应'}`,
        );
      } else {
        setStatus(`连通失败：${result.message}`);
      }
    } catch (error) {
      setStatus(`测试失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleFrame = useCallback(async (imageBase64: string, mode: CaptureMode) => {
    try {
      const result = await observeVisionFrame({
        image_base64: imageBase64,
        mime_type: 'image/jpeg',
        mode,
        apply_to_scene: true,
      });
      if (result.ok) {
        setFrameCount((count) => count + 1);
        const description = result.description.trim();
        if (description) {
          setCaptureError(null);
          setCaptureNotice(result.applied ? '已写入场景上下文，下一轮聊天会带上画面描述。' : '已识别，未写入场景上下文。');
          setLastDescription(description);
        } else {
          setCaptureNotice(null);
          setCaptureError(result.message || '模型已响应，但没有返回可用画面描述。');
        }
      } else {
        setCaptureNotice(null);
        setCaptureError(result.message);
      }
    } catch (error) {
      setCaptureNotice(null);
      setCaptureError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const startCapture = async () => {
    setCaptureError(null);
    setCaptureNotice(null);
    if (!draft.enabled) {
      setCaptureError('请先启用并保存视觉识别（enabled）。');
      return;
    }
    if (!draft.endpoint.trim()) {
      setCaptureError('请先填写并保存视觉模型地址。');
      return;
    }
    // 用 pending 态让按钮立刻有反馈，避免「不知道点了没」。
    setCapturePhase('selecting');
    setFrameCount(0);
    setSkippedCount(0);
    setLastDescription(null);
    const engine = createScreenCaptureEngine(
      {
        onFrame: handleFrame,
        onSkip: () => setSkippedCount((count) => count + 1),
        onError: (message) => {
          setCaptureError(message);
          setCaptureNotice(null);
          setCapturePhase('idle');
          // 引擎在 tick 报错时不会自己停，必须显式 stop 释放屏幕流，
          // 否则系统的「正在共享」指示会一直亮着。
          engineRef.current?.stop();
          engineRef.current = null;
        },
        onStreamEnded: () => {
          setCapturePhase('idle');
          engineRef.current = null;
        },
      },
      {
        mode: captureMode,
        intervalMs,
        // monitor 模式启用帧差门控：只有画面变化超过阈值才发识别请求。
        diffGating: captureMode === 'monitor',
      },
    );
    try {
      await engine.start();
      if (!engine.isRunning()) {
        engineRef.current = null;
        setCapturePhase('idle');
        return;
      }
      engineRef.current = engine;
      setCapturePhase('running');
      setCaptureNotice('采集已开始，第一帧识别完成后会显示画面描述。');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCapturePhase('idle');
      // 用户在系统弹窗里取消选源 —— 静默，不当错误。
      if (!/permission|cancel|abort|notallowed/i.test(message)) {
        setCaptureError(message);
      }
    }
  };

  const stopCapture = () => {
    engineRef.current?.stop();
    engineRef.current = null;
    setCapturePhase('idle');
    setCaptureError(null);
    setCaptureNotice('采集已停止。');
  };

  return (
    <div className="config-panel">
      <section className="config-block">
        <h4>屏幕识别 · 让忆看见画面</h4>
        <p className="muted-copy">
          定期把屏幕画面交给视觉模型，产出一句话描述，写进场景上下文，忆的每轮回复都会据此反应。
          本地 VLM 和云端模型都走 OpenAI 兼容格式，填不同地址即可切换。
        </p>

        <label className="config-row toggle-row">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft((prev) => ({ ...prev, enabled: event.target.checked }))}
          />
          <span>启用屏幕识别</span>
        </label>

        <div className="config-row">
          <span className="config-label">供应商预设</span>
          <div className="chip-row">
            <button
              type="button"
              className={`dashboard-chip ${draft.provider === 'local-vlm' ? 'active' : ''}`}
              aria-pressed={draft.provider === 'local-vlm'}
              onClick={() => applyProviderPreset('local-vlm')}
            >
              本地 VLM
            </button>
            <button
              type="button"
              className={`dashboard-chip ${draft.provider === 'openai-compatible' ? 'active' : ''}`}
              aria-pressed={draft.provider === 'openai-compatible'}
              onClick={() => applyProviderPreset('openai-compatible')}
            >
              云端（OpenAI 兼容）
            </button>
          </div>
        </div>

        <label className="config-row">
          <span className="config-label">模型地址</span>
          <input
            type="text"
            value={draft.endpoint}
            placeholder="http://127.0.0.1:11434/v1/chat/completions"
            onChange={(event) => setDraft((prev) => ({ ...prev, endpoint: event.target.value }))}
          />
        </label>

        <label className="config-row">
          <span className="config-label">模型名</span>
          <input
            type="text"
            value={draft.model}
            placeholder="qwen2.5vl / gpt-4o-mini"
            onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))}
          />
        </label>

        <label className="config-row">
          <span className="config-label">API Key</span>
          <input
            type="password"
            value={draft.apiKey}
            placeholder={hasCloudKey ? '已保存，留空则不修改' : '本地服务通常留空'}
            onChange={(event) => setDraft((prev) => ({ ...prev, apiKey: event.target.value }))}
          />
        </label>

        <label className="config-row">
          <span className="config-label">识别指令</span>
          <textarea
            rows={2}
            value={draft.prompt}
            placeholder="留空使用内置指令：一句中文口语描述画面里最值得吐槽的点"
            onChange={(event) => setDraft((prev) => ({ ...prev, prompt: event.target.value }))}
          />
        </label>

        <div className="config-row triple">
          <label>
            <span className="config-label">上下文保留轮数</span>
            <input
              type="number"
              min={1}
              max={30}
              value={draft.ttlTurns}
              placeholder="3"
              onChange={(event) => setDraft((prev) => ({ ...prev, ttlTurns: event.target.value }))}
            />
          </label>
          <label>
            <span className="config-label">超时(ms)</span>
            <input
              type="number"
              value={draft.timeoutMs}
              placeholder="20000"
              onChange={(event) => setDraft((prev) => ({ ...prev, timeoutMs: event.target.value }))}
            />
          </label>
          <label>
            <span className="config-label">描述最大 tokens</span>
            <input
              type="number"
              value={draft.maxTokens}
              placeholder="200"
              onChange={(event) => setDraft((prev) => ({ ...prev, maxTokens: event.target.value }))}
            />
          </label>
        </div>

        <div className="config-actions">
          <button type="button" onClick={() => void save()} disabled={saving || testing}>
            {saving ? '保存中…' : '保存配置'}
          </button>
          <button type="button" className="ghost" onClick={() => void runTest()} disabled={saving || testing}>
            {testing ? '测试中…' : '连通测试'}
          </button>
        </div>
        {status && <p className={`config-status ${configStatusTone}`}>{status}</p>}
      </section>

      <section className="config-block">
        <h4>实时采集</h4>
        <p className="muted-copy">
          采集在这个界面里进行，停留在本页时生效。切走或关闭窗口会自动停止。
        </p>

        <div className={`vision-capture-summary ${capturePhase}`}>
          <span>{capturePhaseLabel}</span>
          <strong>{captureModeInfo.label}</strong>
          <small>间隔 {intervalLabel}</small>
        </div>

        <div className="config-row">
          <span className="config-label">采集模式</span>
          <div className="chip-row">
            {CAPTURE_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                title={mode.hint}
                className={`dashboard-chip ${captureMode === mode.id ? 'active' : ''}`}
                aria-pressed={captureMode === mode.id}
                onClick={() => setCaptureMode(mode.id)}
                disabled={capturing}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <small className="setting-hint">{captureModeInfo.hint}</small>
        </div>

        <div className="config-row">
          <span className="config-label">最小识别间隔</span>
          <div className="chip-row">
            {INTERVAL_PRESETS.map((preset) => (
              <button
                key={preset.ms}
                type="button"
                className={`dashboard-chip ${intervalMs === preset.ms ? 'active' : ''}`}
                aria-pressed={intervalMs === preset.ms}
                onClick={() => setIntervalMs(preset.ms)}
                disabled={capturing}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <small className="setting-hint">当前最小间隔：{intervalLabel}</small>
        </div>

        <div className="config-actions">
          {capturing ? (
            <button type="button" onClick={stopCapture}>
              停止采集
            </button>
          ) : (
            <button type="button" onClick={() => void startCapture()}>
              开始采集
            </button>
          )}
        </div>

        {captureError && <p className="config-status error">{captureError}</p>}
        {captureNotice && <p className="config-status success">{captureNotice}</p>}

        {capturing && (
          <p className="muted-copy">
            采集中 · 已识别 {frameCount} 帧
            {skippedCount > 0 ? ` · 跳过 ${skippedCount} 帧（画面无明显变化）` : ''}
          </p>
        )}

        {lastDescription && (
          <div className="vision-description-preview">
            <span className="config-label">最近一次画面描述</span>
            <p>{lastDescription}</p>
          </div>
        )}
      </section>
    </div>
  );
}
