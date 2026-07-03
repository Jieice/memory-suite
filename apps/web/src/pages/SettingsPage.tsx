import { useMemo, useState } from 'react';
import { loadUiPreferences, updateUiPreferences } from '../preferences';
import type { ThemeMode, UiPreferences } from '../preferences';

type ConfigKey =
  | 'llm'
  | 'tts'
  | 'asr'
  | 'vision'
  | 'live2d'
  | 'danmaku'
  | 'appearance'
  | 'base'
  | 'features'
  | 'plugins'
  | 'persona'
  | 'memory'
  | 'todo'
  | 'diary'
  | 'proactive'
  | 'live'
  | 'security';

interface ConfigSection {
  key: ConfigKey;
  label: string;
  status?: 'ready' | 'idle';
}

const sections: ConfigSection[] = [
  { key: 'llm', label: 'LLM 配置', status: 'ready' },
  { key: 'tts', label: 'TTS 配置', status: 'ready' },
  { key: 'asr', label: 'ASR 配置', status: 'ready' },
  { key: 'vision', label: '视觉模块', status: 'ready' },
  { key: 'live2d', label: 'Live2D 浮窗', status: 'ready' },
  { key: 'danmaku', label: '弹幕接入', status: 'ready' },
  { key: 'appearance', label: '外观设置' },
  { key: 'base', label: '基础设置' },
  { key: 'features', label: '功能开关' },
  { key: 'plugins', label: '插件' },
  { key: 'persona', label: '人设' },
  { key: 'memory', label: '记忆' },
  { key: 'todo', label: '待办' },
  { key: 'diary', label: '日记' },
  { key: 'proactive', label: '主动消息' },
  { key: 'live', label: '直播模式' },
  { key: 'security', label: '安全权限' },
];

export function SettingsPage() {
  const [activeKey, setActiveKey] = useState<ConfigKey>('llm');
  const [preferences, setPreferences] = useState(loadUiPreferences);
  const activeSection = useMemo(
    () => sections.find((section) => section.key === activeKey) ?? sections[0],
    [activeKey],
  );
  const patchPreferences = (patch: Partial<UiPreferences>) => {
    setPreferences(updateUiPreferences(patch));
  };

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">配置中心</p>
        <h2>把运行参数集中到一个地方</h2>
        <p className="page-copy">
          这里先搭好桌面端配置工作台：模型、语音、视觉、人设、记忆和直播相关开关都可以从左侧快速切换。
        </p>
      </header>

      <section className="settings-layout">
        <aside className="settings-sidebar">
          <div className="settings-section-list">
            {sections.map((section) => (
              <button
                key={section.key}
                className={`settings-tab${section.key === activeKey ? ' active' : ''}`}
                onClick={() => setActiveKey(section.key)}
              >
                <span>{section.label}</span>
                {section.status ? <i aria-hidden="true" /> : null}
              </button>
            ))}
          </div>

          <div className="settings-sidebar-footer">
            <label className="field compact-field">
              <span>昼夜模式</span>
              <select
                value={preferences.themeMode}
                onChange={(event) => patchPreferences({ themeMode: event.target.value as ThemeMode })}
              >
                <option>日间</option>
                <option>夜间</option>
                <option>跟随系统</option>
              </select>
            </label>
            <label className="check-row">
              <span>开发者模式</span>
              <input
                type="checkbox"
                checked={preferences.developerMode}
                onChange={(event) => patchPreferences({ developerMode: event.target.checked })}
              />
            </label>
          </div>
        </aside>

        <div className="settings-content">
          <article className="card emphasis">
            <div className="card-heading">
              <div>
                <p className="eyebrow">{activeSection.label}</p>
                <h3>{panelTitle(activeSection.key)}</h3>
              </div>
              <span className="status-pill">{preferences.developerMode ? '开发者视图' : '常规视图'}</span>
            </div>
            <SettingsPanel
              section={activeSection.key}
              preferences={preferences}
              patchPreferences={patchPreferences}
            />
          </article>
        </div>
      </section>
    </section>
  );
}

