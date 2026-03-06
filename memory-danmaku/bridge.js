// 原始弹幕桥接逻辑（恢复版�?
// 功能：连�?B 站房�?-> 调用 memory-universe /api/chat/stream -> 按标点切片合�?TTS -> 推�?Live2D 音频/字幕/动作

import { config } from 'dotenv';
import { LiveWS } from 'laplace-blive-ws';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { createDanmakuHeaders, resolveDanmakuQuery, autoFetchSignature, getWbiSignature } from './danmaku-headers.js';
import { WebSocketServer } from 'ws';
import axios from 'axios';
import { createRequire } from 'module';

// 导入 ReconnectManager（CommonJS 模块�?
const require = createRequire(import.meta.url);
const { ReconnectManager } = require('./src/utils/ReconnectManager.cjs');

// 禁用代理，防止本地请求被代理拦截
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

// 配置 axios 禁用代理
axios.defaults.proxy = false;

// 加载环境变量
config({ path: path.join(process.cwd(), '../.env') });

const configPath = path.join(process.cwd(), 'config.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

let ROOM_ID = Number(cfg.roomId) || 0;
const TRIGGER_PREFIX = typeof cfg.triggerPrefix === 'string' ? cfg.triggerPrefix : '';
const RATE_LIMIT_MS = Number(cfg.rateLimitMs) || 2000;
const REPLY_MIN_LEN = Number(cfg.replyMinLen) || 1;
const ORCH_WINDOW_MS = Number(cfg.orchWindowMs ?? process.env.ORCH_WINDOW_MS ?? 500);
const ORCH_MAX_OUT_PER_WINDOW = Number(cfg.orchMaxOutPerWindow ?? process.env.ORCH_MAX_OUT_PER_WINDOW ?? 1);
const ORCH_COOLDOWN_MS = Number(cfg.orchCooldownMs ?? process.env.ORCH_COOLDOWN_MS ?? 1500);
const ORCH_HOST_NAME = cfg.orchHostName ?? process.env.HOST_NAME ?? '月影';
const ORCH_SENSITIVE_WORDS = String(cfg.orchSensitiveWords ?? process.env.SENSITIVE_WORDS ?? '')
  .split(',')
  .map(word => word.trim())
  .filter(Boolean);
const ORCH_MERGE_ENABLED = cfg.orchMergeEnabled ?? true;
// 使用环境变量配置API地址
const TTS_PORT = process.env.TTS_SERVICE_PORT || 4014;
const LIVE2D_PORT = process.env.LIVE2D_SERVICE_PORT || 4005;
const DANMAKU_PORT = process.env.DANMAKU_SERVICE_PORT || 4003;
const DANMAKU_HOST = process.env.DANMAKU_SERVICE_HOST || '127.0.0.1';

// ============ Web Manager Service Orchestration ============
// 优先使用 Manager 作为服务编排层，如果不可用则直接连接 Memory Universe
const MANAGER_PORT = process.env.MANAGER_PORT || 8080;
const MEMORY_UNIVERSE_PORT = process.env.MEMORY_UNIVERSE_PORT || 4005;

const WEB_MANAGER_URL = process.env.MANAGER_URL || `http://127.0.0.1:${MANAGER_PORT}`;
const MEMORY_UNIVERSE_URL = process.env.MEMORY_UNIVERSE_URL || `http://127.0.0.1:${MEMORY_UNIVERSE_PORT}`;

// 优先使用 Manager �?/api/chat，如�?Manager 不可用则直接连接 Memory Universe
const CHAT_URL = cfg.memoryChatUrl || `${WEB_MANAGER_URL}/api/chat`;
const FALLBACK_CHAT_URL = `${MEMORY_UNIVERSE_URL}/api/chat`;
const CHAT_DUAL_URL = cfg.memoryChatDualUrl || `${WEB_MANAGER_URL}/api/chat/dual`;
const FALLBACK_CHAT_DUAL_URL = `${MEMORY_UNIVERSE_URL}/api/chat/dual`;
const CHAT_RESULT_URL = cfg.memoryChatResultUrl || `${WEB_MANAGER_URL}/api/chat/result`;
const FALLBACK_CHAT_RESULT_URL = `${MEMORY_UNIVERSE_URL}/api/chat/result`;
const SUBTITLE_URL = cfg.live2dSubtitleUrl || `http://127.0.0.1:${LIVE2D_PORT}/api/subtitle`;
const TTS_URL = cfg.ttsUrl || `http://127.0.0.1:${TTS_PORT}/api/tts`;
const AUDIO_PLAY_URL = cfg.audioPlayUrl || `http://127.0.0.1:${LIVE2D_PORT}/audio/play`;
const TTS_REQUEST_TIMEOUT_MS = Number(process.env.TTS_REQUEST_TIMEOUT_MS || 120000);
const AUDIO_PLAYBACK_BUFFER_MS = Number(process.env.AUDIO_PLAYBACK_BUFFER_MS || 400);
const DUAL_CHAT_ENABLED = String(process.env.DUAL_CHAT_ENABLED || 'true').trim().toLowerCase() === 'true';
const DUAL_CHAT_BACKGROUND_FOLLOWUP = String(process.env.DUAL_CHAT_BACKGROUND_FOLLOWUP || 'true').trim().toLowerCase() === 'true';
const DUAL_CHAT_BACKGROUND_FOLLOWUP_SPEAK = String(process.env.DUAL_CHAT_BACKGROUND_FOLLOWUP_SPEAK || 'false').trim().toLowerCase() === 'true';
const DUAL_CHAT_POLL_INTERVAL_MS = Number(process.env.DUAL_CHAT_POLL_INTERVAL_MS || 2000);
const DUAL_CHAT_MAX_POLLS = Number(process.env.DUAL_CHAT_MAX_POLLS || 8);
const BACKGROUND_FOLLOWUP_PREFIX = String(process.env.BACKGROUND_FOLLOWUP_PREFIX || '补充一下：').trim();
const TTS_SUBTITLE_SYNC_MODE = String(process.env.TTS_SUBTITLE_SYNC_MODE || 'audio_ready').trim().toLowerCase();
const TTS_SPLIT_MODE = String(process.env.TTS_SPLIT_MODE || 'single').trim().toLowerCase();
const TTS_MIN_SPLIT_LENGTH = Number(process.env.TTS_MIN_SPLIT_LENGTH || 60);
const STREAM_CHAT_ENABLED = String(process.env.STREAM_CHAT_ENABLED || 'true').trim().toLowerCase() === 'true';
const CHAT_STREAM_URL = cfg.memoryChatStreamUrl || `${WEB_MANAGER_URL}/api/chat/stream`;
const FALLBACK_CHAT_STREAM_URL = `${MEMORY_UNIVERSE_URL}/api/chat/stream`;

// 启动时打印配置的 URL
console.log('=== 服务 URL 配置 ===');
console.log('TTS_URL:', TTS_URL);
console.log('SUBTITLE_URL:', SUBTITLE_URL);
console.log('AUDIO_PLAY_URL:', AUDIO_PLAY_URL);
console.log('TTS_SUBTITLE_SYNC_MODE:', TTS_SUBTITLE_SYNC_MODE);
console.log('TTS_SPLIT_MODE:', TTS_SPLIT_MODE, 'TTS_MIN_SPLIT_LENGTH:', TTS_MIN_SPLIT_LENGTH);
console.log('DUAL_CHAT_ENABLED:', DUAL_CHAT_ENABLED, 'DUAL_CHAT_BACKGROUND_FOLLOWUP:', DUAL_CHAT_BACKGROUND_FOLLOWUP, 'DUAL_CHAT_BACKGROUND_FOLLOWUP_SPEAK:', DUAL_CHAT_BACKGROUND_FOLLOWUP_SPEAK);
console.log('CHAT_URL:', CHAT_URL);
console.log('STREAM_CHAT_ENABLED:', STREAM_CHAT_ENABLED);
console.log('=====================');

const USER_ID = cfg.userId || 'danmaku';
const DANMAKU_COOKIE = cfg.danmakuCookie || cfg.cookie || '';
const USER_UID = Number(cfg.userUid || cfg.uid || cfg.userIdNumber || 0) || 0;
const USE_WBI_SIGNATURE = cfg.useWbiSignature !== false;
const DANMAKU_BUVID = cfg.buvid || '';
const DANMAKU_TYPE = Number(cfg.danmakuType ?? 0);
const DANMAKU_WEB_LOCATION = cfg.webLocation || '444.8';
const FIXED_WRID = cfg.wRid || '';
const FIXED_WTS = Number(cfg.wts || 0);

if (!ROOM_ID) {
  console.error('Please set a valid roomId in config.json.');
  process.exit(1);
}
if (!DANMAKU_COOKIE) {
  console.error('Please set danmakuCookie (SESSDATA/DedeUserID/bili_jct) in config.json.');
  process.exit(1);
}

let busy = false;
let liveInstance = null;
let retryTimer = null;
let lastMsgKey = '';
let lastMsgTime = 0;

// ============ 弹幕重连管理�?============
// 使用指数退�?+ 抖动的智能重连策�?
const danmakuReconnectManager = new ReconnectManager({
  initialDelayMs: 2000,      // 初始 2 �?
  maxDelayMs: 120000,        // 最�?2 分钟
  backoffMultiplier: 1.5,    // 退避倍数
  maxRetries: -1,            // 无限重试
  jitterRatio: 0.3,          // 30% 抖动
  heartbeatIntervalMs: 0,    // 不使用内置心跳（LiveWS 有自己的心跳�?
  heartbeatTimeoutMs: 0
}, log);

// 监听重连事件
danmakuReconnectManager.on('reconnecting', ({ retryCount, delayMs }) => {
  log(`[Danmaku] Reconnecting attempt ${retryCount}, delay ${Math.round(delayMs / 1000)}s`);
  broadcastStatus('reconnecting', `Danmaku reconnecting (${retryCount})`);
});

danmakuReconnectManager.on('connected', () => {
  log('[Danmaku] Connected');
  broadcastStatus('idle', 'Danmaku connected');
  danmakuBreaker.reset();
});

danmakuReconnectManager.on('failed', ({ error, retryCount }) => {
  log(`[Danmaku] Reconnect failed after ${retryCount} attempts: ${error}`);
  broadcastStatus('error', 'Danmaku reconnect failed');
});

// Service availability tracking
let serviceAvailable = true;
let lastServiceCheckTime = 0;
const SERVICE_CHECK_INTERVAL = 30000; // 30 seconds
let lastMessageTime = Date.now();

let isTTSPlaying = false;  // TTS 播放锁，防止并发播放
let pendingTTSJob = null;

const CHAT_TIMEOUT_MS = Number(cfg.chatTimeoutMs ?? process.env.WEB_MANAGER_CHAT_TIMEOUT_MS ?? 30000);
const FALLBACK_CHAT_TIMEOUT_MS = Number(
  cfg.fallbackChatTimeoutMs ?? process.env.WEB_MANAGER_FALLBACK_CHAT_TIMEOUT_MS ?? Math.min(CHAT_TIMEOUT_MS, 12000)
);
log(`[配置] Chat timeout: ${CHAT_TIMEOUT_MS}ms`);
log(`[配置] Fallback chat timeout: ${FALLBACK_CHAT_TIMEOUT_MS}ms`);

// ============ P0 修复：消息队�?============
// 防止高峰期消息丢失（当前丢失�?30%�?
class MessageQueue {
  constructor(maxSize = 50) {
    this.queue = [];
    this.maxSize = maxSize;
    this.processing = false;
  }

  async enqueue(message) {
    if (this.queue.length >= this.maxSize) {
      const dropped = this.queue.shift();
      log(`⚠️ 消息队列满，丢弃最旧消�? [${dropped.uname}] ${dropped.message.substring(0, 20)}`);
    }
    this.queue.push(message);
    // 不要在这里调�?process()，让它自动处�?
    if (!this.processing) {
      this.process();
    }
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const msg = this.queue.shift();
      try {
        await processMessage(msg);
      } catch (err) {
        log(`�?消息处理失败: ${err.message}`);
      }
    }

    this.processing = false;
  }
}

