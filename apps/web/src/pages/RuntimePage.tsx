import { startTransition, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AdapterRecord,
  DanmakuBootstrapRecord,
  DanmakuNativeConnectResponse,
  DanmakuConnectionStateRecord,
  DanmakuNativeProbeResponse,
  DanmakuSourceConfigRecord,
  DiaryEntryRecord,
  Live2dStateRecord,
  PersonaRuntimeStateRecord,
  RecentChatLatencyResponse,
  RuntimeEvent,
  RuntimeOverview,
} from '../generated/api';
import {
  fetchCharacterClips,
  fetchCharacterDiary,
  fetchChatLatency,
  fetchDanmakuSource,
  fetchDanmakuState,
  fetchLive2dState,
  fetchPersonaState,
  fetchRuntimeOverview,
  listAdapters,
  openRuntimeStream,
} from '../lib';
import { AdaptersPanel } from './runtime/AdaptersPanel';
import { ChatLatencyPanel } from './runtime/ChatLatencyPanel';
import { ContentTimelinePanel } from './runtime/ContentTimelinePanel';
import { Live2dPanel } from './runtime/Live2dPanel';
import { PersonaPanel } from './runtime/PersonaPanel';
import { ReadinessCard } from './runtime/ReadinessCard';
import { RuntimeHero } from './runtime/RuntimeHero';
import { EventFeedPanel } from './runtime/EventFeedPanel';
import { DanmakuInjectionPanel } from './runtime/DanmakuInjectionPanel';
import { DanmakuSourcePanel } from './runtime/DanmakuSourcePanel';
import { StoragePanel } from './runtime/StoragePanel';
import { evaluateRuntimeReadiness } from './runtimeReadiness';
import type { ReadinessResult } from './runtimeReadiness';