function SettingsPanel({
  section,
  preferences,
  patchPreferences,
}: {
  section: ConfigKey;
  preferences: UiPreferences;
  patchPreferences: (patch: Partial<UiPreferences>) => void;
}) {
  switch (section) {
    case 'llm':
      return (
        <div className="settings-form">
          <SettingSelect label="主模型" options={['deepseek-chat', 'openai-compatible', 'local-llm']} />
          <SettingSelect label="备用模型" options={['builtin-fallback', 'deepseek-chat', '关闭']} />
          <SettingInput label="API 地址" value="https://api.deepseek.com" />
          <SettingInput label="模型超时" value="35 s" />
          <SettingInput label="温度" value="0.75" />
          <SettingInput label="最大输出" value="900 tokens" />
          <SettingToggle label="启用兜底回复" checked />
          <SettingToggle label="记录延迟分解" checked />
        </div>
      );
    case 'tts':
      return (
        <div className="settings-form">
          <SettingSelect label="语音引擎" options={['edge-tts', 'sovits', 'mock']} />
          <SettingInput label="默认音色" value="zh-CN-XiaoxiaoNeural" />
          <SettingInput label="语速" value="+0%" />
          <SettingInput label="音调" value="+0Hz" />
          <SettingInput label="音频缓存" value="runtime/audio-cache" />
          <SettingInput label="播放延迟补偿" value="120 ms" />
          <SettingToggle label="生成 Live2D 口型" checked />
          <SettingToggle label="播放失败时保留字幕" checked />
        </div>
      );
    case 'asr':
      return (
        <div className="settings-form">
          <SettingSelect label="识别模式" options={['关闭', '本地唤醒', '持续监听']} />
          <SettingInput label="输入设备" value="默认麦克风" />
          <SettingInput label="唤醒词" value="忆，听我说" />
          <SettingInput label="静音阈值" value="-42 dB" />
          <SettingToggle label="过滤背景噪声" checked />
          <SettingToggle label="只在直播模式启用" />
        </div>
      );
    case 'vision':
      return (
        <div className="settings-form">
          <SettingSelect label="视觉来源" options={['关闭', '屏幕捕获', '摄像头', 'OBS 截图']} />
          <SettingInput label="采样间隔" value="5 s" />
          <SettingInput label="画面裁剪" value="全屏" />
          <SettingInput label="最大分辨率" value="1280 px" />
          <SettingToggle label="允许场景理解" checked />
          <SettingToggle label="忽略隐私窗口" checked />
        </div>
      );
    case 'live2d':
      return (
        <div className="settings-form">
          <SettingInput label="模型文件" value="hiyori_pro_t11.model3.json" />
          <SettingInput label="资源目录" value="Liver2d/hiyori_zh-Hans/hiyori_pro/runtime" />
          <SettingInput label="窗口尺寸" value="420 x 780" />
          <SettingInput label="舞台位置" value="scale 0.25 / x 0.30 / y 0.50" />
          <SettingSelect label="置顶级别" options={['始终置顶', '普通窗口', '跟随主窗']} />
          <SettingToggle label="启动时显示透明浮窗" checked />
          <SettingToggle label="允许鼠标穿透快捷切换" checked />
          <SettingToggle label="拖动角色后保存位置" checked />
        </div>
      );
    case 'danmaku':
      return (
        <div className="settings-form">
          <SettingInput label="房间 ID" value="556677" />
          <SettingInput label="UID" value="1024" />
          <SettingInput label="Buvid" value="memory-suite-buvid" />
          <SettingInput label="连接模式" value="native_websocket（Rust 直连）" />
          <SettingSelect label="签名模式" options={['cookie', 'anonymous', 'stored']} />
          <SettingInput label="重连间隔" value="3 s / 8 s / 20 s" />
          <SettingToggle label="断线自动重连" checked />
          <SettingToggle label="弹幕触发聊天回复" checked />
        </div>
      );
    case 'appearance':
      return (
        <div className="settings-form">
          <SettingSelect
            label="主题"
            options={['日间', '夜间', '跟随系统']}
            value={preferences.themeMode}
            onChange={(value) => patchPreferences({ themeMode: value as ThemeMode })}
          />
          <SettingSelect label="界面密度" options={['标准', '紧凑', '触控']} />
          <SettingInput label="Live2D 缩放" value="0.25" />
          <SettingToggle
            label="精简主导航"
            checked={preferences.compactNavigation}
            onChange={(checked) => patchPreferences({ compactNavigation: checked })}
          />
        </div>
      );
    case 'base':
      return (
        <div className="settings-form">
          <SettingInput label="后端地址" value="http://127.0.0.1:8080" />
          <SettingInput label="备用端口" value="18080-18085" />
          <SettingInput label="数据库" value="runtime/memory-suite.db" />
          <SettingInput label="窗口状态" value="runtime/electron-window-state.json" />
          <SettingToggle label="启动时自动选择可用端口" checked />
          <SettingToggle label="启动时执行健康检查" checked />
        </div>
      );
    case 'features':
      return (
        <div className="settings-form">
          <SettingToggle label="显示开发入口" checked={preferences.developerMode} onChange={(checked) => patchPreferences({ developerMode: checked })} />
          <SettingToggle label="精简主导航" checked={preferences.compactNavigation} onChange={(checked) => patchPreferences({ compactNavigation: checked })} />
          <SettingToggle label="保留训练页面" checked={preferences.developerMode} onChange={(checked) => patchPreferences({ developerMode: checked })} />
          <SettingToggle label="保留工具执行页面" checked={preferences.developerMode} onChange={(checked) => patchPreferences({ developerMode: checked })} />
          <SettingToggle label="显示 OBS 浮层入口" checked />
          <SettingToggle label="显示知识库入口" checked />
          <SettingToggle label="启用主动消息模块" checked />
          <SettingToggle label="启用日记模块" />
        </div>
      );
    case 'plugins':
      return (
        <div className="settings-form">
          <SettingToggle label="启用工具注册表" checked />
          <SettingToggle label="允许本地脚本工具" checked />
          <SettingInput label="插件目录" value="data/tools" />
          <SettingInput label="执行超时" value="30 s" />
          <SettingSelect label="权限级别" options={['只读', '本地执行', '开发者']} />
        </div>
      );
    case 'persona':
      return (
        <div className="settings-form">
          <SettingSelect label="互动模式" options={['stream', 'chat', 'idle']} />
          <SettingSelect label="语气档案" options={['balanced', 'sharp-playful', 'gentle', 'cold']} />
          <SettingInput label="温度 / 吐槽 / 自主" value="0.80 / 0.35 / 0.60" />
          <SettingInput label="当前场景" value="warmup" />
          <SettingInput label="当前心情" value="curious" />
          <SettingToggle label="保持人设一致性" checked />
        </div>
      );
    case 'memory':
      return (
        <div className="settings-form">
          <SettingToggle label="启用长期记忆" checked />
          <SettingInput label="会话总结间隔" value="10 条消息" />
          <SettingInput label="记忆库路径" value="data/memories" />
          <SettingInput label="召回数量" value="8" />
          <SettingToggle label="保存用户关系" checked />
          <SettingToggle label="保存场景总结" checked />
        </div>
      );
    case 'todo':
      return (
        <div className="settings-form">
          <SettingToggle label="识别待办事项" checked />
          <SettingInput label="默认提醒提前量" value="10 min" />
          <SettingInput label="最多待办数" value="24" />
          <SettingSelect label="展示位置" options={['运行台', '创作者聊天', '关闭']} />
        </div>
      );
    case 'diary':
      return (
        <div className="settings-form">
          <SettingToggle label="自动生成日记" />
          <SettingInput label="生成时间" value="23:30" />
          <SettingInput label="日记保留数量" value="30" />
          <SettingSelect label="语气" options={['轻松', '记录型', '吐槽型']} />
          <SettingToggle label="同步到知识库" />
        </div>
      );
    case 'proactive':
      return (
        <div className="settings-form">
          <SettingToggle label="允许主动消息" checked />
          <SettingInput label="最短间隔" value="60 s" />
          <SettingInput label="冷却上限" value="10 min" />
          <SettingSelect label="触发来源" options={['空闲', '场景变化', '高光事件', '全部']} />
          <SettingToggle label="避免打断用户输入" checked />
        </div>
      );
    case 'live':
      return (
        <div className="settings-form">
          <SettingSelect label="直播状态" options={['准备中', '开播', '休息', '收尾']} />
          <SettingInput label="B 站房间号" value="556677" />
          <SettingInput label="节目段落" value="tech_talk / casual_chat / quiz / roast" />
          <SettingInput label="开场提示" value="今天从运行状态自检开始。" />
          <SettingToggle label="开播前执行 readiness 检查" checked />
          <SettingToggle label="开播后自动连接弹幕" checked />
        </div>
      );
    case 'security':
      return (
        <div className="settings-form">
          <SettingToggle label="隐藏 Cookie 明文" checked />
          <SettingToggle label="工具执行需要开发者模式" checked />
          <SettingToggle label="外部链接用系统浏览器打开" checked />
          <SettingInput label="敏感字段" value="API key / Cookie / SESSDATA" />
          <SettingSelect label="日志级别" options={['info', 'debug', 'warn', 'error']} />
          <SettingInput label="日志保留" value="7 days" />
        </div>
      );
  }
}