const messageQueue = new MessageQueue(50);

// ============ 弹幕导演：窗口聚�?+ 挑�?合并 ============
class ChatOrchestrator {
  constructor(options, onEvents) {
    this.config = options;
    this.onEvents = onEvents;
    this.currentWindow = [];
    this.windowStartTime = Date.now();
    this.lastOutputTime = 0;
    this.flushTimer = null;

    // ShowRunner 联动
    this.currentTopic = '';
    this.topicCounts = new Map();
    this.windowTopicCounts = new Map();
    this.lastTopicRefresh = 0;

    // Topic keyword mapping (kept ASCII to avoid encoding issues)
    this.topicKeywords = new Map([
      ['gaming', ['game', 'play', 'rank', 'win', 'lose', 'hero', 'match']],
      ['movies', ['movie', 'film', 'actor', 'director', 'plot']],
      ['music', ['music', 'song', 'sing', 'album', 'lyrics']],
      ['study', ['study', 'exam', 'homework', 'class', 'teacher']],
      ['work', ['work', 'job', 'meeting', 'project', 'boss']],
      ['stream', ['live', 'stream', 'danmaku', 'gift', 'follow', 'subscribe']],
      ['tech', ['tech', 'code', 'bug', 'dev', 'ai', 'model']],
      ['life', ['life', 'today', 'sleep', 'wake', 'mood', 'daily']],
      ['food', ['food', 'eat', 'restaurant', 'cook', 'snack', 'tea']],
      ['travel', ['travel', 'trip', 'hotel', 'flight', 'scenery']]
    ]);

    // 定期刷新 ShowRunner 话题状�?
    this.startTopicSync();
  }

  // 启动话题同步
  startTopicSync() {
    setInterval(async () => {
      await this.syncShowRunnerTopic();
    }, 10000); // �?0秒同步一�?
  }

  // �?ShowRunner 同步当前话题
  async syncShowRunnerTopic() {
    try {
      const response = await fetch(`${WEB_MANAGER_URL}/api/showrunner/state`, {
        method: 'GET',
        timeout: 3000
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.state?.topic) {
          if (this.currentTopic !== data.state.topic) {
            log(`🎯 [话题同步] ShowRunner 话题: ${data.state.topic}`);
            this.currentTopic = data.state.topic;
          }
        }
      }
    } catch (err) {
      // 静默失败
    }
  }

