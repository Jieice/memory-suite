import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  Live2dLocalVisibilityMode,
  MemorySuiteLive2dShellState,
} from '../electron-shell';
import type { KnowledgeCatalogResponse, RuntimeConfigSnapshot } from '../generated/api';
import {
  fetchKnowledgeCatalog,
  fetchRuntimeConfig,
  testRuntimeLlmConfig,
  testRuntimeSttConfig,
  testRuntimeTtsConfig,
  updateRuntimeLlmConfig,
  updateRuntimeSttConfig,
  updateRuntimeTtsConfig,
} from '../lib';
import { loadUiPreferences, updateUiPreferences } from '../preferences';
import type { ThemeMode, UiPreferences } from '../preferences';

type ConfigKey =
  | 'base'
  | 'llm'
  | 'tts'
  | 'stt'
  | 'live2d'
  | 'danmaku'
  | 'appearance'
  | 'persona'
  | 'memory'
  | 'live'
  | 'security';

type GroupKey = 'runtime' | 'workspace' | 'intelligence' | 'operations';

interface ConfigSection {
  key: ConfigKey;
  label: string;
  title: string;
  summary: string;
  group: GroupKey;
}

interface ConfigGroup {
  key: GroupKey;
  label: string;
}

interface RuntimeLlmDraft {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  temperature: string;
  maxTokens: string;
  remoteTimeoutMs: string;
  fallbackTimeoutMs: string;
}

interface RuntimeTtsDraft {
  provider: string;
  endpoint: string;
  healthPath: string;
  chatVoice: string;
  speechRate: string;
}

interface RuntimeSttDraft {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  language: string;
  prompt: string;
}

const emptyLlmDraft: RuntimeLlmDraft = {
  provider: '',
  endpoint: '',
  model: '',
  apiKey: '',
  temperature: '',
  maxTokens: '',
  remoteTimeoutMs: '',
  fallbackTimeoutMs: '',
};

const emptyTtsDraft: RuntimeTtsDraft = {
  provider: '',
  endpoint: '',
  healthPath: '',
  chatVoice: '',
  speechRate: '',
};

const emptySttDraft: RuntimeSttDraft = {
  provider: '',
  endpoint: '',
  model: '',
  apiKey: '',
  language: '',
  prompt: '',
};

const llmProviderPresets: Record<string, Partial<RuntimeLlmDraft>> = {
  deepseek: {
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
  },
  'openai-compatible': {
    endpoint: 'https://api.openai.com/v1/chat/completions',
  },
  'local-llm': {
    endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
  },
};

const sttProviderPresets: Record<string, Partial<RuntimeSttDraft>> = {
  'faster-whisper': {
    endpoint: 'http://127.0.0.1:9882/transcribe',
    model: 'small',
    language: 'zh',
  },
  'openai-compatible': {
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
  },
};

const groups: ConfigGroup[] = [
  { key: 'runtime', label: '运行链路' },
  { key: 'workspace', label: '桌面工作台' },
  { key: 'intelligence', label: '人格与记忆' },
  { key: 'operations', label: '直播控制' },
];

const sections: ConfigSection[] = [
  {
    key: 'memory',
    label: '记忆',
    title: '长期记忆、用户档案与最近沉淀',
    summary: '最重要的记忆模块直接放在配置中心里，不再单独跳到一个难用的知识库页。',
    group: 'intelligence',
  },
  {
    key: 'persona',
    label: '人设',
    title: '互动模式、语气档案和角色行为',
    summary: '收束当前人格模式、语气倾向和自主程度。',
    group: 'intelligence',
  },
  {
    key: 'base',
    label: '基础设置',
    title: '后端地址、端口和启动策略',
    summary: '控制统一运行时地址、数据库位置和主窗启动门禁。',
    group: 'workspace',
  },
  {
    key: 'llm',
    label: 'LLM 配置',
    title: '模型供应商、超时和兜底策略',
    summary: '决定主回复链路的供应商、超时、温度和失败回退路径。',
    group: 'runtime',
  },
  {
    key: 'tts',
    label: 'TTS 配置',
    title: '语音引擎、音色和播放补偿',
    summary: '控制输出音色、播放速度、口型生成和字幕保留策略。',
    group: 'runtime',
  },
  {
    key: 'stt',
    label: 'STT 配置',
    title: '麦克风识别、转写模型和语种提示',
    summary: '控制麦克风音频送去哪里转写，以及转写完成后怎么接主聊天链路。',
    group: 'runtime',
  },
  {
    key: 'live2d',
    label: 'Live2D',
    title: '模型资源、窗口尺寸和舞台位置',
    summary: '控制透明浮窗模型路径、置顶级别和位置持久化。',
    group: 'runtime',
  },
  {
    key: 'danmaku',
    label: '弹幕接入',
    title: '房间参数、签名模式和重连节奏',
    summary: '管理 Rust 直连弹幕链路，以及异常重连和聊天触发。',
    group: 'runtime',
  },
  {
    key: 'appearance',
    label: '外观设置',
    title: '主题、密度和导航显隐',
    summary: '决定桌面壳层主题、界面密度和导航是否精简。',
    group: 'workspace',
  },
  {
    key: 'live',
    label: '直播模式',
    title: '直播状态、节目段落和开播门禁',
    summary: '决定当前直播态、房间信息和开播时自动执行的动作。',
    group: 'operations',
  },
  {
    key: 'security',
    label: '安全权限',
    title: '敏感字段、日志级别和工具权限',
    summary: '控制敏感信息显隐、日志保留周期和开发者级能力边界。',
    group: 'operations',
  },
];

