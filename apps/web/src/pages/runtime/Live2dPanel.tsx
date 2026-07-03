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
  const refreshLive2d = async () => {
    onLive2dChange(await fetchLive2dState());
  };

  return (
    <article className="card runtime-column">
      <p className="eyebrow">Live2D 状态</p>
      <h3>模型、字幕和表情控制</h3>
      <label className="field">
        <span>字幕</span>
        <input value={subtitleText} onChange={(event) => onSubtitleTextChange(event.target.value)} />
      </label>
      <label className="field">
        <span>表情</span>
        <input value={emotion} onChange={(event) => onEmotionChange(event.target.value)} />
      </label>
      <label className="field">
        <span>缩放</span>
        <input value={modelScale} onChange={(event) => onModelScaleChange(event.target.value)} />
      </label>
      <label className="field">
        <span>X</span>
        <input value={modelX} onChange={(event) => onModelXChange(event.target.value)} />
      </label>
      <label className="field">
        <span>Y</span>
        <input value={modelY} onChange={(event) => onModelYChange(event.target.value)} />
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
        <button
          className="ghost"
          onClick={async () => {
            await updateLive2dConfig({
              scale: Number.parseFloat(modelScale) || 0.25,
              x: Number.parseFloat(modelX) || 0.3,
              y: Number.parseFloat(modelY) || 0.5,
            });
            await refreshLive2d();
          }}
        >
          推送配置
        </button>
      </div>
      <pre>{live2d ? JSON.stringify(live2d, null, 2) : '还没有加载 Live2D 状态。'}</pre>
    </article>
  );
}