  // 通知 ShowRunner 更新话题
  async notifyShowRunnerTopic(topic) {
    if (!topic || topic === this.currentTopic) return;

    try {
      await fetch(`${WEB_MANAGER_URL}/api/showrunner/topic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic }),
        timeout: 3000
      });

      this.currentTopic = topic;
      log(`🎯 [话题联动] 通知 ShowRunner 切换话题: ${topic}`);
    } catch (err) {
      // 静默失败
    }
  }

  // 检测弹幕话�?
  detectTopic(text) {
    const lowerText = text.toLowerCase();

    // 优先检测当前话�?
    if (this.currentTopic) {
      const keywords = this.topicKeywords.get(this.currentTopic);
      if (keywords && keywords.some(kw => lowerText.includes(kw))) {
        return this.currentTopic;
      }
    }

    // 遍历所有话题关键词
    for (const [topic, keywords] of this.topicKeywords) {
      if (keywords.some(kw => lowerText.includes(kw))) {
        return topic;
      }
    }

    return null;
  }

  offer(message) {
    this.currentWindow.push(message);

    // 实时检测话�?
    const detectedTopic = this.detectTopic(message.text);
    if (detectedTopic) {
      const count = this.windowTopicCounts.get(detectedTopic) || 0;
      this.windowTopicCounts.set(detectedTopic, count + 1);
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.config.windowMs);
    }
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const now = Date.now();
    if (now - this.lastOutputTime < this.config.cooldownMs) {
      this.resetWindow();
      return;
    }

    const events = this.processWindow();
    this.resetWindow();

    if (events.length > 0) {
      this.lastOutputTime = now;
      this.onEvents(events);
    }
  }

  resetWindow() {
    this.currentWindow = [];
    this.windowStartTime = Date.now();
    this.windowTopicCounts.clear();
  }

  // 检测并通知热点话题
  detectAndNotifyHotTopic() {
    if (this.windowTopicCounts.size === 0) return;

    let hotTopic = '';
    let maxCount = 0;

    this.windowTopicCounts.forEach((count, topic) => {
      if (count > maxCount) {
        maxCount = count;
        hotTopic = topic;
      }
    });

    // 如果某话题出现次�?>= 3，认为是热点
    if (maxCount >= 3 && hotTopic && hotTopic !== this.currentTopic) {
      log(`🔥 [热点检测] 检测到热点话题: ${hotTopic} (出现 ${maxCount} �?`);
      this.notifyShowRunnerTopic(hotTopic);
    }

    // 更新全局话题计数
    this.windowTopicCounts.forEach((count, topic) => {
      const globalCount = this.topicCounts.get(topic) || 0;
      this.topicCounts.set(topic, globalCount + count);
    });
  }

  processWindow() {
    if (this.currentWindow.length === 0) return [];

    // 检测热点话�?
    this.detectAndNotifyHotTopic();

    const scored = this.currentWindow.map(msg => ({
      message: msg,
      score: this.calculateScore(msg),
      features: this.extractFeatures(msg),
      detectedTopic: this.detectTopic(msg.text)
    }));

    const safe = scored.filter(item => item.features.riskPenalty > -999);
    if (safe.length === 0) return [];

    safe.sort((a, b) => b.score - a.score);
    const topN = safe.slice(0, this.config.maxOutPerWindow);

    if (topN.length > 1 && this.config.mergeEnabled) {
      const merged = this.tryMerge(topN);
      if (merged) {
        return [merged];
      }
    }

    const item = topN[0];

    // 通知 ShowRunner 更新话题
    if (item.detectedTopic) {
      this.notifyShowRunnerTopic(item.detectedTopic);
    }

    return [{
      type: 'reply_one',
      message: item.message.text,
      primaryUser: item.message.userId,
      msgId: item.message.msgId || `orch_${Date.now()}`,
      mergedCount: 0,
      originalMessages: [item.message],
      detectedTopic: item.detectedTopic
    }];
  }

  extractFeatures(message) {
    const text = message.text;
    const features = {
      isQuestion: 0,
      hasNameCall: 0,
      isCommand: 0,
      emotionHigh: 0,
      novelty: 0,
      lengthPenalty: 0,
      riskPenalty: 0,
      topicRelevance: 0
    };

    if (/\?/.test(text) || /\b(why|how|what|who|where|when)\b/i.test(text)) {
      features.isQuestion = 2.0;
    }

    if (this.config.hostName && text.includes(this.config.hostName)) {
      features.hasNameCall = 1.0;
    }

    if (/\b(please|tell|say|explain|analyze|review)\b/i.test(text)) {
      features.isCommand = 1.2;
    }

    if (/(lol|haha|!{3,}|~{2,})/i.test(text)) {
      features.emotionHigh = 0.8;
    }

    features.novelty = this.calculateNovelty(message);

    if (text.length <= 2) {
      features.lengthPenalty = -0.8;
    } else if (text.length > 40) {
      features.lengthPenalty = -0.4;
    }

    if (this.containsSensitiveWords(text)) {
      features.riskPenalty = -999;
    }

    // 话题相关性加�?
    features.topicRelevance = this.calculateTopicRelevance(text);

    return features;
  }

  // 计算话题相关�?
  calculateTopicRelevance(text) {
    if (!this.currentTopic) return 0;

    const keywords = this.topicKeywords.get(this.currentTopic);
    if (!keywords) return 0;

    const lowerText = text.toLowerCase();
    const matchCount = keywords.filter(kw => lowerText.includes(kw)).length;

    if (matchCount >= 3) return 1.5;
    if (matchCount >= 2) return 1.0;
    if (matchCount >= 1) return 0.5;

    return 0;
  }

  calculateScore(message) {
    const f = this.extractFeatures(message);
    return (
      f.isQuestion +
      f.hasNameCall +
      f.isCommand +
      f.emotionHigh +
      f.novelty +
      f.lengthPenalty +
      f.riskPenalty +
      f.topicRelevance
    );
  }

  calculateNovelty(message) {
    const normalized = this.normalizeText(message.text);
    const duplicates = this.currentWindow.filter(msg =>
      msg.userId !== message.userId &&
      this.normalizeText(msg.text) === normalized
    );
    if (duplicates.length === 0) return 1.0;
    if (duplicates.length === 1) return 0.5;
    return 0.0;
  }

  normalizeText(text) {
    return text
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[�?]+/g, '!')
      .replace(/[�?]+/g, '?')
      .replace(/[�?]+/g, '.');
  }

  containsSensitiveWords(text) {
    return this.config.sensitiveWords.some(word => word && text.includes(word));
  }

  tryMerge(items) {
    const clusters = this.clusterByTopic(items);
    if (clusters.length === 0 || clusters[0].length < 2) return null;

    const mainCluster = clusters[0];
    const mainMessage = mainCluster[0].message;
    const otherMessages = mainCluster.slice(1).map(item => item.message.text);
    const mergedText = `�?{mainMessage.userId}�?{mainMessage.text}  另外有人也在问：${otherMessages.join('/')}`;

    return {
      type: 'reply_batch',
      message: mergedText,
      primaryUser: mainMessage.userId,
      msgId: mainMessage.msgId || `orch_${Date.now()}`,
      mergedCount: mainCluster.length - 1,
      originalMessages: mainCluster.map(item => item.message)
    };
  }

  clusterByTopic(items) {
    const clusters = new Map();

    items.forEach(item => {
      const topic = item.detectedTopic || 'other';

      if (!clusters.has(topic)) clusters.set(topic, []);
      clusters.get(topic).push(item);
    });

    // 按簇大小排序，但当前话题优先
    return Array.from(clusters.entries())
      .filter(([_, cluster]) => cluster.length > 0)
      .sort((a, b) => {
        // 当前话题优先
        if (a[0] === this.currentTopic && b[0] !== this.currentTopic) return -1;
        if (b[0] === this.currentTopic && a[0] !== this.currentTopic) return 1;
        // 其次按大小排�?
        return b[1].length - a[1].length;
      })
      .map(([_, cluster]) => cluster);
  }
}

const orchestrator = new ChatOrchestrator({
  windowMs: ORCH_WINDOW_MS,
  maxOutPerWindow: ORCH_MAX_OUT_PER_WINDOW,
  cooldownMs: ORCH_COOLDOWN_MS,
  hostName: ORCH_HOST_NAME,
  sensitiveWords: ORCH_SENSITIVE_WORDS,
  mergeEnabled: ORCH_MERGE_ENABLED
}, (events) => {
  events.forEach(event => {
    messageQueue.enqueue({
      uname: event.primaryUser || 'danmaku',
      message: event.message,
      type: event.type,
      msgId: event.msgId || `orch_${Date.now()}`
    });
  });
});

// ============ P0 修复：超时控�?============
// 防止 TTS/Live2D 调用卡死（当前无超时，可能导�?5+ 秒延迟）
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    )
  ]);
}

// ============ P0 修复：断路器 + 降级 ============
// 防止弹幕 API 故障时无限重试（当前无断路器，故障时频繁重连�?
class CircuitBreaker {
  constructor(threshold = 3, timeout = 60000) {
    this.failureCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED';  // CLOSED, OPEN, HALF_OPEN
    this.lastFailureTime = null;
    this.successCount = 0;
  }

  async execute(fn, fallback) {
    if (this.state === 'OPEN') {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure > this.timeout) {
        log(`🔄 断路器进�?HALF_OPEN 状态，尝试恢复... (已等�?${Math.floor(timeSinceFailure / 1000)}�?`);
        this.state = 'HALF_OPEN';
      } else {
        const remainingTime = Math.ceil((this.timeout - timeSinceFailure) / 1000);
        log(`🚫 断路�?OPEN，使用降级方�?(${remainingTime}秒后重试)`);
        return fallback ? await fallback() : null;
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      log(`�?断路�? 调用成功，状�?${this.state}`);
      return result;
    } catch (err) {
      log(`�?断路�? 调用失败 - ${err.message}`);
      this.onFailure();
      if (this.state === 'OPEN' && fallback) {
        log('[Breaker] OPEN - using fallback');
        return await fallback();
      }
      throw err;
    }
  }

  // 手动重置断路器（用于测试或恢复）
  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    log(`🔄 断路器已手动重置`);
  }

  onSuccess() {
    this.failureCount = 0;
    this.successCount++;

    if (this.state === 'HALF_OPEN') {
      if (this.successCount >= 2) {
        log('[Breaker] Back to CLOSED');
        this.state = 'CLOSED';
        this.successCount = 0;
      }
    } else {
      this.state = 'CLOSED';
    }
  }

  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.successCount = 0;

    log(`�?连接失败 (${this.failureCount}/${this.threshold})`);

    if (this.failureCount >= this.threshold) {
      log('[Breaker] OPEN');
      this.state = 'OPEN';
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime
    };
  }
}

const danmakuBreaker = new CircuitBreaker(3, 60000);

// 降级方案：统一使用错误提示，方便识别问�?
const FALLBACK_REPLY = '\u8bf7\u544a\u8bc9\u521b\u4f5c\u8005\uff1aAI\u6682\u65f6\u51fa\u73b0\u95ee\u9898\u3002';

function getRandomFallback() {
  return FALLBACK_REPLY;
}

function hasSpokenContent(text) {
  const t = (text ?? '').toString().trim();
  if (!t) return false;
  // Keep CJK characters; previous \w-based stripping removed Chinese entirely.
  const normalized = t.replace(/\s+/g, '');
  return /[A-Za-z0-9\u4e00-\u9fff]/.test(normalized);
}

function sanitizeBroadcastText(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  t = t
    .replace(/(?:^|\s)Follow-up:\s*/gi, ' ')
    .replace(/要不要我继续把[\s\S]{0,160}?推进到下一步[？?！!]?/g, '')
    .replace(/Do you want me to continue and move [\s\S]{0,160}? to the next step\??/gi, '')
    .replace(/建议选择更有趣或更贴近观众兴趣的话题[。！？!?]?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t;
}

function estimateMinSpeechDurationSec(text) {
  const plain = String(text || '').replace(/\s+/g, '');
  if (!plain) return 0.4;
  const cjkCount = (plain.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinCount = (plain.match(/[A-Za-z0-9]/g) || []).length;
  const weighted = cjkCount + (latinCount * 0.45);
  return Math.max(0.45, Math.min(3.0, weighted * 0.055));
}

function buildRetryTtsText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  return raw
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, ' ')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9，。！？；：、“”‘’,.!?;:'"()\-\s]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Check Web Manager service availability - non-blocking
// Default serviceAvailable=true; run health checks in background so first
// message is never blocked by retries.
async function checkServiceAvailability() {
  const now = Date.now();
  if (now - lastServiceCheckTime < SERVICE_CHECK_INTERVAL) {
    return serviceAvailable;
  }
  lastServiceCheckTime = now;

  // Fire-and-forget background probe
  _probeServicesInBackground();
  return serviceAvailable;
}

async function _probeServicesInBackground() {
  try {
    const resp = await withTimeout(
      fetch(`${WEB_MANAGER_URL}/api/services`, { method: 'GET' }),
      3000,
      'Manager BG Check'
    );
    if (resp.ok) { serviceAvailable = true; return; }
  } catch (_) { /* ignore */ }

  try {
    const resp = await withTimeout(
      fetch(`${MEMORY_UNIVERSE_URL}/health`, { method: 'GET' }),
      3000,
      'MU BG Check'
    );
    if (resp.ok) { serviceAvailable = true; return; }
  } catch (_) { /* ignore */ }

  serviceAvailable = false;
  log('⚠️ All services unreachable (background probe)');
}

// 工具函数
function log(...args) {
  console.log(new Date().toLocaleTimeString(), '-', ...args);
}

// 等待 Live2D 音频播放完成（轮询 /api/audio/current 的 timestamp+duration）
// 先等预估时长，再轮询确认真正播完，避免句间重叠
async function waitForAudioPlaybackDone(expectedDurationSec) {
  const durationMs = (expectedDurationSec || 2) * 1000;
  // 等待预估时长（扣去少量余量，让轮询来精确兜底）
  const earlyWake = Math.min(300, durationMs * 0.15);
  await new Promise(r => setTimeout(r, Math.max(0, durationMs - earlyWake)));

  // 轮询确认播放结束
  const pollInterval = 150;
  const maxExtraWait = durationMs * 0.5 + AUDIO_PLAYBACK_BUFFER_MS; // 最多额外等 50% + buffer
  const maxPolls = Math.ceil(maxExtraWait / pollInterval);
  const audioCurrentUrl = `http://127.0.0.1:${LIVE2D_PORT}/api/audio/current`;

  for (let p = 0; p < maxPolls; p++) {
    try {
      const resp = await withTimeout(fetch(audioCurrentUrl, { method: 'GET' }), 500, 'AudioPoll');
      const data = await resp.json();
      if (!data.audio || !data.audio.timestamp || !data.audio.duration) break;
      const elapsed = Date.now() - data.audio.timestamp;
      const totalMs = data.audio.duration * 1000 + AUDIO_PLAYBACK_BUFFER_MS;
      if (elapsed >= totalMs) break; // 播放完毕
    } catch (_) {
      break; // 查询失败则放行
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }
}

// WebSocket服务器用于推送弹幕到显示页面
const httpServer = http.createServer((req, res) => {
  if (req.url === '/api/status' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'memory-danmaku',
      timestamp: Date.now()
    }));
    return;
  }

  const validRoutes = {
    '/': 'danmaku-overlay.html',
    '/danmaku': 'danmaku-overlay.html',
    '/danmaku-overlay.html': 'danmaku-overlay.html',
    '/test-danmaku.html': 'test-danmaku.html',
    '/status': 'ai-status.html',
    '/ai-status.html': 'ai-status.html',
    '/ambient': 'ambient-animation.html',
    '/ambient-animation.html': 'ambient-animation.html'
  };

  const fileName = validRoutes[req.url];

  if (fileName) {
    const htmlPath = path.join(process.cwd(), fileName);
    fs.readFile(htmlPath, 'utf8', (err, data) => {
      if (err) {
        log('读取文件失败:', htmlPath, err.message);
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const wss = new WebSocketServer({ server: httpServer });
const wsClients = new Set();

wss.on('connection', (ws) => {
  log('Danmaku display connected');
  wsClients.add(ws);

  ws.on('close', () => {
    wsClients.delete(ws);
    log('Danmaku display disconnected');
  });

  ws.on('error', (err) => {
    log('WebSocket error:', err.message);
  });
});

// 广播弹幕到所有连接的显示页面
function broadcastDanmaku(data) {
  if (wsClients.size === 0) return;

  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  });
  log(`[Danmaku] Broadcast: [${data.username}] ${data.message} (${data.type})`);
}

// 广播AI状�?
function broadcastStatus(status, extra = '') {
  if (wsClients.size === 0) return;

  const message = JSON.stringify({
    type: 'status',
    status: status,
    extra: extra,
    timestamp: Date.now()
  });

  wsClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

httpServer.listen(DANMAKU_PORT, DANMAKU_HOST, () => {
  log('=================================');
  log('[Danmaku] Display server started');
  log(`[Danmaku] Overlay: http://${DANMAKU_HOST}:${DANMAKU_PORT}/danmaku-overlay.html`);
  log(`[Danmaku] AI status: http://${DANMAKU_HOST}:${DANMAKU_PORT}/ai-status.html`);
  log(`[Danmaku] Ambient: http://${DANMAKU_HOST}:${DANMAKU_PORT}/ambient-animation.html`);
  log(`[Danmaku] Test: http://${DANMAKU_HOST}:${DANMAKU_PORT}/test-danmaku.html`);
  log('=================================');
});

function safeReason(reason) {
  if (!reason) return '';
  if (Buffer.isBuffer(reason)) return reason.toString('utf8');
  return String(reason);
}

// 使用 ReconnectManager 的智能重�?
function scheduleRetry(delay = 5000) {
  // 清理旧的定时器（兼容旧代码）
  if (retryTimer) clearTimeout(retryTimer);

  // 通知 ReconnectManager 连接断开，让它处理重�?
  if (danmakuReconnectManager.getState() === 'connected') {
    danmakuReconnectManager.onDisconnected('connection lost');
  } else if (danmakuReconnectManager.getState() !== 'reconnecting' &&
    danmakuReconnectManager.getState() !== 'connecting') {
    // 如果不在重连中，通知连接失败触发重连
    danmakuReconnectManager.onConnectionFailed('manual retry requested');
  }
}

async function fetchDanmuInfo(roomId) {
  // 先测�?cookie 是否有效
  try {
    log('检�?Cookie 有效�?..');
    const testResp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'Cookie': DANMAKU_COOKIE,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
      }
    });

    if (testResp.ok) {
      const navData = await testResp.json();
      if (navData.code === 0 && navData.data?.isLogin) {
        log('Cookie 有效，用户已登录:', navData.data.uname);
      } else {
        log('Cookie may be expired; user not logged in.');
      }
    }
  } catch (err) {
    log('Cookie check failed:', err.message);
  }

  const defaultHeaders = {
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
    Cookie: DANMAKU_COOKIE,
    Origin: 'https://live.bilibili.com',
    Referer: `https://live.bilibili.com/${roomId}`,
    Priority: 'u=1, i',
    'sec-ch-ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
  };

  const tryOnce = async ({ wRid, wts, label }) => {
    const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${roomId}&type=${DANMAKU_TYPE}&web_location=${DANMAKU_WEB_LOCATION}&w_rid=${wRid}&wts=${wts}`;
    const headers = {
      ...defaultHeaders,
      ...createDanmakuHeaders(roomId, DANMAKU_COOKIE)
    };
    const resp = await fetch(url, { headers, cache: 'no-store' });
    if (!resp.ok) throw new Error(`getDanmuInfo 返回 ${resp.status} (${label})`);
    const data = await resp.json();
    log('getDanmuInfo', {
      label,
      code: data.code,
      message: data.message,
      live_status: data.data?.live_status,
      token: data.data?.token ? 'ready' : 'missing'
    });
    return data;
  };

  if (FIXED_WRID && FIXED_WTS) {
    const data = await tryOnce({ wRid: FIXED_WRID, wts: FIXED_WTS, label: 'fixed' });
    if (data.code === 0) return data;
    log('Fixed wRid/wts failed, falling back to dynamic signature.');
  }

  // WBI 签名优先
  if (USE_WBI_SIGNATURE) {
    try {
      const { wRid, wts } = await getWbiSignature({
        id: roomId,
        type: DANMAKU_TYPE,
        web_location: DANMAKU_WEB_LOCATION
      }, DANMAKU_COOKIE);
      const data = await tryOnce({ wRid, wts, label: 'wbi' });
      if (data.code === 0) {
        cfg.wRid = wRid;
        cfg.wts = wts;
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        log('WBI 签名成功并已写入配置');
        return data;
      }
      if (data.code === -352) {
        log('WBI 签名被拒绝，切换其他策略');
      }
    } catch (error) {
      log('WBI 签名失败:', error.message);
    }
  }
  // 尝试不同的API端点
  try {
    log('尝试备用API端点...');
    const alternativeUrl = `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`;
    const altResp = await fetch(alternativeUrl, {
      headers: defaultHeaders,
      cache: 'no-store'
    });

    if (altResp.ok) {
      const altData = await altResp.json();
      log('备用API响应:', { code: altData.code, message: altData.message });
      if (altData.code === 0 && altData.data) {
        log('备用API成功！数�?', altData.data);
        // 转换为标准格�?
        const convertedData = {
          code: 0,
          data: {
            token: altData.data.token || '',
            host_list: altData.data.host_server_list || [
              { host: 'broadcastlv.chat.bilibili.com', port: 2243, wss_port: 443 }
            ],
            live_status: 1 // 强制设为开播状态来测试
          }
        };
        return convertedData;
      }
    }
  } catch (error) {
    log('备用API失败:', error.message);
  }

  // Try auto-fetch signature first
  try {
    log('Trying auto-fetch signature params...');
    const { wRid, wts } = await autoFetchSignature(roomId, DANMAKU_COOKIE);
    const data = await tryOnce({ wRid, wts, label: 'auto-fetch' });
    if (data.code === 0) {
      log('Auto-fetch signature OK');
      cfg.wRid = wRid;
      cfg.wts = wts;
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
      log('Saved signature params to config.');
      return data;
    }
  } catch (error) {
    log('Auto-fetch signature failed, using dynamic generation.', error.message);
  }

  // Fallback to dynamic generation
  for (let attempt = 0; attempt < 3; attempt++) {
    const { wRid, wts } = await resolveDanmakuQuery({
      cookie: DANMAKU_COOKIE,
      roomId,
      type: DANMAKU_TYPE,
      web_location: DANMAKU_WEB_LOCATION
    });
    const label = attempt === 0 ? 'dynamic' : `dynamic retry ${attempt}`;
    const data = await tryOnce({ wRid, wts, label });
    if (data.code === 0) return data;
    if (data.code === -352) {
      log(`getDanmuInfo 签名失败 (${label})，重新获�?wRid/wts`);
      continue;
    }
    return data;
  }
  // 最后尝试：使用默认参数直接连接
  log('尝试使用默认参数直接连接WebSocket...');
  try {
    const fallbackData = {
      token: '',
      host_list: [{ host: 'broadcastlv.chat.bilibili.com', port: 2243, wss_port: 443 }]
    };
    return { code: 0, data: fallbackData };
  } catch (error) {
    const errorMsg = `
=== 弹幕连接完全失败 ===
所有方法都失败了，建议�?

1. 检查网络连�?
2. 更新Cookie (可能已过�?
3. 等待无头浏览器下载完成后使用浏览器模拟方�?
4. 或暂时跳过弹幕功�?

当前错误: ${error.message}
========================
`;
    log(errorMsg);
    throw new Error('弹幕连接完全失败');
  }
}

async function connectDanmaku(info) {
  const danmuInfo = info?.data || info;
  const liveStatus = danmuInfo?.live_status ?? 1;
  if (liveStatus !== 1) {
    log('[Danmaku] Room not live (status=' + liveStatus + '), attempting connect anyway.');
    // 不直接返回，继续尝试连接
  }

  const token = danmuInfo.token;
  if (!token) {
    log('[Danmaku] token missing; cannot auth.');
    scheduleRetry(5000);
    return;
  }

  const host = (danmuInfo.host_list || [])[0];
  const address = host ? `wss://${host.host}:${host.wss_port}/sub` : undefined;
  const uid = USER_UID || Number(danmuInfo.uid || 0);
  log('Connecting danmaku...', {
    roomId: ROOM_ID,
    uid,
    address: address || 'default',
    token: token ? 'ok' : 'missing',
    buvid: DANMAKU_BUVID || 'empty'
  });

  liveInstance = new LiveWS(ROOM_ID, {
    key: token,
    uid,
    buvid: DANMAKU_BUVID,
    address
  });

  liveInstance.on('open', () => {
    log('WebSocket connected');
  });

  liveInstance.on('live', () => {
    log('Danmaku connected; start receiving.');
    // 通知 ReconnectManager 连接成功
    danmakuReconnectManager.onConnected();
  });

  liveInstance.on('close', (reason) => {
    log('�?连接关闭:', safeReason(reason));
    liveInstance = null;
    // 使用 ReconnectManager 的智能重�?
    danmakuReconnectManager.onDisconnected(safeReason(reason) || 'connection closed');
  });

  liveInstance.on('error', (err) => {
    log('�?连接错误:', safeReason(err));
    // 使用 ReconnectManager 的智能重�?
    danmakuReconnectManager.onDisconnected(safeReason(err) || 'connection error');
  });

  liveInstance.on('heartbeat', () => { });

  liveInstance.on('msg', (data) => {
    try {
      const cmd = data?.cmd || '';

      // 只处理有用的消息类型
      if (cmd === 'DANMU_MSG') {
        handleDanmaku(data);
      } else if (cmd === 'SEND_GIFT') {
        handleGift(data);
      } else if (cmd === 'SUPER_CHAT_MESSAGE') {
        handleSuperChat(data);
      } else if (cmd === 'GUARD_BUY') {
        handleGuardBuy(data);
      }
      // 忽略 STOP_LIVE_ROOM_LIST, NOTICE_MSG 等无关消�?
    } catch (err) {
      log('处理消息失败', err.message || err);
    }
  });
}

function keyForMsg(uname, message) {
  return `${uname}-${message}`;
}

function handleDanmaku(data) {
  const info = data.info || [];
  const message = info[1] || '';
  const uname = info[2]?.[1] || '';
  const uid = info[2]?.[0] || '';
  const ts = info[0]?.[4] || Date.now();

  log(`收到弹幕: [${uname}] ${message}`);

  // 广播到显示页�?
  broadcastDanmaku({ username: uname, message, type: 'danmaku' });

  // 🆕 发送弹幕样本到风格学习器（所有弹幕都学习，不只是触发的）
  sendDanmakuSample(message, uid, uname);

  if (TRIGGER_PREFIX && !message.startsWith(TRIGGER_PREFIX)) {
    return;
  }

  const trimmed = message.trim();
  if (!trimmed || trimmed.length < REPLY_MIN_LEN) {
    return;
  }

  orchestrator.offer({
    userId: uname,
    text: trimmed,
    timestamp: ts,
    msgId: data.msg_id
  });
  return;
}

// 🆕 发送弹幕样本到风格学习�?
let danmakuSampleBuffer = [];
let danmakuSampleTimer = null;

function sendDanmakuSample(content, userId, username) {
  if (!content || content.length < 2) return;

  danmakuSampleBuffer.push({ content, userId: String(userId), username, timestamp: Date.now() });

  // 批量发送，�?5 秒或�?20 条发送一�?
  if (!danmakuSampleTimer) {
    danmakuSampleTimer = setTimeout(flushDanmakuSamples, 5000);
  }
  if (danmakuSampleBuffer.length >= 20) {
    flushDanmakuSamples();
  }
}

async function flushDanmakuSamples() {
  if (danmakuSampleTimer) {
    clearTimeout(danmakuSampleTimer);
    danmakuSampleTimer = null;
  }

  if (danmakuSampleBuffer.length === 0) return;

  const samples = danmakuSampleBuffer;
  danmakuSampleBuffer = [];

  try {
    const response = await fetch(`${WEB_MANAGER_URL}/api/danmaku-style/learn/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ samples }),
      timeout: 5000
    });

    if (response.ok) {
      const result = await response.json();
      if (result.added > 0) {
        log(`📊 [弹幕风格学习] 已发�?${result.added} 条弹幕样本`);
      }
    }
  } catch (err) {
    // 静默失败，不影响主流�?
  }
}

function handleGift(data) {
  const giftData = data.data || {};
  const uname = giftData.uname || '';
  const giftName = giftData.giftName || '';
  const num = giftData.num || 1;

  log(`收到礼物: [${uname}] 送出 ${giftName} x${num}`);

  const message = `送出 ${giftName} x${num}`;

  // 广播到显示页�?
  broadcastDanmaku({ username: uname, message, type: 'gift' });

  const thankMessage = `感谢 ${uname} 送出�?${giftName} x${num}！`;
  processMessage({ uname, message: thankMessage, type: 'gift', msgId: `gift_${Date.now()}` });
}

function handleSuperChat(data) {
  const scData = data.data || {};
  const uname = scData.user_info?.uname || '';
  const message = scData.message || '';
  const price = scData.price || 0;

  log(`收到SC: [${uname}] ¥${price} - ${message}`);

  // 广播到显示页�?
  broadcastDanmaku({ username: uname, message: `¥${price} ${message}`, type: 'superchat' });

  const thankMessage = `感谢 ${uname} �?${price}�?超级留言�?{message}`;
  processMessage({ uname, message: thankMessage, type: 'superchat', msgId: `sc_${Date.now()}` });
}

function handleGuardBuy(data) {
  const guardData = data.data || {};
  const uname = guardData.username || '';
  const guardLevel = guardData.guard_level || 1;
  const guardName = ['', '总督', '提督', '舰长'][guardLevel] || '舰长';

  log(`收到上舰: [${uname}] 开通了 ${guardName}`);

  // 广播到显示页�?
  broadcastDanmaku({ username: uname, message: `开通了 ${guardName}`, type: 'guard' });

  const message = `感谢 ${uname} 开通了 ${guardName}！欢迎加入舰队！`;
  processMessage({ uname, message, type: 'guard', msgId: `guard_${Date.now()}` });
}

async function processMessage({ uname, message, type, msgId }) {
  lastMessageTime = Date.now();

  const msgKey = keyForMsg(uname, message);
  if (msgKey === lastMsgKey && Math.abs(Date.now() - lastMsgTime) < RATE_LIMIT_MS) {
    return;
  }
  lastMsgKey = msgKey;
  lastMsgTime = Date.now();

  if (busy) {
    log('Busy, skipping message.', message);
    return;
  }
  // isTTSPlaying lock already prevents concurrent playback, so we skip the
  // expensive HTTP round-trip to checkLive2DAudioPlaying().

  busy = true;

  log(`开始处�?{type}消息: [${uname}] ${message}`);

  // 广播状态：收到消息 �?Listening
  broadcastStatus('listening', `收到 ${uname} 的消息`);

  try {
    await streamChatAndSubtitle({ uname, message, msgId });
  } catch (error) {
    log(`[错误] 处理消息失败: ${error.message}`);
    log(`[错误] 详细信息:`, error);
  } finally {
    busy = false;
    // 处理完成后，延迟回到Idle
    setTimeout(() => {
      broadcastStatus('idle', '等待互动�?..');
    }, 3000);
  }
}

// 统一的弹幕处理器 - 负责接收AI回复并统一处理字幕+TTS
async function streamChatAndSubtitle({ uname, message, msgId }) {
  log(`[统一处理器] 开始处理弹幕: [${uname}] ${message}`);

  try {
    // 广播状态：开始思考
    broadcastStatus('thinking', '正在思考回复...');

    // 流式模式：SSE 边生成边切句边 TTS，首句出声更快
    if (STREAM_CHAT_ENABLED) {
      try {
        await _streamPipelineSSE({ uname, message, msgId });
        log(`[统一处理器] 流式处理完成`);
        return;
      } catch (err) {
        log(`[流式] SSE 失败，回退到 dual 模式: ${err.message}`);
      }
    }

    // 1. 调用Memory Universe获取AI回复 (非流式 fallback)
    const aiResponse = await getAIReply(uname, message, { msgId });
    if (!aiResponse || (!aiResponse.text && !aiResponse.response)) {
      log(`[统一处理器] 未收到AI回复`);
      return;
    }

    let aiReply = aiResponse.text || aiResponse.response;
    aiReply = (aiReply ?? '').toString();
    if (!hasSpokenContent(aiReply)) {
      const fallbackText = getRandomFallback();
      log(`[统一处理器] ⚠️ AI回复无有效文本，使用降级方案: "${fallbackText}"`);
      aiReply = fallbackText;
    }
    const metadata = aiResponse.metadata || {};
    const innerState = metadata.innerState || {};

    log(`[统一处理器] 收到AI回复: "${aiReply.substring(0, 50)}..." 心情: ${JSON.stringify(innerState.emotion || {})}`);

    // 广播状态：开始回�?
    broadcastStatus('responding', '正在回复...');

    // 2. 同步处理字幕和TTS - 传入心情数据
    await processTTSWithSubtitle(aiReply, msgId, innerState);

    log(`[统一处理器] 处理完成`);

  } catch (error) {
    log(`[统一处理器] 处理失败:`, error.message);
  }
}

// 获取AI回复 - 优先通过 Manager，失败则直接连接 Memory Universe
async function getAIReply(userId, message, options = {}) {
  log(`[AI回复] 请求: userId=${userId}, message=${message}`);

  // Check service availability first
  const isAvailable = await checkServiceAvailability();
  if (!isAvailable) {
    log(`[AI回复] ⚠️ 所有服务都不可用，使用降级方案`);
    const fallbackText = getRandomFallback();
    return { text: fallbackText, success: true, metadata: {} };
  }

  try {
    // 使用断路器调�?API
    const reply = await danmakuBreaker.execute(
      async () => {
        // 默认走 dual：前台快答 + 后台慢答
        let chatUrl = DUAL_CHAT_ENABLED ? CHAT_DUAL_URL : CHAT_URL;
        let resultUrl = CHAT_RESULT_URL;
        let apiName = 'Manager';

        log(`[AI回复] 正在调用 ${apiName} API: ${chatUrl}`);
        let resp;

        try {
          const body = {
            userId,
            userName: userId,
            message,
            text: message,
            source: 'danmaku'
          };
          const bodyStr = JSON.stringify(body);
          if (bodyStr.includes('undefined') || bodyStr.includes('null')) {
            log(`[AI回复] ⚠️ 发送内容包含异常值: ${bodyStr}`);
          }

          resp = await withTimeout(
            fetch(chatUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                // 暂时移除显式 Content-Length，让 fetch 自动处理编码
              },
              body: bodyStr
            }),
            CHAT_TIMEOUT_MS,
            `${apiName} Chat`
          );
        } catch (error) {
          // 如果 Manager 失败，尝试直接连 Memory Universe
          log(`[AI回复] ⚠️ ${apiName} 调用失败: ${error.message}，尝试直接连�?Memory Universe`);
          chatUrl = DUAL_CHAT_ENABLED ? FALLBACK_CHAT_DUAL_URL : FALLBACK_CHAT_URL;
          resultUrl = FALLBACK_CHAT_RESULT_URL;
          apiName = 'Memory Universe';

          const body = {
            userId,
            userName: userId,
            message,
            text: message,
            source: 'danmaku'
          };
          const bodyStr = JSON.stringify(body);

          resp = await withTimeout(
            fetch(chatUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: bodyStr
            }),
            FALLBACK_CHAT_TIMEOUT_MS,
            `${apiName} Chat`
          );
        }

        log(`[AI回复] ${apiName} API响应状�? ${resp.status}`);

        if (!resp.ok) {
          const errorText = await resp.text();
          log(`[AI回复] ${apiName} API错误响应: ${errorText}`);
          throw new Error(`${apiName} API错误: ${resp.status} - ${errorText.substring(0, 100)}`);
        }

        const data = await resp.json();
        log(`[AI回复] ${apiName} API响应数据: ${JSON.stringify(data).substring(0, 200)}`);

        // 如果是 Universe 返回 400 且含有 detail，说明 BodyParser 报错了
        if (resp.status === 400 && data.error === 'Invalid JSON body') {
          log(`[AI回复] ⚠️ Universe 报 Body 解析错误: ${data.detail}。当前请求 body 可能损坏。`);
          throw new Error(`Universe BodyParser Error: ${data.detail}`);
        }

        if (!data.success) {
          // Check for specific error codes
          if (data.error?.includes('CIRCUIT_BREAKER_OPEN')) {
            log(`[AI回复] ⚠️ 服务断路器已打开，使用降级方案`);
            const fallbackText = getRandomFallback();
            return { text: fallbackText, success: true, metadata: {} };
          }
          if (data.error?.includes('SERVICE_UNAVAILABLE')) {
            log(`[AI回复] ⚠️ 后端服务不可用，使用降级方案`);
            serviceAvailable = false;
            const fallbackText = getRandomFallback();
            return { text: fallbackText, success: true, metadata: {} };
          }
          throw new Error(`AI未返回成功响�? ${data.error || 'unknown error'}`);
        }

        const payload = data.foreground || data;
        if (DUAL_CHAT_ENABLED && DUAL_CHAT_BACKGROUND_FOLLOWUP && data.jobId && options.msgId) {
          scheduleBackgroundFollowup({
            apiName,
            resultUrl,
            jobId: data.jobId,
            userId,
            msgId: options.msgId,
            foregroundText: payload.text || payload.response || ''
          });
        }

        // Manager returns 'text' field, Memory Universe returns 'response' field
        const responseText = sanitizeBroadcastText(payload.text || payload.response);
        if (typeof responseText !== 'string') {
          throw new Error(`AI未返回有效回�? text/response字段为空`);
        }
        if (responseText.trim().length === 0) {
          log('[AI回复] 空回复，跳过输出');
          return { text: '', success: true, metadata: {} };
        }

        payload.text = responseText;

        // Log metadata if available
        if (payload.metadata) {
          log(`[AI回复] 元数�? 决策耗时=${payload.metadata.decisionTime}ms, 生成耗时=${payload.metadata.generationTime}ms, 总耗时=${payload.metadata.totalTime}ms, 降级=${payload.metadata.fallbackUsed}`);
        }

        log(`[AI回复] �?收到回复: "${responseText.substring(0, 50)}..."`);
        return payload; // 返回整个对象以便获取元数据
      },
      async () => {
        // 降级方案：返回预设回�?
        const fallbackText = getRandomFallback();
        log(`[AI回复] ⚠️ 使用降级方案: "${fallbackText}"`);
        return { text: fallbackText, success: true, metadata: {} };
      }
    );

    return reply;
  } catch (error) {
    log(`[AI回复] �?获取失败: ${error.message}`);
    // 最后的降级方案
    const fallbackText = getRandomFallback();
    return { text: fallbackText, success: true, metadata: {} };
  }
}

async function scheduleBackgroundFollowup({
  apiName,
  resultUrl,
  jobId,
  userId,
  msgId,
  foregroundText
}) {
  if (!jobId || !resultUrl) return;

  setTimeout(async () => {
    try {
      log(`[AI回复][慢路] 开始轮询 ${apiName} job=${jobId}`);
      for (let i = 0; i < DUAL_CHAT_MAX_POLLS; i += 1) {
        const pollResp = await withTimeout(
          fetch(`${resultUrl}?jobId=${encodeURIComponent(jobId)}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
          }),
          8000,
          'DualResult'
        );

        if (!pollResp.ok) {
          await new Promise((resolve) => setTimeout(resolve, DUAL_CHAT_POLL_INTERVAL_MS));
          continue;
        }

        const pollData = await pollResp.json();
        if (!pollData?.success || !pollData.status) {
          await new Promise((resolve) => setTimeout(resolve, DUAL_CHAT_POLL_INTERVAL_MS));
          continue;
        }

        if (pollData.status === 'pending') {
          await new Promise((resolve) => setTimeout(resolve, DUAL_CHAT_POLL_INTERVAL_MS));
          continue;
        }

        if (pollData.status !== 'done') {
          log(`[AI回复][慢路] job=${jobId} 状态=${pollData.status}，不补发`);
          return;
        }

        let followText = sanitizeBroadcastText(pollData?.result?.text || pollData?.result?.response || '');
        followText = String(followText || '').trim();
        if (!hasSpokenContent(followText)) {
          log(`[AI回复][慢路] job=${jobId} 无有效文本`);
          return;
        }

        const baseText = String(foregroundText || '').trim();
        if (baseText && followText === baseText) {
          log(`[AI回复][慢路] job=${jobId} 与快路一致，跳过补发`);
          return;
        }

        const broadcastText = BACKGROUND_FOLLOWUP_PREFIX
          ? `${BACKGROUND_FOLLOWUP_PREFIX}${followText}`
          : followText;
        const followMsgId = `${msgId || 'dm'}_bg_${Date.now()}`;
        if (!DUAL_CHAT_BACKGROUND_FOLLOWUP_SPEAK) {
          log(`[AI回复][慢路] job=${jobId} 已生成补发，但按配置不播报: "${broadcastText.substring(0, 50)}..."`);
          return;
        }
        log(`[AI回复][慢路] job=${jobId} 补发: "${broadcastText.substring(0, 50)}..." user=${userId}`);
        await processTTSWithSubtitle(broadcastText, followMsgId, pollData?.result?.metadata?.innerState || {});
        return;
      }

      log(`[AI回复][慢路] job=${jobId} 轮询超时，放弃补发`);
    } catch (error) {
      log(`[AI回复][慢路] job=${jobId} 轮询失败: ${error.message}`);
    }
  }, 0);
}

// 统一字幕发�?- 累积显示�?-3秒后消失
async function sendSubtitle(text, msgId) {
  if (!text || !text.trim()) return;

  try {
    await fetch(SUBTITLE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.trim(),
        duration_ms: 2500, // 2.5秒后消失
        msg_id: msgId || ''
      })
    });
    log(`[字幕] 发送完�?(累积显示�?.5s后消�?: "${text.substring(0, 30)}..."`);
  } catch (err) {
    log(`[字幕] 发送失�?`, err.message);
  }
}