export function SettingsPage() {
  const [activeKey, setActiveKey] = useState<ConfigKey>('memory');
  const [preferences, setPreferences] = useState(loadUiPreferences);
  const [catalog, setCatalog] = useState<KnowledgeCatalogResponse | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfigSnapshot | null>(null);
  const [runtimeConfigError, setRuntimeConfigError] = useState<string | null>(null);
  const [runtimeConfigBusy, setRuntimeConfigBusy] = useState(false);
  const [llmDraft, setLlmDraft] = useState<RuntimeLlmDraft>(emptyLlmDraft);
  const [ttsDraft, setTtsDraft] = useState<RuntimeTtsDraft>(emptyTtsDraft);
  const [sttDraft, setSttDraft] = useState<RuntimeSttDraft>(emptySttDraft);
  const [llmSaving, setLlmSaving] = useState(false);
  const [ttsSaving, setTtsSaving] = useState(false);
  const [sttSaving, setSttSaving] = useState(false);
  const [llmTesting, setLlmTesting] = useState(false);
  const [ttsTesting, setTtsTesting] = useState(false);
  const [sttTesting, setSttTesting] = useState(false);
  const [llmStatus, setLlmStatus] = useState<string | null>(null);
  const [ttsStatus, setTtsStatus] = useState<string | null>(null);
  const [sttStatus, setSttStatus] = useState<string | null>(null);
  const [ttsPreviewAudioUrl, setTtsPreviewAudioUrl] = useState<string | null>(null);
  const [live2dShellState, setLive2dShellState] = useState<MemorySuiteLive2dShellState | null>(
    null,
  );
  const [live2dShellBusy, setLive2dShellBusy] = useState(false);
  const [live2dShellError, setLive2dShellError] = useState<string | null>(null);

  const activeSection = useMemo(
    () => sections.find((section) => section.key === activeKey) ?? sections[0],
    [activeKey],
  );
  const groupedSections = useMemo(
    () =>
      groups.map((group) => ({
        ...group,
        items: sections.filter((section) => section.group === group.key),
      })),
    [],
  );

  const patchPreferences = (patch: Partial<UiPreferences>) => {
    setPreferences(updateUiPreferences(patch));
  };

  const refreshMemory = useCallback(async () => {
    try {
      const nextCatalog = await fetchKnowledgeCatalog('', 6);
      setCatalog(nextCatalog);
      setMemoryError(null);
    } catch (nextError) {
      setMemoryError(nextError instanceof Error ? nextError.message : '记忆目录加载失败。');
    }
  }, []);

  const refreshRuntimeConfig = useCallback(async () => {
    setRuntimeConfigBusy(true);
    try {
      const nextConfig = await fetchRuntimeConfig();
      setRuntimeConfig(nextConfig);
      setLlmDraft(llmDraftFromConfig(nextConfig));
      setTtsDraft(ttsDraftFromConfig(nextConfig));
      setSttDraft(sttDraftFromConfig(nextConfig));
      setTtsPreviewAudioUrl(null);
      setRuntimeConfigError(null);
    } catch (nextError) {
      setRuntimeConfigError(
        nextError instanceof Error ? nextError.message : '运行时配置加载失败。',
      );
    } finally {
      setRuntimeConfigBusy(false);
    }
  }, []);

  const refreshLive2dShellState = useCallback(async () => {
    if (!window.memorySuiteLive2dWindow?.getShellState) {
      setLive2dShellState(null);
      setLive2dShellError('当前不在桌面壳层，无法直接控制 Live2D 浮窗。');
      setLive2dShellBusy(false);
      return;
    }
    setLive2dShellBusy(true);
    try {
      const nextState = await window.memorySuiteLive2dWindow.getShellState();
      setLive2dShellState(nextState);
      setLive2dShellError(null);
    } catch (nextError) {
      setLive2dShellError(nextError instanceof Error ? nextError.message : 'Live2D 壳层状态读取失败。');
    } finally {
      setLive2dShellBusy(false);
    }
  }, []);

  const setLive2dLocalVisibilityMode = useCallback(
    async (mode: Live2dLocalVisibilityMode) => {
      if (!window.memorySuiteLive2dWindow?.setLocalVisibilityMode) {
        setLive2dShellError('当前不在桌面壳层，无法切换 Live2D 本地显示模式。');
        return;
      }
      setLive2dShellBusy(true);
      try {
        const nextState = await window.memorySuiteLive2dWindow.setLocalVisibilityMode(mode);
        setLive2dShellState(nextState);
        setLive2dShellError(null);
      } catch (nextError) {
        setLive2dShellError(nextError instanceof Error ? nextError.message : 'Live2D 本地显示模式切换失败。');
      } finally {
        setLive2dShellBusy(false);
      }
    },
    [],
  );

  const saveLlmConfig = useCallback(async () => {
    const normalizedDraft = normalizeLlmDraft(llmDraft);
    setLlmDraft(normalizedDraft);
    setLlmSaving(true);
    setLlmStatus(null);
    try {
      const nextConfig = await updateRuntimeLlmConfig({
        provider: asNullable(normalizedDraft.provider),
        endpoint: asNullable(normalizedDraft.endpoint),
        model: asNullable(normalizedDraft.model),
        api_key: asNullable(normalizedDraft.apiKey),
        temperature: asNullable(normalizedDraft.temperature),
        max_tokens: parseNullableInt(normalizedDraft.maxTokens),
        remote_timeout_ms: parseNullableInt(normalizedDraft.remoteTimeoutMs),
        fallback_timeout_ms: parseNullableInt(normalizedDraft.fallbackTimeoutMs),
      });
      setRuntimeConfig(nextConfig);
      setLlmDraft(llmDraftFromConfig(nextConfig));
      setTtsDraft(ttsDraftFromConfig(nextConfig));
      setSttDraft(sttDraftFromConfig(nextConfig));
      setRuntimeConfigError(null);
      setLlmStatus('LLM 配置已热更新。新的 key / URL / 模型已直接应用到当前 daemon。');
    } catch (nextError) {
      setLlmStatus(nextError instanceof Error ? nextError.message : 'LLM 配置保存失败。');
    } finally {
      setLlmSaving(false);
    }
  }, [llmDraft]);

  const saveTtsConfig = useCallback(async () => {
    const normalizedDraft = normalizeTtsDraft(ttsDraft);
    setTtsDraft(normalizedDraft);
    setTtsSaving(true);
    setTtsStatus(null);
    setTtsPreviewAudioUrl(null);
    try {
      const nextConfig = await updateRuntimeTtsConfig({
        provider: asNullable(normalizedDraft.provider),
        endpoint: asNullable(normalizedDraft.endpoint),
        health_path: asNullable(normalizedDraft.healthPath),
        chat_voice: asNullable(normalizedDraft.chatVoice),
        speech_rate: asNullable(normalizedDraft.speechRate),
      });
      setRuntimeConfig(nextConfig);
      setLlmDraft(llmDraftFromConfig(nextConfig));
      setTtsDraft(ttsDraftFromConfig(nextConfig));
      setSttDraft(sttDraftFromConfig(nextConfig));
      setRuntimeConfigError(null);
      setTtsStatus('TTS 配置已热更新。新的 provider / endpoint / voice 已直接应用。');
    } catch (nextError) {
      setTtsStatus(nextError instanceof Error ? nextError.message : 'TTS 配置保存失败。');
    } finally {
      setTtsSaving(false);
    }
  }, [ttsDraft]);

  const testLlmRuntimeConfig = useCallback(async () => {
    const normalizedDraft = normalizeLlmDraft(llmDraft);
    setLlmDraft(normalizedDraft);
    setLlmTesting(true);
    setLlmStatus(null);
    try {
      const result = await testRuntimeLlmConfig({
        provider: asNullable(normalizedDraft.provider),
        endpoint: asNullable(normalizedDraft.endpoint),
        model: asNullable(normalizedDraft.model),
        api_key: asNullable(normalizedDraft.apiKey),
        temperature: asNullable(normalizedDraft.temperature),
        max_tokens: parseNullableInt(normalizedDraft.maxTokens),
        remote_timeout_ms: parseNullableInt(normalizedDraft.remoteTimeoutMs),
        fallback_timeout_ms: parseNullableInt(normalizedDraft.fallbackTimeoutMs),
      });
      setLlmStatus(formatRuntimeTestStatus(result.ok, result.message, result.latency_ms));
    } catch (nextError) {
      setLlmStatus(nextError instanceof Error ? nextError.message : 'LLM 测试失败。');
    } finally {
      setLlmTesting(false);
    }
  }, [llmDraft]);

  const testTtsRuntimeConfig = useCallback(async () => {
    const normalizedDraft = normalizeTtsDraft(ttsDraft);
    setTtsDraft(normalizedDraft);
    setTtsTesting(true);
    setTtsStatus(null);
    setTtsPreviewAudioUrl(null);
    try {
      const result = await testRuntimeTtsConfig({
        provider: asNullable(normalizedDraft.provider),
        endpoint: asNullable(normalizedDraft.endpoint),
        health_path: asNullable(normalizedDraft.healthPath),
        chat_voice: asNullable(normalizedDraft.chatVoice),
        speech_rate: asNullable(normalizedDraft.speechRate),
      });
      setTtsStatus(formatRuntimeTestStatus(result.ok, result.message, result.latency_ms));
      setTtsPreviewAudioUrl(result.ok ? result.audio_url ?? null : null);
    } catch (nextError) {
      setTtsStatus(nextError instanceof Error ? nextError.message : 'TTS 测试失败。');
      setTtsPreviewAudioUrl(null);
    } finally {
      setTtsTesting(false);
    }
  }, [ttsDraft]);

  const saveSttConfig = useCallback(async () => {
    const normalizedDraft = normalizeSttDraft(sttDraft);
    setSttDraft(normalizedDraft);
    setSttSaving(true);
    setSttStatus(null);
    try {
      const nextConfig = await updateRuntimeSttConfig({
        provider: asNullable(normalizedDraft.provider),
        endpoint: asNullable(normalizedDraft.endpoint),
        model: asNullable(normalizedDraft.model),
        api_key: asNullable(normalizedDraft.apiKey),
        language: asNullable(normalizedDraft.language),
        prompt: asNullable(normalizedDraft.prompt),
      });
      setRuntimeConfig(nextConfig);
      setLlmDraft(llmDraftFromConfig(nextConfig));
      setTtsDraft(ttsDraftFromConfig(nextConfig));
      setSttDraft(sttDraftFromConfig(nextConfig));
      setRuntimeConfigError(null);
      setSttStatus('STT 配置已热更新。新的麦克风转写参数已直接应用。');
    } catch (nextError) {
      setSttStatus(nextError instanceof Error ? nextError.message : 'STT 配置保存失败。');
    } finally {
      setSttSaving(false);
    }
  }, [sttDraft]);

  const testSttRuntimeConfig = useCallback(async () => {
    const normalizedDraft = normalizeSttDraft(sttDraft);
    setSttDraft(normalizedDraft);
    setSttTesting(true);
    setSttStatus(null);
    try {
      const result = await testRuntimeSttConfig({
        provider: asNullable(normalizedDraft.provider),
        endpoint: asNullable(normalizedDraft.endpoint),
        model: asNullable(normalizedDraft.model),
        api_key: asNullable(normalizedDraft.apiKey),
        language: asNullable(normalizedDraft.language),
        prompt: asNullable(normalizedDraft.prompt),
      });
      setSttStatus(formatRuntimeTestStatus(result.ok, result.message, result.latency_ms));
    } catch (nextError) {
      setSttStatus(nextError instanceof Error ? nextError.message : 'STT 测试失败。');
    } finally {
      setSttTesting(false);
    }
  }, [sttDraft]);

  useEffect(() => {
    void refreshMemory();
  }, [refreshMemory]);

  useEffect(() => {
    void refreshRuntimeConfig();
  }, [refreshRuntimeConfig]);

  useEffect(() => {
    if (activeKey === 'live2d') {
      void refreshLive2dShellState();
    }
  }, [activeKey, refreshLive2dShellState]);

  return (
    <section className="page settings-page settings-page-compact">
      <header className="page-header settings-page-header">
        <div>
          <p className="dashboard-kicker">配置中心</p>
          <h2>把真正会用到的配置收进一页</h2>
          <p className="page-copy">
            不再做大而全的假后台。这里只保留运行、记忆、人格、直播和桌面本身真正有用的模块。
          </p>
        </div>
        <div className="settings-page-side">
          <span className="dashboard-chip subtle">{sections.length} 个实用模块</span>
          <span className="dashboard-badge ok">Memory First</span>
        </div>
      </header>

      <section className="settings-stage settings-stage-compact">
        <article className="card settings-nav-panel settings-nav-panel-compact">
          <div className="settings-nav-head">
            <div>
              <h3>模块导航</h3>
              <p className="muted-copy">删掉不常用大分页后，只留现在真的需要点开的配置。</p>
            </div>
          </div>
          <div className="settings-group-grid settings-group-grid-compact">
            {groupedSections.map((group) => (
              <section key={group.key} className="settings-group-card">
                <div className="settings-group-head">
                  <h4>{group.label}</h4>
                </div>
                <div className="settings-tab-grid settings-tab-grid-compact">
                  {group.items.map((section) => (
                    <button
                      key={section.key}
                      className={`settings-tab${section.key === activeKey ? ' active' : ''}`}
                      onClick={() => setActiveKey(section.key)}
                    >
                      <span>{section.label}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </article>

        <article className="card emphasis settings-detail-panel settings-detail-panel-compact">
          <div className="settings-detail-head">
            <div>
              <p className="settings-panel-kicker">
                {groupLabel(activeSection.group)} / {activeSection.label}
              </p>
              <h3>{activeSection.title}</h3>
              <p className="muted-copy">{activeSection.summary}</p>
            </div>
            <div className="settings-detail-meta">
              <span className="dashboard-chip subtle">{activeSection.label}</span>
              {activeSection.key === 'memory' ? (
                <button className="ghost" onClick={() => void refreshMemory()}>
                  刷新记忆
                </button>
              ) : null}
            </div>
          </div>
          <SettingsPanel
            section={activeSection.key}
            preferences={preferences}
            patchPreferences={patchPreferences}
            catalog={catalog}
            memoryError={memoryError}
            runtimeConfig={runtimeConfig}
            runtimeConfigError={runtimeConfigError}
            runtimeConfigBusy={runtimeConfigBusy}
            llmDraft={llmDraft}
            setLlmDraft={setLlmDraft}
            ttsDraft={ttsDraft}
            setTtsDraft={setTtsDraft}
            sttDraft={sttDraft}
            setSttDraft={setSttDraft}
            llmSaving={llmSaving}
            ttsSaving={ttsSaving}
            sttSaving={sttSaving}
            llmTesting={llmTesting}
            ttsTesting={ttsTesting}
            sttTesting={sttTesting}
            llmStatus={llmStatus}
            ttsStatus={ttsStatus}
            sttStatus={sttStatus}
            ttsPreviewAudioUrl={ttsPreviewAudioUrl}
            refreshRuntimeConfig={refreshRuntimeConfig}
            saveLlmConfig={saveLlmConfig}
            saveTtsConfig={saveTtsConfig}
            saveSttConfig={saveSttConfig}
            testLlmRuntimeConfig={testLlmRuntimeConfig}
            testTtsRuntimeConfig={testTtsRuntimeConfig}
            testSttRuntimeConfig={testSttRuntimeConfig}
            live2dShellState={live2dShellState}
            live2dShellBusy={live2dShellBusy}
            live2dShellError={live2dShellError}
            refreshLive2dShellState={refreshLive2dShellState}
            setLive2dLocalVisibilityMode={setLive2dLocalVisibilityMode}
          />
        </article>

        <aside className="card settings-quick-panel settings-quick-panel-compact">
          <div className="settings-nav-head">
            <div>
              <h3>桌面偏好</h3>
              <p className="muted-copy">这些开关不该占一个大页面，放右侧常驻就够了。</p>
            </div>
          </div>
          <div className="settings-quick-stack">
            <SettingSelect
              label="主题模式"
              options={['日间', '夜间', '跟随系统']}
              value={preferences.themeMode}
              onChange={(value) => patchPreferences({ themeMode: value as ThemeMode })}
            />
            <SettingToggle
              label="开发者模式"
              hint="只在需要调试时打开。"
              checked={preferences.developerMode}
              onChange={(checked) => patchPreferences({ developerMode: checked })}
            />
            <SettingToggle
              label="精简主导航"
              hint="主界面只保留总控台和配置中心。"
              checked={preferences.compactNavigation}
              onChange={(checked) => patchPreferences({ compactNavigation: checked })}
            />
            <section className="settings-inline-card">
              <div className="settings-inline-card-head">
                <span className="setting-label">当前链路</span>
                <span className="status-pill">
                  {runtimeConfig ? '已识别' : '等待同步'}
                </span>
              </div>
              <div className="settings-runtime-route-list">
                <small>STT · {runtimeLaneLabel(runtimeConfig?.stt.provider, runtimeConfig?.stt.endpoint)}</small>
                <small>LLM · {runtimeLaneLabel(runtimeConfig?.llm.provider, runtimeConfig?.llm.endpoint)}</small>
                <small>TTS · {runtimeLaneLabel(runtimeConfig?.tts.provider, runtimeConfig?.tts.endpoint)}</small>
              </div>
            </section>
            <section className="settings-inline-card">
              <div className="settings-inline-card-head">
                <span className="setting-label">Mic 聊天</span>
                <span className={`status-pill ${preferences.micChatEnabled ? 'status-running' : ''}`}>
                  {preferences.micChatEnabled ? '已开启' : '已关闭'}
                </span>
              </div>
              <small className="setting-hint">
                {preferences.micChatEnabled
                  ? 'Mic 聊天功能已开启。'
                  : 'Mic 聊天功能已关闭。'}
              </small>
              <button type="button" className="ghost settings-inline-action" onClick={() => setActiveKey('appearance')}>
                去外观设置里改
              </button>
            </section>
          </div>
        </aside>
      </section>
    </section>
  );
}

function SettingsPanel({
  section,
  preferences,
  patchPreferences,
  catalog,
  memoryError,
  runtimeConfig,
  runtimeConfigError,
  runtimeConfigBusy,
  llmDraft,
  setLlmDraft,
  ttsDraft,
  setTtsDraft,
  sttDraft,
  setSttDraft,
  llmSaving,
  ttsSaving,
  sttSaving,
  llmTesting,
  ttsTesting,
  sttTesting,
  llmStatus,
  ttsStatus,
  sttStatus,
  ttsPreviewAudioUrl,
  refreshRuntimeConfig,
  saveLlmConfig,
  saveTtsConfig,
  saveSttConfig,
  testLlmRuntimeConfig,
  testTtsRuntimeConfig,
  testSttRuntimeConfig,
  live2dShellState,
  live2dShellBusy,
  live2dShellError,
  refreshLive2dShellState,
  setLive2dLocalVisibilityMode,
}: {
  section: ConfigKey;
  preferences: UiPreferences;
  patchPreferences: (patch: Partial<UiPreferences>) => void;
  catalog: KnowledgeCatalogResponse | null;
  memoryError: string | null;
  runtimeConfig: RuntimeConfigSnapshot | null;
  runtimeConfigError: string | null;
  runtimeConfigBusy: boolean;
  llmDraft: RuntimeLlmDraft;
  setLlmDraft: (
    next:
      | RuntimeLlmDraft
      | ((previous: RuntimeLlmDraft) => RuntimeLlmDraft),
  ) => void;
  ttsDraft: RuntimeTtsDraft;
  setTtsDraft: (
    next:
      | RuntimeTtsDraft
      | ((previous: RuntimeTtsDraft) => RuntimeTtsDraft),
  ) => void;
  sttDraft: RuntimeSttDraft;
  setSttDraft: (
    next:
      | RuntimeSttDraft
      | ((previous: RuntimeSttDraft) => RuntimeSttDraft),
  ) => void;
  llmSaving: boolean;
  ttsSaving: boolean;
  sttSaving: boolean;
  llmTesting: boolean;
  ttsTesting: boolean;
  sttTesting: boolean;
  llmStatus: string | null;
  ttsStatus: string | null;
  sttStatus: string | null;
  ttsPreviewAudioUrl: string | null;
  refreshRuntimeConfig: () => Promise<void>;
  saveLlmConfig: () => Promise<void>;
  saveTtsConfig: () => Promise<void>;
  saveSttConfig: () => Promise<void>;
  testLlmRuntimeConfig: () => Promise<void>;
  testTtsRuntimeConfig: () => Promise<void>;
  testSttRuntimeConfig: () => Promise<void>;
  live2dShellState: MemorySuiteLive2dShellState | null;
  live2dShellBusy: boolean;
  live2dShellError: string | null;
  refreshLive2dShellState: () => Promise<void>;
  setLive2dLocalVisibilityMode: (mode: Live2dLocalVisibilityMode) => Promise<void>;
}) {
  switch (section) {
    case 'memory':
      return (
        <div className="settings-memory-stage">
          <div className="settings-form settings-form-compact">
            <SettingToggle label="启用长期记忆" hint="把长期记忆链路接入主对话。" checked />
            <SettingInput label="会话总结间隔" value="10 条消息" hint="每隔多少条消息沉淀一次总结。" />
            <SettingInput label="记忆库路径" value="data/memories" hint="长期记忆数据目录。" />
            <SettingInput label="召回数量" value="8" hint="单次最多召回的记忆条数。" />
            <SettingToggle label="保存用户关系" hint="沉淀用户关系与互动线索。" checked />
            <SettingToggle label="保存场景总结" hint="把直播上下文也写入记忆。" checked />
          </div>
          <div className="settings-memory-preview">
            <MemoryColumn
              title="最近记忆"
              items={(catalog?.memory_entries ?? []).slice(0, 3).map((entry) => ({
                key: entry.id,
                title: `${entry.user_id} · ${entry.entry_type}`,
                detail: entry.source,
              }))}
              empty="还没有可展示的记忆条目。"
            />
            <MemoryColumn
              title="用户档案"
              items={(catalog?.profiles ?? []).slice(0, 3).map((profile) => ({
                key: profile.user_id,
                title: profile.preferred_name ?? profile.user_id,
                detail: `${profile.interaction_count} 次互动`,
              }))}
              empty="还没有可展示的用户档案。"
            />
            {memoryError ? <p className="error">{memoryError}</p> : null}
          </div>
        </div>
      );
    case 'persona':
      return (
        <div className="settings-form settings-form-compact">
          <SettingSelect label="互动模式" hint="当前人格工作模式。" options={['stream', 'chat', 'idle']} />
          <SettingSelect label="语气档案" hint="角色对外表现的语气预设。" options={['balanced', 'sharp-playful', 'gentle', 'cold']} />
          <SettingInput label="温度 / 吐槽 / 自主" value="0.80 / 0.35 / 0.60" hint="当前行为混合比。" />
          <SettingInput label="当前场景" value="warmup" hint="当前节目阶段或情境。" />
          <SettingInput label="当前心情" value="curious" hint="影响表达风格的实时状态。" />
          <SettingToggle label="保持人设一致性" hint="优先约束风格漂移。" checked />
        </div>
      );
    case 'base':
      return (
        <div className="settings-form settings-form-compact">
          <SettingInput label="后端地址" value="http://127.0.0.1:8080" hint="统一运行时根地址。" />
          <SettingInput label="备用端口" value="18080-18085" hint="主端口冲突时的回退范围。" />
          <SettingInput label="数据库" value="runtime/memory-suite.db" hint="主数据库文件路径。" />
          <SettingInput label="窗口状态" value="runtime/electron-window-state.json" hint="桌面窗口状态缓存。" />
          <SettingToggle label="启动时自动选择可用端口" hint="端口冲突时自动换挡。" checked />
          <SettingToggle label="启动时执行健康检查" hint="进入主界面前先做基础探活。" checked />
        </div>
      );
    case 'llm':
      return (
        <div className="settings-stack">
          <div className="settings-form settings-form-compact">
            <SettingSelect
              label="供应商"
              hint="只改这里不够，下面的 URL / 模型 / Key 也会一并热更新。"
              options={['deepseek', 'openai-compatible', 'local-llm', 'custom']}
              value={llmDraft.provider || 'custom'}
              onChange={(value) =>
                setLlmDraft((previous) => {
                  const preset = llmProviderPresets[value] ?? {};
                  return {
                    ...previous,
                    provider: value,
                    endpoint:
                      !previous.endpoint || previous.endpoint === llmProviderPresets[previous.provider]?.endpoint
                        ? preset.endpoint ?? previous.endpoint
                        : previous.endpoint,
                    model:
                      !previous.model || previous.model === llmProviderPresets[previous.provider]?.model
                        ? preset.model ?? previous.model
                        : previous.model,
                  };
                })
              }
            />
            <SettingInput
              label="Chat Completions URL"
              value={llmDraft.endpoint}
              hint="可只填根地址；失焦、保存或测试时会自动补成 /v1/chat/completions。"
              onChange={(value) => setLlmDraft((previous) => ({ ...previous, endpoint: value }))}
              onBlur={() =>
                setLlmDraft((previous) => ({ ...previous, endpoint: normalizeLlmEndpoint(previous.endpoint) }))
              }
            />
            <SettingInput
              label="模型名"
              value={llmDraft.model}
              hint="例如 deepseek-chat / gpt-4.1-mini / 本地模型名。"
              onChange={(value) => setLlmDraft((previous) => ({ ...previous, model: value }))}
            />
            <SettingInput
              label="API Key"
              value={llmDraft.apiKey}
              hint="保存后立即应用到当前 daemon，不用重启。"
              onChange={(value) => setLlmDraft((previous) => ({ ...previous, apiKey: value }))}
              secret
            />
            <SettingInput
              label="温度"
              value={llmDraft.temperature}
              hint="留空就走默认值。"
              onChange={(value) => setLlmDraft((previous) => ({ ...previous, temperature: value }))}
            />
            <SettingInput
              label="最大输出"
              value={llmDraft.maxTokens}
              hint="单位 tokens。"
              onChange={(value) => setLlmDraft((previous) => ({ ...previous, maxTokens: value }))}
            />
            <SettingInput
              label="模型超时"
              value={llmDraft.remoteTimeoutMs}
              hint="单位 ms。"
              onChange={(value) =>
                setLlmDraft((previous) => ({ ...previous, remoteTimeoutMs: value }))
              }
            />
            <SettingInput
              label="回退预算"
              value={llmDraft.fallbackTimeoutMs}
              hint="单位 ms；超过这个时间就不会等模型。"
              onChange={(value) =>
                setLlmDraft((previous) => ({ ...previous, fallbackTimeoutMs: value }))
              }
            />
          </div>
          <ConfigActionBar
            loading={runtimeConfigBusy}
            saving={llmSaving}
            testing={llmTesting}
            loadingLabel="正在读取当前 LLM 配置…"
            savingLabel="正在热更新 LLM 配置…"
            testingLabel="正在测试 LLM 连通性…"
            status={llmStatus ?? runtimeConfigError}
            configPath={runtimeConfig?.config_path}
            onRefresh={() => void refreshRuntimeConfig()}
            onTest={() => void testLlmRuntimeConfig()}
            onSave={() => void saveLlmConfig()}
          />
        </div>
      );
    case 'tts':
      return (
        <div className="settings-stack">
          <div className="settings-form settings-form-compact">
            <SettingSelect
              label="语音引擎"
              hint="这里改 provider 后，下次发声直接用新 provider。"
              options={['edge_tts', 'sovits', 'mock']}
              value={ttsDraft.provider || 'edge_tts'}
              onChange={(value) =>
                setTtsDraft((previous) => ({
                  ...previous,
                  provider: value,
                }))
              }
            />
            <SettingInput
              label="Endpoint"
              value={ttsDraft.endpoint}
              hint="例如 http://127.0.0.1:9881；末尾 / 会自动去掉。"
              onChange={(value) => setTtsDraft((previous) => ({ ...previous, endpoint: value }))}
              onBlur={() =>
                setTtsDraft((previous) => ({ ...previous, endpoint: normalizeServiceEndpoint(previous.endpoint) }))
              }
            />
            <SettingInput
              label="健康检查路径"
              value={ttsDraft.healthPath}
              hint="默认 /voices；就算不写 / 也会自动补上。"
              onChange={(value) =>
                setTtsDraft((previous) => ({ ...previous, healthPath: value }))
              }
              onBlur={() =>
                setTtsDraft((previous) => ({ ...previous, healthPath: normalizeHealthPath(previous.healthPath) }))
              }
            />
            <SettingInput
              label="默认音色"
              value={ttsDraft.chatVoice}
              hint="聊天主音色。"
              onChange={(value) => setTtsDraft((previous) => ({ ...previous, chatVoice: value }))}
            />
            <SettingInput
              label="语速"
              value={ttsDraft.speechRate}
              hint="例如 1.2 / +0%。"
              onChange={(value) => setTtsDraft((previous) => ({ ...previous, speechRate: value }))}
            />
          </div>
          <ConfigActionBar
            loading={runtimeConfigBusy}
            saving={ttsSaving}
            testing={ttsTesting}
            loadingLabel="正在读取当前 TTS 配置…"
            savingLabel="正在热更新 TTS 配置…"
            testingLabel="正在测试 TTS 发声…"
            status={ttsStatus ?? runtimeConfigError}
            configPath={runtimeConfig?.config_path}
            onRefresh={() => void refreshRuntimeConfig()}
            onTest={() => void testTtsRuntimeConfig()}
            testLabel="测试发声"
            onSave={() => void saveTtsConfig()}
            extra={
              ttsPreviewAudioUrl ? (
                <audio className="settings-config-audio" controls preload="none" src={ttsPreviewAudioUrl} />
              ) : null
            }
          />
        </div>
      );
    case 'stt':
      return (
        <div className="settings-stack">
          <div className="settings-form settings-form-compact">
            <SettingSelect
              label="转写引擎"
              hint="本地默认走 faster-whisper；也支持 OpenAI 兼容的音频转写 endpoint。"
              options={['faster-whisper', 'openai-compatible', 'custom']}
              value={sttDraft.provider || 'faster-whisper'}
              onChange={(value) =>
                setSttDraft((previous) => {
                  const preset = sttProviderPresets[value] ?? {};
                  return {
                    ...previous,
                    provider: value,
                    endpoint:
                      !previous.endpoint || previous.endpoint === sttProviderPresets[previous.provider]?.endpoint
                        ? preset.endpoint ?? previous.endpoint
                        : previous.endpoint,
                    model:
                      !previous.model || previous.model === sttProviderPresets[previous.provider]?.model
                        ? preset.model ?? previous.model
                        : previous.model,
                    language:
                      !previous.language || previous.language === sttProviderPresets[previous.provider]?.language
                        ? preset.language ?? previous.language
                        : previous.language,
                  };
                })
              }
            />
            <SettingInput
              label="Endpoint"
              value={sttDraft.endpoint}
              hint="本地默认 http://127.0.0.1:9882/transcribe；OpenAI 兼容地址会自动补到 /v1/audio/transcriptions。"
              onChange={(value) => setSttDraft((previous) => ({ ...previous, endpoint: value }))}
              onBlur={() =>
                setSttDraft((previous) => ({
                  ...previous,
                  endpoint: normalizeSttEndpoint(previous.endpoint, previous.provider),
                }))
              }
            />
            <SettingInput
              label="模型名"
              value={sttDraft.model}
              hint="本地 faster-whisper 例如 tiny / base / small；远端例如 whisper-1。"
              onChange={(value) => setSttDraft((previous) => ({ ...previous, model: value }))}
            />
            <SettingInput
              label="API Key"
              value={sttDraft.apiKey}
              hint="仅远端 STT 使用；本地 faster-whisper 不需要。"
              onChange={(value) => setSttDraft((previous) => ({ ...previous, apiKey: value }))}
              secret
            />
            <SettingInput
              label="语言"
              value={sttDraft.language}
              hint="例如 zh / en；留空就让模型自己判断。"
              onChange={(value) => setSttDraft((previous) => ({ ...previous, language: value }))}
            />
            <SettingInput
              label="提示词"
              value={sttDraft.prompt}
              hint="给 STT 的初始提示，可用于专有名词和角色名纠错。"
              onChange={(value) => setSttDraft((previous) => ({ ...previous, prompt: value }))}
            />
          </div>
          <ConfigActionBar
            loading={runtimeConfigBusy}
            saving={sttSaving}
            testing={sttTesting}
            loadingLabel="正在读取当前 STT 配置…"
            savingLabel="正在热更新 STT 配置…"
            testingLabel="正在测试 STT 转写服务…"
            status={sttStatus ?? runtimeConfigError}
            configPath={runtimeConfig?.config_path}
            onRefresh={() => void refreshRuntimeConfig()}
            onTest={() => void testSttRuntimeConfig()}
            testLabel="测试转写"
            onSave={() => void saveSttConfig()}
          />
        </div>
      );
    case 'live2d':
      return (
        <div className="settings-live2d-stage">
          <Live2dLocalVisibilityCard
            shellState={live2dShellState}
            busy={live2dShellBusy}
            error={live2dShellError}
            onRefresh={() => void refreshLive2dShellState()}
            onChangeMode={(mode) => void setLive2dLocalVisibilityMode(mode)}
          />
          <div className="settings-form settings-form-compact">
            <SettingInput label="模型文件" value="hiyori_pro_t11.model3.json" hint="当前默认模型文件。" />
            <SettingInput label="资源目录" value="Liver2d/hiyori_zh-Hans/hiyori_pro/runtime" hint="Live2D 资源路径。" />
            <SettingInput
              label="当前浮窗状态"
              value={live2dVisibilityLabel(live2dShellState, live2dShellBusy)}
              hint="这是 Electron 壳层里的真实窗口状态。"
            />
            <SettingInput
              label="本地显示模式"
              value={live2dModeLabel(live2dShellState?.localVisibilityMode, Boolean(live2dShellState))}
              hint="上方切换后立即生效，不再只是静态展示。"
            />
            <SettingInput label="窗口尺寸" value="420 x 780" hint="透明浮窗初始尺寸。" />
            <SettingInput label="舞台位置" value="scale 0.25 / x 0.30 / y 0.50" hint="角色在舞台中的缩放和偏移。" />
            <SettingInput
              label="鼠标模式"
              value={live2dMouseModeLabel(live2dShellState)}
              hint="OBS 隐身会强制鼠标穿透，避免屏幕边缘误触。"
            />
            <SettingInput
              label="窗口层级"
              value={live2dLayerLabel(live2dShellState)}
              hint="当前 Electron 壳层记录的置顶级别。"
            />
          </div>
        </div>
      );
    case 'danmaku':
      return (
        <div className="settings-form settings-form-compact">
          <SettingInput label="房间 ID" value="556677" hint="当前直播房间号。" />
          <SettingInput label="UID" value="1024" hint="当前账号标识。" />
          <SettingInput label="Buvid" value="memory-suite-buvid" hint="弹幕链路使用的设备标识。" />
          <SettingInput label="连接模式" value="native_websocket（Rust 直连）" hint="当前接入方式。" />
          <SettingSelect label="签名模式" hint="决定连线时的鉴权方式。" options={['cookie', 'anonymous', 'stored']} />
          <SettingInput label="重连间隔" value="3 s / 8 s / 20 s" hint="断线后的退避梯度。" />
        </div>
      );
    case 'appearance':
      return (
        <div className="settings-stack">
          <div className="settings-form settings-form-compact">
            <SettingSelect
              label="主题模式"
              hint="桌面端默认主题。"
              options={['日间', '夜间', '跟随系统']}
              value={preferences.themeMode}
              onChange={(value) => patchPreferences({ themeMode: value as ThemeMode })}
            />
            <SettingSelect label="界面密度" hint="决定表单和列表的整体紧凑度。" options={['标准', '紧凑', '触控']} />
            <SettingInput label="Live2D 缩放" value="0.25" hint="主舞台默认缩放比例。" />
            <SettingToggle
              label="精简主导航"
              hint="隐藏低频功能入口。"
              checked={preferences.compactNavigation}
              onChange={(checked) => patchPreferences({ compactNavigation: checked })}
            />
          </div>
          <MicChatCard
            enabled={preferences.micChatEnabled}
            onChange={(checked) => patchPreferences({ micChatEnabled: checked })}
          />
        </div>
      );
    case 'live':
      return (
        <div className="settings-form settings-form-compact">
          <SettingSelect label="直播状态" hint="当前直播阶段。" options={['准备中', '开播', '休息', '收尾']} />
          <SettingInput label="B 站房间号" value="556677" hint="当前直播房间。" />
          <SettingInput label="节目段落" value="tech_talk / casual_chat / quiz / roast" hint="当前节目结构。" />
          <SettingInput label="开场提示" value="今天从运行状态自检开始。" hint="开播时的默认引导语。" />
          <SettingToggle label="开播前执行 readiness 检查" hint="进入开播态前先执行门禁检查。" checked />
          <SettingToggle label="开播后自动连接弹幕" hint="一旦开播立即接入弹幕源。" checked />
        </div>
      );
    case 'security':
      return (
        <div className="settings-form settings-form-compact">
          <SettingToggle label="隐藏 Cookie 明文" hint="敏感字段默认不直接展示。" checked />
          <SettingToggle label="工具执行需要开发者模式" hint="降低误触高级能力的风险。" checked />
          <SettingToggle label="外部链接用系统浏览器打开" hint="主窗不承接外部导航。" checked />
          <SettingInput label="敏感字段" value="API key / Cookie / SESSDATA" hint="默认隐藏的敏感字段名。" />
          <SettingSelect label="日志级别" hint="决定运行日志详细度。" options={['info', 'debug', 'warn', 'error']} />
          <SettingInput label="日志保留" value="7 days" hint="本地日志保留周期。" />
        </div>
      );
  }
}

function MicChatCard({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <section className="settings-shell-card">
      <div className="settings-shell-head">
        <div>
          <span className="setting-label">Mic 聊天</span>
          <p className="setting-hint">
            这里只保留一个总开关，决定总控台是否启用麦克风识别入口。
          </p>
        </div>
        <span className={`status-pill ${enabled ? 'status-running' : ''}`}>
          {enabled ? '已开启' : '已关闭'}
        </span>
      </div>

      <div className="settings-form settings-form-compact settings-shell-grid">
        <SettingToggle
          label="启用 Mic 聊天"
          hint="关闭后，总控台不会再展示任何麦克风聊天入口。"
          checked={enabled}
          onChange={onChange}
        />
      </div>

      <div className="settings-shell-foot">
        <div className="settings-shell-copy">
          <small className="setting-hint">
            {enabled
              ? '当前总控台允许直接开麦、转写并接主聊天链路。'
              : '当前总控台不会响应麦克风录音操作。'}
          </small>
        </div>
      </div>
    </section>
  );
}

function Live2dLocalVisibilityCard({
  shellState,
  busy,
  error,
  onRefresh,
  onChangeMode,
}: {
  shellState: MemorySuiteLive2dShellState | null;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onChangeMode: (mode: Live2dLocalVisibilityMode) => void;
}) {
  const unavailable = shellState?.available === false || (!shellState && Boolean(error));

  return (
    <section className="settings-live2d-shell-card">
      <div className="settings-live2d-shell-head">
        <div className="settings-live2d-shell-copy">
          <span className="setting-label">本地显示模式</span>
          <p className="setting-hint">
            这里不是把窗口真正 hide 掉，而是让它继续渲染，只在本地屏幕边缘留极窄锚点，方便 OBS 继续窗口采集。
          </p>
        </div>
        <div className="settings-live2d-shell-meta">
          <span className={`status-pill ${shellState?.visible ? 'status-running' : shellState ? 'status-failed' : ''}`}>
            {live2dVisibilityLabel(shellState, busy)}
          </span>
          <span
            className={`status-pill ${shellState?.localVisibilityMode === 'obs_hidden' ? 'status-queued' : ''}`}
          >
            {Boolean(shellState)
              ? shellState?.localVisibilityMode === 'obs_hidden'
                ? 'OBS 隐身中'
                : '本地正常显示'
              : '等待同步'}
          </span>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="settings-live2d-mode-grid">
        <button
          type="button"
          className={`settings-mode-option${shellState?.localVisibilityMode === 'visible' ? ' active' : ''}`}
          aria-pressed={shellState?.localVisibilityMode === 'visible'}
          disabled={busy || unavailable}
          onClick={() => onChangeMode('visible')}
        >
          <strong>本地显示</strong>
          <span>本地可见。拖动、交互和普通使用都按当前浮窗设置执行。</span>
        </button>
        <button
          type="button"
          className={`settings-mode-option${shellState?.localVisibilityMode === 'obs_hidden' ? ' active' : ''}`}
          aria-pressed={shellState?.localVisibilityMode === 'obs_hidden'}
          disabled={busy || unavailable}
          onClick={() => onChangeMode('obs_hidden')}
        >
          <strong>OBS 隐身</strong>
          <span>本地只留右侧极窄边缘锚点，OBS 窗口采集仍可继续抓到画面。</span>
        </button>
      </div>

      <div className="settings-live2d-shell-foot">
        <small className="setting-hint">
          {busy
            ? '正在切换 Live2D 本地显示模式…'
            : 'OBS 隐身模式会强制鼠标穿透；恢复本地显示后，会回到你原本记录的交互状态。'}
        </small>
        <button type="button" className="ghost" onClick={onRefresh} disabled={busy}>
          刷新状态
        </button>
      </div>
    </section>
  );
}

function groupLabel(group: GroupKey) {
  return groups.find((item) => item.key === group)?.label ?? '配置';
}

function live2dVisibilityLabel(
  shellState: MemorySuiteLive2dShellState | null,
  busy = false,
) {
  if (!shellState) {
    return busy ? '状态读取中' : '未连接';
  }
  return shellState.visible ? '已显示' : '已隐藏';
}

function live2dModeLabel(
  mode: Live2dLocalVisibilityMode | undefined,
  connected = true,
) {
  if (!connected) {
    return '未连接';
  }
  return mode === 'obs_hidden' ? 'OBS 隐身' : '本地显示';
}

function live2dMouseModeLabel(shellState: MemorySuiteLive2dShellState | null) {
  if (!shellState) {
    return '未连接';
  }
  if (shellState?.localVisibilityMode === 'obs_hidden') {
    return '强制穿透';
  }
  return shellState?.clickThrough ? '鼠标穿透' : '可交互';
}

function live2dLayerLabel(shellState: MemorySuiteLive2dShellState | null) {
  if (!shellState) {
    return '未连接';
  }
  return shellState.alwaysOnTop ? '始终置顶' : '普通窗口';
}

function runtimeLaneLabel(
  provider?: string | null,
  endpoint?: string | null,
) {
  if (!provider && !endpoint) {
    return '等待同步';
  }

  const normalizedProvider = provider?.trim().toLowerCase() ?? '';
  if (
    ['faster-whisper', 'edge_tts', 'sovits', 'mock', 'local-llm'].includes(
      normalizedProvider,
    )
  ) {
    return '本地';
  }

  if (isLocalEndpoint(endpoint)) {
    return '本地';
  }

  return '云端';
}

function isLocalEndpoint(endpoint?: string | null) {
  if (!endpoint) {
    return false;
  }

  try {
    const url = new URL(endpoint);
    return ['127.0.0.1', 'localhost', '0.0.0.0'].includes(url.hostname);
  } catch {
    return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)/i.test(endpoint);
  }
}

function MemoryColumn({
  title,
  items,
  empty,
}: {
  title: string;
  items: Array<{ key: string; title: string; detail: string }>;
  empty: string;
}) {
  return (
    <section className="settings-memory-card">
      <div className="settings-group-head">
        <h4>{title}</h4>
      </div>
      {items.length ? (
        <div className="settings-memory-list">
          {items.map((item) => (
            <article key={item.key} className="settings-memory-row">
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </article>
          ))}
        </div>
      ) : (
        <p className="muted-copy">{empty}</p>
      )}
    </section>
  );
}

function SettingInput({
  label,
  value,
  hint,
  onChange,
  onBlur,
  secret = false,
}: {
  label: string;
  value: string;
  hint?: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  secret?: boolean;
}) {
  return (
    <label className="field setting-field">
      <span className="setting-label">{label}</span>
      <input
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        onBlur={() => onBlur?.()}
        readOnly={!onChange}
      />
      {hint ? <small className="setting-hint">{hint}</small> : null}
    </label>
  );
}

function SettingSelect({
  label,
  options,
  value,
  onChange,
  hint,
}: {
  label: string;
  options: string[];
  value?: string;
  onChange?: (value: string) => void;
  hint?: string;
}) {
  return (
    <label className="field setting-field">
      <span className="setting-label">{label}</span>
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
      {hint ? <small className="setting-hint">{hint}</small> : null}
    </label>
  );
}

function SettingToggle({
  label,
  checked = false,
  onChange,
  hint,
}: {
  label: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="check-row wide setting-toggle">
      <div className="setting-toggle-copy">
        <span className="setting-label">{label}</span>
        {hint ? <small className="setting-hint">{hint}</small> : null}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange?.(event.target.checked)}
        readOnly={!onChange}
      />
    </label>
  );
}

function ConfigActionBar({
  loading,
  saving,
  testing = false,
  loadingLabel,
  savingLabel,
  testingLabel = '正在测试配置…',
  status,
  configPath,
  onRefresh,
  onTest,
  testLabel = '测试配置',
  onSave,
  extra,
}: {
  loading: boolean;
  saving: boolean;
  testing?: boolean;
  loadingLabel: string;
  savingLabel: string;
  testingLabel?: string;
  status: string | null;
  configPath?: string;
  onRefresh: () => void;
  onTest?: () => void;
  testLabel?: string;
  onSave: () => void;
  extra?: ReactNode;
}) {
  const busy = loading || saving || testing;
  const pillLabel = saving
    ? savingLabel
    : testing
      ? testingLabel
      : loading
        ? loadingLabel
        : '支持热更新';
  const pillClassName = saving
    ? 'status-pill status-dispatching'
    : testing
      ? 'status-pill status-running'
      : loading
      ? 'status-pill status-queued'
      : status
        ? 'status-pill status-running'
        : 'status-pill';

  return (
    <section className="settings-config-actions">
      <div className="settings-config-status">
        <span className={pillClassName}>{pillLabel}</span>
        {configPath ? <small className="setting-hint">写入文件：{configPath}</small> : null}
        {status ? <p className="muted-copy">{status}</p> : null}
        {extra}
      </div>
      <div className="settings-config-action-row">
        <button type="button" className="ghost" onClick={onRefresh} disabled={busy}>
          重新读取
        </button>
        {onTest ? (
          <button type="button" className="ghost" onClick={onTest} disabled={busy}>
            {testLabel}
          </button>
        ) : null}
        <button type="button" onClick={onSave} disabled={busy}>
          保存并热更新
        </button>
      </div>
    </section>
  );
}

function llmDraftFromConfig(config: RuntimeConfigSnapshot): RuntimeLlmDraft {
  return {
    provider: config.llm.provider ?? '',
    endpoint: normalizeLlmEndpoint(config.llm.endpoint ?? ''),
    model: config.llm.model ?? '',
    apiKey: config.llm.api_key ?? '',
    temperature: config.llm.temperature ?? '',
    maxTokens: config.llm.max_tokens != null ? String(config.llm.max_tokens) : '',
    remoteTimeoutMs:
      config.llm.remote_timeout_ms != null ? String(config.llm.remote_timeout_ms) : '',
    fallbackTimeoutMs:
      config.llm.fallback_timeout_ms != null ? String(config.llm.fallback_timeout_ms) : '',
  };
}

function ttsDraftFromConfig(config: RuntimeConfigSnapshot): RuntimeTtsDraft {
  return {
    provider: config.tts.provider ?? '',
    endpoint: normalizeServiceEndpoint(config.tts.endpoint ?? ''),
    healthPath: normalizeHealthPath(config.tts.health_path ?? ''),
    chatVoice: config.tts.chat_voice ?? '',
    speechRate: config.tts.speech_rate ?? '',
  };
}

function sttDraftFromConfig(config: RuntimeConfigSnapshot): RuntimeSttDraft {
  return {
    provider: config.stt.provider ?? '',
    endpoint: normalizeSttEndpoint(config.stt.endpoint ?? '', config.stt.provider ?? ''),
    model: config.stt.model ?? '',
    apiKey: config.stt.api_key ?? '',
    language: config.stt.language ?? '',
    prompt: config.stt.prompt ?? '',
  };
}

function normalizeLlmDraft(draft: RuntimeLlmDraft): RuntimeLlmDraft {
  return {
    ...draft,
    endpoint: normalizeLlmEndpoint(draft.endpoint),
  };
}

function normalizeTtsDraft(draft: RuntimeTtsDraft): RuntimeTtsDraft {
  return {
    ...draft,
    endpoint: normalizeServiceEndpoint(draft.endpoint),
    healthPath: normalizeHealthPath(draft.healthPath),
  };
}

function normalizeSttDraft(draft: RuntimeSttDraft): RuntimeSttDraft {
  return {
    ...draft,
    endpoint: normalizeSttEndpoint(draft.endpoint, draft.provider),
  };
}

function normalizeLlmEndpoint(value: string) {
  const trimmed = value.trim().replace(/\/+$/g, '');
  if (!trimmed) {
    return '';
  }
  const lowered = trimmed.toLowerCase();
  if (
    lowered.endsWith('/v1/chat/completions') ||
    lowered.endsWith('/chat/completions')
  ) {
    return trimmed;
  }
  if (lowered.endsWith('/v1')) {
    return `${trimmed}/chat/completions`;
  }
  if (lowered.endsWith('/chat')) {
    return `${trimmed}/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

function normalizeServiceEndpoint(value: string) {
  return value.trim().replace(/\/+$/g, '');
}

function normalizeSttEndpoint(value: string, provider: string) {
  const trimmed = value.trim().replace(/\/+$/g, '');
  if (!trimmed) {
    return '';
  }
  const normalizedProvider = provider.trim().toLowerCase().replace(/-/g, '_');
  const lowered = trimmed.toLowerCase();

  if (normalizedProvider === 'openai_compatible') {
    if (
      lowered.endsWith('/v1/audio/transcriptions') ||
      lowered.endsWith('/audio/transcriptions')
    ) {
      return trimmed;
    }
    if (lowered.endsWith('/v1/audio')) {
      return `${trimmed}/transcriptions`;
    }
    if (lowered.endsWith('/v1')) {
      return `${trimmed}/audio/transcriptions`;
    }
    if (lowered.endsWith('/audio')) {
      return `${trimmed}/transcriptions`;
    }
    return `${trimmed}/v1/audio/transcriptions`;
  }

  if (lowered.endsWith('/transcribe')) {
    return trimmed;
  }
  return `${trimmed}/transcribe`;
}

function normalizeHealthPath(value: string) {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

function formatRuntimeTestStatus(ok: boolean, message: string, latencyMs?: number | null) {
  const trimmed = message.trim();
  if (ok) {
    if (latencyMs == null) {
      return trimmed || '测试通过';
    }
    return trimmed ? `${latencyMs} ms · ${trimmed}` : `测试通过 · ${latencyMs} ms`;
  }
  if (latencyMs == null) {
    return trimmed ? `测试失败 · ${trimmed}` : '测试失败';
  }
  return trimmed ? `测试失败 · ${latencyMs} ms · ${trimmed}` : `测试失败 · ${latencyMs} ms`;
}

function asNullable(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseNullableInt(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
