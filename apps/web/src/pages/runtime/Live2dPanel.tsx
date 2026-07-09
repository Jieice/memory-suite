import { useEffect, useRef, useState } from 'react';
import type { Live2dStateRecord } from '../../generated/api';
import {
  fetchLive2dState,
  updateLive2dConfig,
  updateLive2dEmotion,
  updateLive2dSubtitle,
} from '../../lib';

type Live2dPanelProps = {
  live2d: Live2dStateRecord | null;
  subtitleText: string;
  emotion: string;
  modelScale: string;
  modelX: string;
  modelY: string;
  onSubtitleTextChange: (text: string) => void;
  onEmotionChange: (emotion: string) => void;
  onModelScaleChange: (scale: string) => void;
  onModelXChange: (x: string) => void;
  onModelYChange: (y: string) => void;
  onLive2dChange: (state: Live2dStateRecord) => void;
};
// 构图预设：一键切换常用直播/桌宠布局。scale/x/y 与 overlay 的 effectiveConfig 语义一致。
// x/y 是画布归一化坐标（0..1），以模型中心为锚点；scale 是相对基准缩放。
const LAYOUT_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
  scale: number;
  x: number;
  y: number;
}> = [
  { id: 'pet', label: '桌宠（小·右下）', hint: '小尺寸靠右下，适合本地浮窗', scale: 0.25, x: 0.8, y: 0.72 },
  { id: 'half', label: '直播半身（居中偏下）', hint: '放大半身入镜，头部留白', scale: 0.62, x: 0.5, y: 0.86 },
  { id: 'full', label: '直播全身（居中）', hint: '整体入镜，垂直居中', scale: 0.4, x: 0.5, y: 0.55 },
];

const SCALE_MIN = 0.05;
const SCALE_MAX = 1.5;
const CONFIG_PUSH_DEBOUNCE_MS = 90;

export function Live2dPanel({
  live2d,
  subtitleText,
  emotion,
  modelScale,
  modelX,
  modelY,
  onSubtitleTextChange,
  onEmotionChange,
  onModelScaleChange,
  onModelXChange,
  onModelYChange,
  onLive2dChange,
}: Live2dPanelProps) {
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清掉未触发的去抖定时器，避免 setState-after-unmount。
  useEffect(() => {
    return () => {
      if (pushTimerRef.current) {
        clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
      }
    };
  }, []);

  const refreshLive2d = async () => {
    onLive2dChange(await fetchLive2dState());
  };

  const parsedScale = Number.parseFloat(modelScale);
  const parsedX = Number.parseFloat(modelX);
  const parsedY = Number.parseFloat(modelY);
  const scaleValue = Number.isFinite(parsedScale) ? parsedScale : 0.25;
  const xValue = Number.isFinite(parsedX) ? parsedX : 0.3;
  const yValue = Number.isFinite(parsedY) ? parsedY : 0.5;

  // 拖动滑块时防抖推送配置：overlay 订阅 live2d_* 事件会实时跟着动，无需额外预览通道。
  const pushConfig = (scale: number, x: number, y: number) => {
    if (pushTimerRef.current) {
      clearTimeout(pushTimerRef.current);
    }
    pushTimerRef.current = setTimeout(() => {
      pushTimerRef.current = null;
      void updateLive2dConfig({ scale, x, y })
        .then((state) => onLive2dChange(state))
        .catch(() => {
          // 拖动中的瞬时失败忽略；松手后的最终值会再推一次。
        });
    }, CONFIG_PUSH_DEBOUNCE_MS);
  };

  const applyScale = (next: number) => {
    const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
    onModelScaleChange(clamped.toFixed(2));
    pushConfig(clamped, xValue, yValue);
  };

  const applyX = (next: number) => {
    const clamped = Math.min(1, Math.max(0, next));
    onModelXChange(clamped.toFixed(2));
    pushConfig(scaleValue, clamped, yValue);
  };

  const applyY = (next: number) => {
    const clamped = Math.min(1, Math.max(0, next));
    onModelYChange(clamped.toFixed(2));
    pushConfig(scaleValue, xValue, clamped);
  };

  const applyPreset = async (preset: (typeof LAYOUT_PRESETS)[number]) => {
    onModelScaleChange(preset.scale.toFixed(2));
    onModelXChange(preset.x.toFixed(2));
    onModelYChange(preset.y.toFixed(2));
    onLive2dChange(await updateLive2dConfig({ scale: preset.scale, x: preset.x, y: preset.y }));
  };

  return (
    <article className="card runtime-column">
      <p className="eyebrow">Live2D 状态</p>
      <h3>模型、字幕和表情控制</h3>

      <div className="live2d-presets">
        <span className="live2d-presets-label">构图预设</span>
        <div className="live2d-preset-buttons">
          {LAYOUT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="ghost"
              title={preset.hint}
              onClick={() => void applyPreset(preset)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <label className="field slider-field">
        <span>
          缩放 <strong>{scaleValue.toFixed(2)}</strong>
        </span>
        <input
          type="range"
          min={SCALE_MIN}
          max={SCALE_MAX}
          step={0.01}
          value={scaleValue}
          onChange={(event) => applyScale(Number.parseFloat(event.target.value))}
        />
      </label>
      <label className="field slider-field">
        <span>
          水平位置 X <strong>{xValue.toFixed(2)}</strong>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={xValue}
          onChange={(event) => applyX(Number.parseFloat(event.target.value))}
        />
      </label>
      <label className="field slider-field">
        <span>
          垂直位置 Y <strong>{yValue.toFixed(2)}</strong>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={yValue}
          onChange={(event) => applyY(Number.parseFloat(event.target.value))}
        />
      </label>

      <label className="field">
        <span>字幕</span>
        <input value={subtitleText} onChange={(event) => onSubtitleTextChange(event.target.value)} />
      </label>
      <label className="field">
        <span>表情</span>
        <input value={emotion} onChange={(event) => onEmotionChange(event.target.value)} />
      </label>

      <div className="actions">
        <button
          onClick={async () => {
            await updateLive2dSubtitle({ text: subtitleText, duration_ms: 2200 });
            await refreshLive2d();
          }}
        >
          推送字幕
        </button>
        <button
          className="ghost"
          onClick={async () => {
            await updateLive2dEmotion({ emotion });
            await refreshLive2d();
          }}
        >
          推送表情
        </button>
      </div>
      <pre>{live2d ? JSON.stringify(live2d, null, 2) : '还没有加载 Live2D 状态。'}</pre>
    </article>
  );
}