// 累积字幕发�?- 每次发送累积的文本（不设置自动消失�?
async function sendCumulativeSubtitle(accumulatedText, msgId) {
  if (!accumulatedText || !accumulatedText.trim()) return;

  try {
    const response = await fetch(SUBTITLE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: accumulatedText.trim(),
        duration_ms: 0, // 永远不设置自动消失，由整段结束后统一清空
        msg_id: msgId || ''
      })
    });

    if (response.ok) {
      log(`[累积字幕] �?发送成�?(累积显示): "${accumulatedText}"`);
    } else {
      log(`[累积字幕] �?发送失�?HTTP ${response.status}: "${accumulatedText.substring(0, 30)}..."`);
    }
  } catch (err) {
    log(`[累积字幕] �?网络错误:`, err.message);
  }
}

// 同步处理字幕和TTS - 累积显示每个小句
async function processTTSWithSubtitle(text, msgId, innerState = {}) {
  if (!text || !text.trim()) return;

  // 检查是否有 TTS 正在播放
  if (isTTSPlaying) {
    pendingTTSJob = { text, msgId, innerState };
    log(`[TTS锁] 已有TTS正在播放，改为排队最后一条: "${text.substring(0, 30)}..."`);
    return;
  }

  isTTSPlaying = true;
  log(`[TTS锁] 获取播放锁，开始播�? "${text.substring(0, 30)}..."`);

  try {
    await _processTTSWithSubtitleInternal(text, msgId, innerState);
  } finally {
    isTTSPlaying = false;
    log(`[TTS锁] 释放播放锁`);
    if (pendingTTSJob) {
      const nextJob = pendingTTSJob;
      pendingTTSJob = null;
      setTimeout(() => {
        processTTSWithSubtitle(nextJob.text, nextJob.msgId, nextJob.innerState).catch((error) => {
          log(`[TTS锁] 队列任务失败: ${error.message}`);
        });
      }, 0);
    }
  }
}