function panelTitle(section: ConfigKey): string {
  const titles: Record<ConfigKey, string> = {
    llm: '模型供应商、温度和兜底策略',
    tts: '语音引擎、音色和口型生成',
    asr: '语音识别与输入设备',
    vision: '屏幕、摄像头和场景理解',
    live2d: '透明浮窗、模型路径和舞台位置',
    danmaku: 'B 站房间、签名和重连策略',
    appearance: '主题、浮窗和 Live2D 显示',
    base: '后端地址、端口和启动策略',
    features: '常用入口、开发入口和低频模块',
    plugins: '工具、插件和本地脚本能力',
    persona: '模式、语气和角色行为',
    memory: '长期记忆、总结和存储路径',
    todo: '待办识别与提醒展示',
    diary: '日记生成与保留策略',
    proactive: '主动发言的节奏与触发',
    live: '直播状态、房间和开播门禁',
    security: '敏感字段、工具权限和日志策略',
  };
  return titles[section];
}

function SettingInput({ label, value }: { label: string; value: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} readOnly />
    </label>
  );
}

function SettingSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={value}
        defaultValue={value ? undefined : options[0]}
        onChange={(event) => onChange?.(event.target.value)}
        disabled={!onChange}
      >
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function SettingToggle({
  label,
  checked = false,
  onChange,
}: {
  label: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label className="check-row wide">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange?.(event.target.checked)}
        readOnly={!onChange}
      />
    </label>
  );
}