export function RuntimePage() {
  const [overview, setOverview] = useState<RuntimeOverview | null>(null);
  const [adapters, setAdapters] = useState<AdapterRecord[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [live2d, setLive2d] = useState<Live2dStateRecord | null>(null);
  const [persona, setPersona] = useState<PersonaRuntimeStateRecord | null>(null);
  const [chatLatency, setChatLatency] = useState<RecentChatLatencyResponse | null>(null);
  const [diaryEntries, setDiaryEntries] = useState<DiaryEntryRecord[]>([]);
  const [clipCount, setClipCount] = useState(0);
  const [shortContent, setShortContent] = useState<string | null>(null);
  const [danmakuBootstrap, setDanmakuBootstrap] = useState<DanmakuBootstrapRecord | null>(null);
  const [nativeConnect, setNativeConnect] = useState<DanmakuNativeConnectResponse | null>(null);
  const [nativeProbe, setNativeProbe] = useState<DanmakuNativeProbeResponse | null>(null);
  const [danmakuSource, setDanmakuSource] = useState<DanmakuSourceConfigRecord | null>(null);
  const [danmakuState, setDanmakuState] = useState<DanmakuConnectionStateRecord | null>(null);
  const [roomId, setRoomId] = useState('556677');
  const [uid, setUid] = useState('1024');
  const [buvid, setBuvid] = useState('memory-suite-buvid');
  const [cookie, setCookie] = useState('SESSDATA=redacted;');
  const [signatureMode, setSignatureMode] = useState('cookie');
  const [subtitleText, setSubtitleText] = useState('浮窗同步检查');
  const [emotion, setEmotion] = useState('happy');
  const [modelScale, setModelScale] = useState('0.25');
  const [modelX, setModelX] = useState('0.30');
  const [modelY, setModelY] = useState('0.50');
  const [danmakuText, setDanmakuText] = useState('来自运行台的测试弹幕');
  const [error, setError] = useState<string | null>(null);

  const readiness = useMemo<ReadinessResult>(
    () =>
      evaluateRuntimeReadiness({
        overview,
        adapters,
        live2d,
        danmakuSource,
        danmakuState,
        persona,
        chatLatency,
        events,
      }),
    [overview, adapters, live2d, danmakuSource, danmakuState, persona, chatLatency, events],
  );

  const refresh = useCallback(async () => {
    try {
      const [nextOverview, nextAdapters] = await Promise.all([
        fetchRuntimeOverview(),
        listAdapters(),
      ]);
      setOverview(nextOverview);
      setAdapters(nextAdapters);
      const [nextLive2d, nextDanmakuSource, nextDanmakuState, nextPersona, nextDiary, nextClips, nextLatency] = await Promise.all([
        fetchLive2dState(),
        fetchDanmakuSource(),
        fetchDanmakuState(),
        fetchPersonaState().catch(() => null),
        fetchCharacterDiary().catch(() => []),
        fetchCharacterClips().catch(() => []),
        fetchChatLatency().catch(() => null),
      ]);
      setLive2d(nextLive2d);
      setDanmakuSource(nextDanmakuSource);
      setDanmakuState(nextDanmakuState);
      setPersona(nextPersona);
      setDiaryEntries(nextDiary);
      setChatLatency(nextLatency);
      setClipCount(nextClips.length);
      setRoomId(nextDanmakuSource.room_id || '556677');
      setUid(String(nextDanmakuSource.uid || 0));
      setBuvid(nextDanmakuSource.buvid || 'memory-suite-buvid');
      setCookie(nextDanmakuSource.has_cookie ? 'SESSDATA=stored;' : '');
      setSignatureMode(nextDanmakuSource.signature_mode || 'cookie');
      setModelScale(String(nextLive2d.config.scale ?? 0.25));
      setModelX(String(nextLive2d.config.x ?? 0.3));
      setModelY(String(nextLive2d.config.y ?? 0.5));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '运行时刷新失败。');
    }
  }, []);

  const handleEvent = useCallback((event: RuntimeEvent) => {
    startTransition(() => {
      setEvents((current) => [event, ...current].slice(0, 16));
    });
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    return openRuntimeStream(handleEvent);
  }, [handleEvent, refresh]);

  return (
    <section className="page">
      <header className="page-header">
        <p className="eyebrow">运行时控制台</p>
        <h2>统一后端监管面板</h2>
        <p className="page-copy">
          这里集中显示适配器监管、事件流、运行计数、弹幕接入和 Live2D 状态。
        </p>
      </header>

      <section className="runtime-stage">
        <ReadinessCard readiness={readiness} />

        <RuntimeHero overview={overview} />

        {persona && <PersonaPanel persona={persona} />}

        {chatLatency && <ChatLatencyPanel chatLatency={chatLatency} />}

        <ContentTimelinePanel
          diaryEntries={diaryEntries}
          clipCount={clipCount}
          shortContent={shortContent}
          onRefresh={refresh}
          onShortContent={setShortContent}
        />

        <div className="runtime-columns">
          <AdaptersPanel adapters={adapters} onRefresh={refresh} />
          <EventFeedPanel events={events} />
        </div>

        <div className="runtime-columns">
          <DanmakuSourcePanel
            roomId={roomId}
            uid={uid}
            buvid={buvid}
            cookie={cookie}
            signatureMode={signatureMode}
            danmakuSource={danmakuSource}
            danmakuState={danmakuState}
            danmakuBootstrap={danmakuBootstrap}
            nativeProbe={nativeProbe}
            nativeConnect={nativeConnect}
            onRoomIdChange={setRoomId}
            onUidChange={setUid}
            onBuvidChange={setBuvid}
            onCookieChange={setCookie}
            onSignatureModeChange={setSignatureMode}
            onDanmakuBootstrapChange={setDanmakuBootstrap}
            onNativeProbeChange={setNativeProbe}
            onNativeConnectChange={setNativeConnect}
            onRefresh={refresh}
          />

          <Live2dPanel
            live2d={live2d}
            subtitleText={subtitleText}
            emotion={emotion}
            modelScale={modelScale}
            modelX={modelX}
            modelY={modelY}
            onSubtitleTextChange={setSubtitleText}
            onEmotionChange={setEmotion}
            onModelScaleChange={setModelScale}
            onModelXChange={setModelX}
            onModelYChange={setModelY}
            onLive2dChange={setLive2d}
          />

          <DanmakuInjectionPanel
            danmakuText={danmakuText}
            onDanmakuTextChange={setDanmakuText}
            onRefresh={refresh}
          />

          <StoragePanel overview={overview} error={error} />
        </div>
      </section>
    </section>
  );
}