// 内部实现函数
async function _processTTSWithSubtitleInternal(text, msgId, innerState = {}) {
  if (!text || !text.trim()) return;

  // 根据心情选择 Live2D 动作 (Motion)
  let live2dMotion = '';
  const emotions = innerState.emotion || {};

  if (emotions.joy > 0.8) live2dMotion = 'happy';
  else if (emotions.anger > 0.5) live2dMotion = 'angry';
  else if (emotions.sadness > 0.5) live2dMotion = 'sad';
  else if (emotions.fatigue > 0.7) live2dMotion = 'tired';
  else if (emotions.curiosity > 0.7) live2dMotion = 'thinking';

  log('[Emotion] Selected motion: ' + (live2dMotion || 'none') + ', state: ' + JSON.stringify(emotions));

  const phrases = splitTtsPhrases(text);

  if (phrases.length === 0) {
    const fallbackText = getRandomFallback();
    log(`[累积字幕] ⚠️ 分句后没有可播报内容，使用降级文�? "${fallbackText}"`);
    phrases.push(fallbackText);
  }

  log(`[累积字幕] 分句完成，共${phrases.length}个短语`);

  let accumulatedText = ''; // 累积的字幕文�?

  // 顺序播放每个短语，累积显示字�?
  // Pipeline prefetch: pre-synthesize next phrase while current one plays
  const emotionStr = emotions.joy > 0.7 ? 'happy' : emotions.sadness > 0.4 ? 'sad' : 'neutral';
  async function prefetchTts(text) {
    try {
      const resp = await withTimeout(
        fetch(TTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, emotion: emotionStr })
        }),
        TTS_REQUEST_TIMEOUT_MS,
        'TTS-prefetch'
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.success ? data : null;
    } catch (e) { return null; }
  }
  let nextPrefetchPromise = null; // prefetchTts(phrases[0]) : null;

  for (let i = 0; i < phrases.length; i++) {
    const phraseStartAt = Date.now();
    const phrase = phrases[i];
    accumulatedText += phrase; // 累积文本

    // P0 FIX: Clean text for TTS to prevent F5-TTS hallucination
    const ttsPayloadText = cleanTtsText(phrase);
    log(`[TTS清洗] 原文: "${phrase}" -> 清洗后: "${ttsPayloadText}"`);

    if (!ttsPayloadText) {
      log(`[TTS清洗] 文本为空，跳过TTS: "${phrase}"`);
      if (TTS_SUBTITLE_SYNC_MODE !== 'subtitle_first') {
        await sendCumulativeSubtitle(accumulatedText, msgId);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }

    // 只在第一句时发送动作指�?
    const currentMotion = (i === 0) ? live2dMotion : '';

    log(`[累积字幕] 处理短语 ${i + 1}/${phrases.length}: "${phrase}"`);

    const subtitleFirst = TTS_SUBTITLE_SYNC_MODE === 'subtitle_first';
    if (subtitleFirst) {
      await sendCumulativeSubtitle(accumulatedText, msgId);
      log(`[TTS链路] phrase ${i + 1}/${phrases.length} subtitle sent first, t=${Date.now() - phraseStartAt}ms`);
    }

    try {
      // TTS 超时设置为可配置（首轮加载模型可能较慢）
      const ttsFetchStartAt = Date.now();
      // Try to use prefetched result first
      if (nextPrefetchPromise) {
        const prefetched = await nextPrefetchPromise;
        nextPrefetchPromise = null;
        if (prefetched) {
          const pf_audioPath = prefetched.audioPath || prefetched.audio_url || prefetched.audioUrl;
          if (pf_audioPath) {
            log(`[TTS\u94fe\u8def] phrase ${i + 1}/${phrases.length} PREFETCHED, elapsed=${Date.now() - ttsFetchStartAt}ms`);
            if (!subtitleFirst) {
              await sendCumulativeSubtitle(accumulatedText, msgId);
            }
            await Promise.all([
              withTimeout(
                fetch(AUDIO_PLAY_URL, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    audioPath: pf_audioPath,
                    duration: prefetched.duration,
                    mouthParams: prefetched.mouthParams,
                    msg_id: msgId || '',
                    text: phrase,
                    emotion: 'neutral',
                    motion: currentMotion
                  })
                }),
                5000,
                'Audio'
              )
            ]);
            if (i === phrases.length - 1) {
              setTimeout(async () => { await clearSubtitle(msgId); }, (prefetched.duration || 2) * 1000 + 2500);
            }
            const dur_pf = prefetched.duration || 2;
            if (i + 1 < phrases.length) {
              nextPrefetchPromise = prefetchTts(phrases[i + 1]);
            }
            await waitForAudioPlaybackDone(dur_pf);
            continue;
          }
        }
      }
      // Prefetch miss - start prefetching next while we do normal fetch
      if (i + 1 < phrases.length && !nextPrefetchPromise) {
        nextPrefetchPromise = prefetchTts(phrases[i + 1]);
      }
      const ttsResp = await withTimeout(
        fetch(TTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: ttsPayloadText,
            emotion: emotions.joy > 0.7 ? 'happy' : emotions.sadness > 0.4 ? 'sad' : 'neutral'
          })
        }),
        TTS_REQUEST_TIMEOUT_MS,
        'TTS'
      );
      log(`[TTS链路] phrase ${i + 1}/${phrases.length} tts response status=${ttsResp.status} elapsed=${Date.now() - ttsFetchStartAt}ms`);

      if (!ttsResp.ok) {
        log(`[累积字幕] TTS合成失败: ${ttsResp.status}`);
        if (!subtitleFirst) {
          await sendCumulativeSubtitle(accumulatedText, msgId);
        }
        if (i === phrases.length - 1) setTimeout(() => clearSubtitle(msgId), 2500);
        continue;
      }

      const ttsData = await ttsResp.json();
      if (!ttsData.success) {
        log(`[累积字幕] TTS合成失败: ${ttsData.error}`);
        if (!subtitleFirst) {
          await sendCumulativeSubtitle(accumulatedText, msgId);
        }
        if (i === phrases.length - 1) setTimeout(() => clearSubtitle(msgId), 2500);
        continue;
      }
      let finalTtsData = ttsData;
      let audioPath = finalTtsData.audioPath || finalTtsData.audio_url || finalTtsData.audioUrl;
      const minDuration = 0; // estimateMinSpeechDurationSec(phrase);
      if ((Number(finalTtsData.duration) || 0) < minDuration) {
        const retryText = buildRetryTtsText(phrase);
        if (retryText && retryText !== phrase) {
          log(`[TTS修复] 时长异常短(${finalTtsData.duration}s<${minDuration.toFixed(2)}s)，重试清洗文本: "${retryText.substring(0, 40)}"`);
          try {
            const retryResp = await withTimeout(
              fetch(TTS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  text: retryText,
                  emotion: emotions.joy > 0.7 ? 'happy' : emotions.sadness > 0.4 ? 'sad' : 'neutral',
                  bypass_cache: true
                })
              }),
              TTS_REQUEST_TIMEOUT_MS,
              'TTS-Retry'
            );
            if (retryResp.ok) {
              const retryData = await retryResp.json();
              if (retryData.success) {
                finalTtsData = retryData;
                audioPath = finalTtsData.audioPath || finalTtsData.audio_url || finalTtsData.audioUrl;
                log(`[TTS修复] 重试成功，duration=${finalTtsData.duration}s`);
              }
            }
          } catch (retryErr) {
            log(`[TTS修复] 重试失败: ${retryErr.message}`);
          }
        }
      }
      if (!audioPath) {
        log('[累积字幕] TTS返回缺少 audioPath/audio_url');
        continue;
      }

      // 默认在音频就绪后再更新字幕，避免“先出字再等声音”的体感问题
      if (!subtitleFirst) {
        await sendCumulativeSubtitle(accumulatedText, msgId);
        log(`[TTS链路] phrase ${i + 1}/${phrases.length} subtitle sent after audio_ready, t=${Date.now() - phraseStartAt}ms`);
      }

      // �?P0 修复：并行发送字幕、音频和动作
      log(`[TTS链路] phrase ${i + 1}/${phrases.length} dispatch audio, totalElapsed=${Date.now() - phraseStartAt}ms, audioDuration=${finalTtsData.duration || 0}s`);
      await Promise.all([
        withTimeout(
          fetch(AUDIO_PLAY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audioPath,
              duration: finalTtsData.duration,
              mouthParams: finalTtsData.mouthParams,
              msg_id: msgId || '',
              text: phrase,
              emotion: 'neutral',
              // 关键：将动作指令传给 Live2D
              motion: currentMotion
            })
          }),
          5000,
          'Audio'
        )
      ]);

      if (i === phrases.length - 1) {
        setTimeout(async () => {
          await clearSubtitle(msgId);
        }, (finalTtsData.duration || 2) * 1000 + 2500);
      }

      const duration = finalTtsData.duration || 2;
      // Start prefetching next phrase while current one plays
      if (i + 1 < phrases.length && !nextPrefetchPromise) {
        nextPrefetchPromise = prefetchTts(phrases[i + 1]);
      }
      await waitForAudioPlaybackDone(duration);

    } catch (err) {
      log(`[累积字幕] 处理短语失败: ${err.message} (phraseElapsed=${Date.now() - phraseStartAt}ms)`);
    }
  }
  log(`[累积字幕] 所有短语播放完成，字幕将在2.5秒后消失`);
}


/**
 * 清洗文本，移除 F5-TTS 可能产生幻觉的符号
 */
function cleanTtsText(text) {
  if (!text) return '';
  return text
    .replace(/\（.*?\）/g, '') // 全角括号
    .replace(/\(.*?\)/g, '')   // 半角括号
    .replace(/[~～]/g, '')     // 波浪号
    .replace(/\s+/g, ' ')      // 空格
    .trim();
}

function splitTtsPhrases(text) {
  const rawText = String(text || '').trim();
  if (!rawText) return [];

  if (TTS_SPLIT_MODE !== 'sentence' || rawText.length < TTS_MIN_SPLIT_LENGTH) {
    return hasSpokenContent(rawText) ? [rawText] : [];
  }

  // Split on sentence-ending punctuation; avoid colon to prevent mid-sentence cuts like "收到：测试".
  const sentences = rawText.split(/([。！？；!?;，,～~])/);
  const rawPhrases = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const sentence = sentences[i];
    const punctuation = sentences[i + 1] || '';
    if (sentence && sentence.trim()) {
      const phrase = (sentence + punctuation).trim();
      if (phrase.length > 0 && hasSpokenContent(phrase)) {
        rawPhrases.push(phrase);
      }
    }
  }

  // Merge very short fragments (< 5 chars) with the next phrase for natural speech
  const phrases = [];
  let buffer = '';
  for (const p of rawPhrases) {
    buffer += p;
    if (buffer.length >= 5) {
      phrases.push(buffer);
      buffer = '';
    }
  }
  if (buffer) {
    if (phrases.length > 0) phrases[phrases.length - 1] += buffer;
    else if (hasSpokenContent(buffer)) phrases.push(buffer);
  }

  return phrases;
}

// 清空字幕的辅助函�?
async function clearSubtitle(msgId) {
  try {
    await fetch(SUBTITLE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '', // 清空字幕
        duration_ms: 0,
        msg_id: msgId || ''
      })
    });
    log(`[累积字幕] �?整段话播放完成，字幕已清空`);
  } catch (err) {
    log(`[累积字幕] �?清空字幕失败:`, err.message);
  }
}

// ============ SSE 流式管线 ============
// 从 SSE 流中逐句 yield 完整句子
async function* _yieldSentencesFromSSE(userId, message, options = {}) {
  const isAvailable = await checkServiceAvailability();
  if (!isAvailable) throw new Error('All services unavailable');

  const endpoints = [
    { url: CHAT_STREAM_URL, timeout: CHAT_TIMEOUT_MS, name: 'Manager' },
    { url: FALLBACK_CHAT_STREAM_URL, timeout: FALLBACK_CHAT_TIMEOUT_MS, name: 'MU' }
  ];

  let resp = null;
  for (const ep of endpoints) {
    try {
      const r = await withTimeout(
        fetch(ep.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, userName: userId, message, text: message, source: 'danmaku' })
        }),
        ep.timeout,
        `${ep.name} SSE`
      );
      if (r.ok && r.body) {
        log(`[流式] 连接 ${ep.name} SSE 成功`);
        resp = r;
        break;
      }
      log(`[流式] ${ep.name} SSE 返回 ${r.status}`);
    } catch (err) {
      log(`[流式] ${ep.name} SSE 连接失败: ${err.message}`);
    }
  }

  if (!resp?.body) throw new Error('SSE connection failed to all endpoints');

  const SENTENCE_ENDS = /[。！？；!?;]/;
  let tokenBuf = '';
  let sseBuf = '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuf += decoder.decode(value, { stream: true });
      const lines = sseBuf.split('\n');
      sseBuf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          if (tokenBuf.trim()) yield tokenBuf;
          return;
        }

        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.error) throw new Error(`SSE error: ${parsed.error}`);
          const token = parsed.token ?? '';
          tokenBuf += token;

          // Yield complete sentences as they form
          let match;
          while ((match = SENTENCE_ENDS.exec(tokenBuf)) !== null) {
            const sentence = tokenBuf.slice(0, match.index + 1);
            tokenBuf = tokenBuf.slice(match.index + 1);
            if (sentence.trim()) yield sentence;
          }
        } catch (e) {
          if (e.message.startsWith('SSE error:')) throw e;
          // JSON parse error for non-JSON lines, skip
        }
      }
    }
    // Stream ended without [DONE] — yield remaining
    if (tokenBuf.trim()) yield tokenBuf;
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
}

// 流式管线：SSE → 逐句 TTS → Live2D
async function _streamPipelineSSE({ uname, message, msgId }) {
  if (isTTSPlaying) throw new Error('TTS busy');
  isTTSPlaying = true;

  try {
    broadcastStatus('responding', '正在回复...');

    let accumulatedText = '';
    let phraseIndex = 0;
    let lastTtsDuration = 0;
    const emotionStr = 'neutral';
    const subtitleFirst = TTS_SUBTITLE_SYNC_MODE === 'subtitle_first';

    for await (const sentence of _yieldSentencesFromSSE(uname, message, { msgId })) {
      if (!hasSpokenContent(sentence)) {
        accumulatedText += sentence;
        continue;
      }

      const ttsPayloadText = cleanTtsText(sentence);
      if (!ttsPayloadText) {
        accumulatedText += sentence;
        await sendCumulativeSubtitle(accumulatedText, msgId);
        await new Promise(r => setTimeout(r, 300));
        phraseIndex++;
        continue;
      }

      accumulatedText += sentence;
      const phraseStartAt = Date.now();
      const currentMotion = (phraseIndex === 0) ? '' : '';

      log(`[流式TTS] 处理短语 ${phraseIndex + 1}: "${sentence.substring(0, 40)}"`);

      if (subtitleFirst) {
        await sendCumulativeSubtitle(accumulatedText, msgId);
      }

      try {
        const ttsResp = await withTimeout(
          fetch(TTS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: ttsPayloadText, emotion: emotionStr })
          }),
          TTS_REQUEST_TIMEOUT_MS,
          'TTS-Stream'
        );

        log(`[流式TTS] phrase ${phraseIndex + 1} tts status=${ttsResp.status} elapsed=${Date.now() - phraseStartAt}ms`);

        if (!ttsResp.ok) {
          if (!subtitleFirst) await sendCumulativeSubtitle(accumulatedText, msgId);
          phraseIndex++;
          continue;
        }

        const ttsData = await ttsResp.json();
        if (!ttsData.success) {
          if (!subtitleFirst) await sendCumulativeSubtitle(accumulatedText, msgId);
          phraseIndex++;
          continue;
        }

        const audioPath = ttsData.audioPath || ttsData.audio_url || ttsData.audioUrl;
        if (!audioPath) { phraseIndex++; continue; }

        if (!subtitleFirst) {
          await sendCumulativeSubtitle(accumulatedText, msgId);
        }

        log(`[流式TTS] phrase ${phraseIndex + 1} dispatch audio, elapsed=${Date.now() - phraseStartAt}ms, duration=${ttsData.duration || 0}s`);

        await withTimeout(
          fetch(AUDIO_PLAY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audioPath,
              duration: ttsData.duration,
              mouthParams: ttsData.mouthParams,
              msg_id: msgId || '',
              text: sentence,
              emotion: emotionStr,
              motion: currentMotion
            })
          }),
          5000,
          'Audio-Stream'
        );

        lastTtsDuration = ttsData.duration || 2;
        await waitForAudioPlaybackDone(lastTtsDuration);
      } catch (err) {
        log(`[流式TTS] 短语 ${phraseIndex + 1} 失败: ${err.message}`);
      }

      phraseIndex++;
    }

    // 无有效内容时使用降级
    if (phraseIndex === 0) {
      const fallbackText = getRandomFallback();
      log(`[流式] 无有效内容，使用降级: "${fallbackText}"`);
      accumulatedText = fallbackText;
      await sendCumulativeSubtitle(accumulatedText, msgId);
      try {
        const ttsResp = await withTimeout(
          fetch(TTS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: fallbackText, emotion: 'neutral' })
          }),
          TTS_REQUEST_TIMEOUT_MS,
          'TTS-Fallback'
        );
        if (ttsResp.ok) {
          const ttsData = await ttsResp.json();
          const audioPath = ttsData.success && (ttsData.audioPath || ttsData.audio_url || ttsData.audioUrl);
          if (audioPath) {
            await withTimeout(
              fetch(AUDIO_PLAY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audioPath, duration: ttsData.duration, mouthParams: ttsData.mouthParams, msg_id: msgId || '', text: fallbackText, emotion: 'neutral' })
              }),
              5000,
              'Audio-Fallback'
            );
            lastTtsDuration = ttsData.duration || 2;
            await waitForAudioPlaybackDone(lastTtsDuration);
          }
        }
      } catch (e) { log(`[流式] 降级 TTS 失败: ${e.message}`); }
    }

    setTimeout(async () => { await clearSubtitle(msgId); }, (lastTtsDuration || 2) * 1000 + 2500);
    log(`[流式] 所有短语播放完成，字幕将在2.5秒后消失`);

  } finally {
    isTTSPlaying = false;
    log(`[TTS锁] 释放播放锁 (流式)`);
    if (pendingTTSJob) {
      const nextJob = pendingTTSJob;
      pendingTTSJob = null;
      setTimeout(() => {
        processTTSWithSubtitle(nextJob.text, nextJob.msgId, nextJob.innerState).catch(e => {
          log(`[TTS锁] 队列任务失败: ${e.message}`);
        });
      }, 0);
    }
  }
}

// ============ SoVITS 保活 ============
async function _sovitsKeepalive() {
  try {
    await withTimeout(
      fetch(TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '', emotion: 'neutral', keepalive: true })
      }),
      3000,
      'SoVITS-Keepalive'
    );
  } catch (_) { /* silent */ }
}

function parseSSEEventBlock(block) {
  if (!block.trim()) return null;
  const lines = block.split(/\r?\n/);
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  const dataStr = dataLines.join('\n');
  let dataObj;
  try {
    dataObj = JSON.parse(dataStr);
    // 保持使用 SSE 头部�?event 类型，不要被 JSON 中的 event 字段覆盖
    // 因为记忆宇宙发送的格式�? event: part \n data: {"text": "..."}
  } catch {
    dataObj = { text: dataStr };
  }
  // 规范化事件名，防�?\r / 空格 / 大小写问�?
  const normalizeEvent = (s) => (s ?? 'message').toString().trim().toLowerCase();
  event = normalizeEvent(event);

  return { event, data: dataObj };
}

function getRoomInit(roomId) {
  return new Promise((resolve) => {
    const url = `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`;
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const realId = json.data?.room_id || roomId;
            log('房间ID转换:', roomId, '->', realId);
            resolve({
              roomId: realId,
              live_status: json.data?.live_status ?? 0
            });
          } catch {
            resolve({ roomId, live_status: 0 });
          }
        });
      })
      .on('error', () => resolve({ roomId, live_status: 0 }));
  });
}

(async function bootstrap() {
  log('🚀 Bootstrap 启动...');
  try {
    log('📍 Step 1: 获取房间信息...');
    const info = await getRoomInit(ROOM_ID);
    log('[Bootstrap] Room info:', info);
    ROOM_ID = info.roomId;
    if (info.live_status !== 1) {
      log('[Bootstrap] Room not live (status=' + info.live_status + '), still trying.');
    }

    log('[Bootstrap] Step 2: start SoVITS keepalive...');
    _sovitsKeepalive();
    setInterval(_sovitsKeepalive, 60000);

    log('[Bootstrap] Step 3: start danmaku bridge...');
    startBridge();
    log('[Bootstrap] Danmaku bridge started.');

    log('[Bootstrap] Completed.');
  } catch (error) {
    log('[Bootstrap] Failed:', error.message);
    log('[Bootstrap] Error stack:', error.stack);
  }
})();

process.stdin.resume();

process.on('SIGINT', () => {
  log('Shutting down...');
  if (retryTimer) clearTimeout(retryTimer);
  if (liveInstance) {
    liveInstance.close();
    liveInstance = null;
  }
  process.exit(0);
});

async function startBridge() {
  if (liveInstance) {
    log('连接已建立，跳过重复启动');
    return;
  }

  // �?P0 修复：使用断路器包装连接
  try {
    await danmakuBreaker.execute(
      async () => {
        const danmuData = await fetchDanmuInfo(ROOM_ID);
        if (danmuData.code !== 0) {
          throw new Error(`getDanmuInfo 返回异常 code=${danmuData.code}`);
        }
        await connectDanmaku(danmuData.data);
      },
      async () => {
        // 降级方案：进入离线模�?
        log('[Danmaku] Connection failed, entering offline mode.');
        log('You can send messages to /api/chat for testing.');
        // 使用 ReconnectManager 的智能重�?
        danmakuReconnectManager.onConnectionFailed('Danmaku connection failed');
      }
    );
  } catch (err) {
    log('Fetch danmaku info failed:', err.message || err);
    // 使用 ReconnectManager 的智能重�?
    danmakuReconnectManager.onConnectionFailed(err.message || 'Fetch danmaku info failed');
  }
}

// 配置 ReconnectManager 的连接函�?
danmakuReconnectManager.setConnectFunction(async () => {
  // 清理旧连�?
  if (liveInstance) {
    try {
      liveInstance.close();
    } catch (e) {
      // 忽略
    }
    liveInstance = null;
  }

  // 执行连接
  const danmuData = await fetchDanmuInfo(ROOM_ID);
  if (danmuData.code !== 0) {
    throw new Error(`getDanmuInfo 返回异常 code=${danmuData.code}`);
  }
  await connectDanmaku(danmuData.data);
});

danmakuReconnectManager.setDisconnectFunction(() => {
  if (liveInstance) {
    try {
      liveInstance.close();
    } catch (e) {
      // 忽略
    }
    liveInstance = null;
  }
});
