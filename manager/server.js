// Memory Suite Manager Server (rebuilt)

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');
const axios = require('axios');
const { createProxyMiddleware } = require('http-proxy-middleware');

const { listInstalledTools, setToolEnabled, getEnabledToolSchemas, callTool, getToolCallLogs, getToolNetworkLogs } = require('./tool-system');
const { isPortInUse, getPortPid, killProcess, cleanupPort } = require('../shared/PortManager');

const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const app = express();
// 与 README 端口对齐
const PORT = Number.parseInt(process.env.MANAGER_PORT || '8080', 10);
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// 容错 JSON 解析中间件
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json') || req.method === 'GET' || req.method === 'HEAD' || req.path.startsWith('/api/services/')) {
    return next();
  }

  let rawData = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    rawData += chunk;
  });

  req.on('end', () => {
    if (!rawData) return next();
    try {
      req.body = JSON.parse(rawData);
      next();
    } catch (e) {
      if (e instanceof SyntaxError) {
        const trimmed = rawData.trim();
        if (trimmed.endsWith(',') || trimmed.endsWith('"') || /"source":\s*"danmaku$/.test(trimmed) || /"text":\s*"/.test(trimmed)) {
          try {
            let patched = trimmed;
            if (patched.endsWith(',')) patched = patched.slice(0, -1);

            const lastQuoteIndex = patched.lastIndexOf('"');
            if (patched.includes('":') && lastQuoteIndex > patched.lastIndexOf('":')) {
              patched += '"';
            }

            const openBraceCount = (patched.match(/{/g) || []).length;
            const closeBraceCount = (patched.match(/}/g) || []).length;
            if (openBraceCount > closeBraceCount) {
              patched += '}'.repeat(openBraceCount - closeBraceCount);
            }

            const parsed = JSON.parse(patched);

            // 深度恢复字段
            if (!parsed.text || parsed.text === "undefined") {
              const textMatch = rawData.match(/"(?:text|message|content)"\s*:\s*"([^"]*)$/);
              if (textMatch) {
                parsed.text = textMatch[1];
              }
            }

            req.body = parsed;
            console.error(`[Manager] FIXED: JSON recovered from truncation. Original length: ${rawData.length}`);
            return next();
          } catch (innerError) {
            // 补全失败
          }
        }
        console.error(`[Manager] JSON Parse Error at length ${rawData.length}: ${e.message}`);
      }
      if (!req.body) req.body = {};
      next();
    }
  });
});

// 注意：由于上面手动解析了流，express.json() 不能再处理这些请求，
// 我们将其限制在非核心 API 路径，或者通过判断 req.body 是否已存在来跳过。
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    return next();
  }
  express.json({ limit: '10mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use((req, res, next) => {
  if (req.path === '/llm.html' || req.path === '/llm.html/') {
    return res.status(404).send('Not Found');
  }
  if (req.path.startsWith('/api/llm')) {
    return res.status(410).json({
      success: false,
      error: 'LLM config is fixed to cpp and is not configurable via Manager'
    });
  }
  return next();
});
app.use(express.static(path.join(__dirname, 'public')));

const SUITE_ROOT = path.resolve(__dirname, '..');
const MU_URL = process.env.MEMORY_UNIVERSE_URL || `http://127.0.0.1:${process.env.MEMORY_UNIVERSE_PORT || '4005'}`;
const REDIS_URL = (process.env.REDIS_URL || '').trim();
const CHAT_QUEUE_KEY = process.env.MANAGER_CHAT_QUEUE_KEY || 'memory:chat:queue';
const CHAT_QUEUE_USE = REDIS_URL && process.env.MANAGER_CHAT_USE_QUEUE === 'true';
const LIVE2D_URL = process.env.LIVE2D_SERVICE_URL || `http://127.0.0.1:4005/live2d`;
const TTS_URL = process.env.TTS_SERVICE_URL || `http://127.0.0.1:${process.env.TTS_SERVICE_PORT || '4014'}`;
const BRAINNN_URL = process.env.BRAINNN_URL || `http://127.0.0.1:${process.env.BRAINNN_PORT || '4007'}`;
const SOVITS_URL = process.env.SOVITS_API_URL || 'http://127.0.0.1:9880';
const PRELAUNCH_CHECK_TIMEOUT_MS = Number.parseInt(process.env.PRELAUNCH_CHECK_TIMEOUT_MS || '90000', 10) || 90000;
const PRELAUNCH_CHECK_INTERVAL_MS = Number.parseInt(process.env.PRELAUNCH_CHECK_INTERVAL_MS || '1500', 10) || 1500;
const PRELAUNCH_CHECK_WARM_TEXT = (process.env.PRELAUNCH_CHECK_WARM_TEXT || '开播前语音预热检查').trim();
const PRELAUNCH_TTS_WARMUP_ATTEMPTS = Math.max(1, Number.parseInt(process.env.PRELAUNCH_TTS_WARMUP_ATTEMPTS || '2', 10) || 2);
const PRELAUNCH_TTS_WARMUP_MIN_PASS = Math.min(
  PRELAUNCH_TTS_WARMUP_ATTEMPTS,
  Math.max(1, Number.parseInt(process.env.PRELAUNCH_TTS_WARMUP_MIN_PASS || String(PRELAUNCH_TTS_WARMUP_ATTEMPTS), 10) || PRELAUNCH_TTS_WARMUP_ATTEMPTS)
);
const PRELAUNCH_TTS_WARMUP_TIMEOUT_MS = Math.max(8000, Number.parseInt(process.env.PRELAUNCH_TTS_WARMUP_TIMEOUT_MS || '25000', 10) || 25000);
const PRELAUNCH_TTS_AUDIO_FETCH_TIMEOUT_MS = Math.max(4000, Number.parseInt(process.env.PRELAUNCH_TTS_AUDIO_FETCH_TIMEOUT_MS || '10000', 10) || 10000);
const SOVITS_PERSISTENT_MODE = String(process.env.SOVITS_PERSISTENT_MODE || 'true').toLowerCase() !== 'false';
const SOVITS_KEEP_ON_STOP_ALL = String(process.env.SOVITS_KEEP_ON_STOP_ALL || 'true').toLowerCase() !== 'false';
const SOVITS_KEEP_ON_TTS_STOP = String(process.env.SOVITS_KEEP_ON_TTS_STOP || 'true').toLowerCase() !== 'false';
const SOVITS_FAST_PROBE_TIMEOUT_MS = Math.max(800, Number.parseInt(process.env.SOVITS_FAST_PROBE_TIMEOUT_MS || '1500', 10) || 1500);
const SOVITS_EXTERNAL_MANAGED = String(process.env.SOVITS_EXTERNAL_MANAGED || 'false').toLowerCase() === 'true';
const SOVITS_WEB_URL = String(process.env.SOVITS_WEB_URL || '').trim();
const TTS_SMOKE_TEXT = String(process.env.TTS_SMOKE_TEXT || '你好，我是月影，现在进行语音链路测试。').trim();
const SLEEP_MODE_AUTO_ENABLED = String(process.env.SLEEP_MODE_AUTO_ENABLED || 'false').toLowerCase() === 'true';
const SLEEP_MODE_AUTO_TIME = (process.env.SLEEP_MODE_AUTO_TIME || '04:10').trim();
const SLEEP_MODE_AUTO_CHECK_INTERVAL_MS = Number.parseInt(process.env.SLEEP_MODE_AUTO_CHECK_INTERVAL_MS || '30000', 10) || 30000;
const SLEEP_MODE_BRAINNN_ENABLED = String(process.env.SLEEP_MODE_BRAINNN_ENABLED || 'true').toLowerCase() === 'true';
const SLEEP_MODE_BRAINNN_MAX_MEMORIES = Math.max(5, Number.parseInt(process.env.SLEEP_MODE_BRAINNN_MAX_MEMORIES || '80', 10) || 80);
const NIGHTLY_SAMPLES_FILE = path.join(SUITE_ROOT, 'data', 'training', 'nightly-samples.jsonl');

function createService(name, port, group, priority, pm2Name) {
  return {
    name,
    port,
    cwd: '',
    command: '',
    args: [],
    status: 'stopped',
    logs: [],
    priority,
    group,
    pm2Name
  };
}

const services = {
  'memory-universe': createService('Memory Universe V3', Number.parseInt(process.env.MEMORY_UNIVERSE_PORT || '4005', 10), 'core', 1, 'memory-universe'),
  'memory-danmaku': createService('Danmaku Bridge', Number.parseInt(process.env.DANMAKU_SERVICE_PORT || '4003', 10), 'core', 2, 'memory-danmaku'),
  'memory-tts': createService('Memory TTS', Number.parseInt(process.env.TTS_SERVICE_PORT || '4014', 10), 'core', 3, 'memory-tts'),
  brainnn: createService('BrainNN', Number.parseInt(process.env.BRAINNN_PORT || '4007', 10), 'core', 4, 'brainnn')
};

globalThis.__managerServices = services;

const LOG_PATHS = {
  'memory-universe': {
    out: path.join(SUITE_ROOT, 'memory-universe', 'logs', 'mu-out.log'),
    error: path.join(SUITE_ROOT, 'memory-universe', 'logs', 'mu-error.log')
  },
  'memory-danmaku': {
    out: path.join(SUITE_ROOT, 'memory-danmaku', 'logs', 'danmaku-out.log'),
    error: path.join(SUITE_ROOT, 'memory-danmaku', 'logs', 'danmaku-error.log')
  },
  'memory-tts': {
    out: path.join(SUITE_ROOT, 'memory-tts', 'logs', 'tts-out.log'),
    error: path.join(SUITE_ROOT, 'memory-tts', 'logs', 'tts-error.log')
  },
  brainnn: {
    out: path.join(SUITE_ROOT, 'brainnn', 'logs', 'brainnn-out.log'),
    error: path.join(SUITE_ROOT, 'brainnn', 'logs', 'brainnn-error.log')
  }
};

const showrunnerState = {
  topic: 'general',
  updatedAt: Date.now()
};

let silenceMode = false;
let chatRequestCount = 0;
let chatSuccessCount = 0;

const toolSchedulerState = {
  enabled: true,
  intervalMinutes: Number.parseInt(process.env.TOOL_SCHEDULER_INTERVAL_MINUTES || '5', 10),
  config: {
    minInteractionDensity: Number.parseFloat(process.env.TOOL_SCHEDULER_MIN_INTERACTION_DENSITY || '0.2')
  },
  lastTriggeredAt: null,
  lastQuery: null
};

const knowledgeStore = [];
let knowledgeIdSeed = 1;

const knowledgeSchedulerState = {
  isRunning: false,
  totalFetched: 0,
  totalFailed: 0,
  lastHotTopicUpdate: 0,
  lastEncyclopediaUpdate: 0,
  lastForumUpdate: 0,
  lastLiteratureUpdate: 0
};

const learningState = {
  isRunning: false,
  totalKnowledge: 0,
  newKnowledgeSinceLastTrain: 0,
  totalTrainingSessions: 0,
  lastTrainingTime: 0,
  currentModelVersion: 'policy-v0',
  minNewKnowledge: Number.parseInt(process.env.LEARNING_MIN_NEW_KNOWLEDGE || '15', 10)
};

const evalIntelligenceState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  command: null,
  output: [],
  reportJson: null,
  reportMarkdown: null
};

const sleepModeState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  steps: []
};

const sleepAutoState = {
  enabled: SLEEP_MODE_AUTO_ENABLED,
  time: SLEEP_MODE_AUTO_TIME,
  lastRunDate: null,
  lastTriggeredAt: null,
  lastResult: null,
  lastError: null
};

const danmakuStyleWordFreq = new Map();
const danmakuStyleState = {
  isRunning: true,
  totalSamples: 0,
  patterns: 0,
  topSlangs: []
};

let styleProfiles = [];
let lastLivePreflightResult = null;
let lastGoLiveGateResult = null;

function updateKnowledgeCounters() {
  learningState.totalKnowledge = knowledgeStore.length;
}

function addKnowledgeEntry({ source, title, content }) {
  const item = {
    id: `knowledge_${knowledgeIdSeed++}`,
    source: source || 'manual',
    title: title || 'Untitled',
    content: content || '',
    createdAt: Date.now()
  };
  knowledgeStore.unshift(item);
  learningState.newKnowledgeSinceLastTrain += 1;
  updateKnowledgeCounters();
  return item;
}

function extractDanmakuTokens(text) {
  if (!text || typeof text !== 'string') return [];
  const tokens = text.match(/[\u4e00-\u9fff]{2,}|[A-Za-z]{3,}|[0-9]{2,}/g) || [];
  return tokens.map(token => token.toLowerCase());
}

function updateDanmakuStyle(samples) {
  for (const sample of samples) {
    const tokens = extractDanmakuTokens(sample.content || '');
    for (const token of tokens) {
      danmakuStyleWordFreq.set(token, (danmakuStyleWordFreq.get(token) || 0) + 1);
    }
  }

  const top = [...danmakuStyleWordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);

  danmakuStyleState.topSlangs = top;
  danmakuStyleState.patterns = top.length;
}

function buildLayeredTrainingStats() {
  return {
    policyNN: {
      connected: true,
      version: learningState.currentModelVersion
    },
    styleTrainer: {
      connected: true,
      profileCount: styleProfiles.length
    },
    danmakuStyle: {
      connected: true,
      samples: danmakuStyleState.totalSamples,
      patterns: danmakuStyleState.patterns
    }
  };
}

function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function readLastLines(filePath, lineCount = 100) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
    return lines.slice(-lineCount);
  } catch {
    return [];
  }
}

function buildLogEntries(lines, type) {
  return lines.map(line => ({
    type,
    message: line,
    timestamp: new Date().toLocaleTimeString()
  }));
}

function parsePm2Processes(stdout) {
  try {
    const payload = JSON.parse(String(stdout || '[]'));
    if (!Array.isArray(payload)) return new Map();
    const map = new Map();
    for (const item of payload) {
      if (!item || typeof item !== 'object') continue;
      const name = String(item.name || '').trim();
      if (!name) continue;
      map.set(name, {
        pid: Number(item.pid || 0),
        status: String(item.pm2_env?.status || '').trim() || 'unknown',
        restartCount: Number(item.pm2_env?.restart_time || 0)
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

async function getPm2ProcessMap() {
  const result = await runPm2(['jlist']);
  if (result.code !== 0) return new Map();
  return parsePm2Processes(result.stdout);
}

async function refreshServiceStatus(service, pm2Processes = null) {
  if (!service || !Number.isFinite(service.port)) return;
  try {
    const running = await isPortInUse(service.port);
    const portPid = running ? getPortPid(service.port) : 0;
    const pm2Info = service.pm2Name && pm2Processes ? pm2Processes.get(service.pm2Name) : null;
    const pm2Pid = pm2Info?.pid || 0;
    const pm2Status = pm2Info?.status || 'unknown';
    const ownerMismatch = Boolean(
      running &&
      pm2Pid > 0 &&
      portPid > 0 &&
      Number(pm2Pid) !== Number(portPid)
    );

    service.portPid = portPid || null;
    service.pm2Pid = pm2Pid || null;
    service.pm2Status = pm2Status;
    service.ownerMismatch = ownerMismatch;
    service.warnings = [];

    if (ownerMismatch) {
      service.status = 'conflict';
      service.warnings.push(`port_owner_mismatch: portPid=${portPid}, pm2Pid=${pm2Pid}`);
      return;
    }

    if (running && service.pm2Name && pm2Info && pm2Status !== 'online') {
      service.status = 'conflict';
      service.warnings.push(`pm2_not_online: ${pm2Status}`);
      return;
    }

    service.status = running ? 'running' : 'stopped';
  } catch {
    service.status = 'stopped';
    service.portPid = null;
    service.ownerMismatch = false;
  }
}

async function refreshAllServiceStatus() {
  const list = Object.values(services).filter(s => s);
  const pm2Processes = await getPm2ProcessMap();
  await Promise.all(list.map(service => refreshServiceStatus(service, pm2Processes)));
}

async function runPm2(args) {
  return new Promise((resolve) => {
    const child = spawn(npxCommand, ['pm2', ...args], {
      cwd: SUITE_ROOT,
      windowsHide: true,
      shell: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (error) => resolve({ code: 1, stdout: '', stderr: error.message }));
  });
}

async function checkHttp(url, timeout = 3000, acceptAnyStatus = false) {
  try {
    const response = await axios.get(url, {
      timeout,
      validateStatus: () => true
    });
    const ok = acceptAnyStatus ? true : (response.status >= 200 && response.status < 300);
    return { ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message || 'request failed' };
  }
}

async function checkSovitsReady(timeout = 5000) {
  // Lightweight reachability probe only.
  // Deep readiness is confirmed later via /api/tts warmup + audio fetch.
  try {
    const response = await axios.post(`${SOVITS_URL}/tts`, {}, {
      timeout,
      validateStatus: () => true
    });
    const ok = response.status >= 200 && response.status < 500;
    return { ok, status: response.status, mode: 'route_probe' };
  } catch (error) {
    return { ok: false, error: error.message || 'request failed', mode: 'route_probe' };
  }
}

async function probeSovits(timeout = SOVITS_FAST_PROBE_TIMEOUT_MS) {
  const probe = await checkSovitsReady(timeout);
  return {
    ready: probe.ok,
    probe
  };
}

async function waitForSovitsReady({
  timeoutMs = 180000,
  intervalMs = 2000
} = {}) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastProbe = null;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const current = await probeSovits(Math.min(intervalMs, 3000));
    lastProbe = current.probe;
    if (current.ready) {
      return {
        success: true,
        attempts,
        elapsedMs: Date.now() - startedAt,
        probe: current.probe
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    success: false,
    attempts,
    elapsedMs: Date.now() - startedAt,
    probe: lastProbe
  };
}

async function checkAudioUrlReadable(url, timeout = 6000) {
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'missing audio_url' };
  }
  try {
    const response = await axios.get(url, {
      timeout,
      responseType: 'arraybuffer',
      validateStatus: () => true
    });
    const byteLength = Number(response.data?.byteLength || response.data?.length || 0);
    const audioBuffer = Buffer.isBuffer(response.data)
      ? response.data
      : Buffer.from(response.data || []);
    const wavHeaderOk = audioBuffer.length >= 12
      && audioBuffer.toString('ascii', 0, 4) === 'RIFF'
      && audioBuffer.toString('ascii', 8, 12) === 'WAVE';
    const ok = response.status >= 200 && response.status < 300 && byteLength > 1024 && wavHeaderOk;
    return ok
      ? { ok: true, status: response.status, bytes: byteLength, wavHeaderOk }
      : { ok: false, status: response.status, bytes: byteLength, wavHeaderOk, error: 'audio not readable or invalid wav' };
  } catch (error) {
    return { ok: false, error: error.message || 'audio fetch failed' };
  }
}

function summarizeWarmupAttempts(attemptResults = []) {
  const summary = attemptResults.map((item) => {
    const warm = item.warmOk ? 'warm=ok' : `warm=fail(${item.error || item.warmError || 'unknown'})`;
    const audio = item.audioReadable?.ok
      ? 'audio=ok'
      : `audio=fail(${item.audioReadable?.error || 'unknown'})`;
    const quality = item.qualityOk ? 'quality=ok' : `quality=fail(short=${Boolean(item.suspiciousShort)})`;
    const duration = Number.isFinite(Number(item.duration)) ? `dur=${Number(item.duration).toFixed(2)}s` : 'dur=n/a';
    return `#${item.index}:${warm},${audio},${quality},${duration},engine=${item.engine || 'unknown'},cached=${Boolean(item.cached)}`;
  });
  return summary.join('; ');
}

async function runTtsWarmupProbe({
  attempts = PRELAUNCH_TTS_WARMUP_ATTEMPTS,
  minPass = PRELAUNCH_TTS_WARMUP_MIN_PASS
} = {}) {
  const normalizedAttempts = Math.max(1, Number.parseInt(String(attempts), 10) || PRELAUNCH_TTS_WARMUP_ATTEMPTS);
  const normalizedMinPass = Math.min(
    normalizedAttempts,
    Math.max(1, Number.parseInt(String(minPass), 10) || PRELAUNCH_TTS_WARMUP_MIN_PASS)
  );
  const attemptResults = [];

  for (let index = 0; index < normalizedAttempts; index += 1) {
    const probeBase = TTS_SMOKE_TEXT || PRELAUNCH_CHECK_WARM_TEXT;
    const probeText = index === 0
      ? probeBase
      : `${probeBase} [probe ${index + 1}/${normalizedAttempts}]`;
    try {
      const warmResp = await axios.post(
        `${TTS_URL}/api/tts`,
        { text: probeText, emotion: 'neutral', bypass_cache: true },
        { timeout: PRELAUNCH_TTS_WARMUP_TIMEOUT_MS, validateStatus: () => true }
      );
      const warmOk = warmResp.status >= 200 && warmResp.status < 300 && !!warmResp.data?.success;
      const engine = String(warmResp.data?.engine || '').toLowerCase();
      const cached = warmResp.data?.cached === true;
      const duration = Number(warmResp.data?.duration || 0);
      const minExpectedDuration = Number(
        warmResp.data?.min_expected_duration || estimateMinDurationSecForText(probeText)
      );
      const suspiciousShort = Boolean(
        warmResp.data?.suspicious_short === true
        || (Number.isFinite(duration) && duration > 0 && duration < minExpectedDuration)
      );
      const qualityOk = warmOk
        && warmResp.data?.quality_ok !== false
        && !suspiciousShort;
      const audioReadable = warmOk
        ? await checkAudioUrlReadable(warmResp.data?.audio_url, PRELAUNCH_TTS_AUDIO_FETCH_TIMEOUT_MS)
        : { ok: false, error: warmResp.data?.error || `warmup failed (status=${warmResp.status})` };

      attemptResults.push({
        index: index + 1,
        status: warmResp.status,
        warmOk,
        qualityOk,
        engine,
        cached,
        duration: Number.isFinite(duration) ? duration : null,
        minExpectedDuration: Number.isFinite(minExpectedDuration) ? minExpectedDuration : null,
        suspiciousShort,
        audioReadable,
        warmError: warmOk ? '' : (warmResp.data?.error || `warmup failed (status=${warmResp.status})`)
      });
    } catch (error) {
      attemptResults.push({
        index: index + 1,
        status: null,
        warmOk: false,
        qualityOk: false,
        engine: '',
        cached: false,
        duration: null,
        minExpectedDuration: null,
        suspiciousShort: false,
        audioReadable: { ok: false, error: error.message || 'audio fetch failed' },
        warmError: error.message || 'warmup failed',
        error: error.message || 'warmup failed'
      });
    }
  }

  const warmPassCount = attemptResults.filter((item) => item.warmOk && item.qualityOk).length;
  const audioPassCount = attemptResults.filter((item) => item.audioReadable?.ok && item.qualityOk).length;
  const sovitsPassCount = attemptResults.filter((item) => (
    item.warmOk
    && item.qualityOk
    && item.audioReadable?.ok
    && !item.cached
    && String(item.engine || '').includes('sovits')
  )).length;
  const summary = summarizeWarmupAttempts(attemptResults);

  const warmup = {
    ok: warmPassCount >= normalizedMinPass,
    mode: 'stability_probe',
    attempts: normalizedAttempts,
    minPass: normalizedMinPass,
    passed: warmPassCount,
    summary,
    error: warmPassCount >= normalizedMinPass ? undefined : `warmup stability failed (${warmPassCount}/${normalizedAttempts})`
  };
  const audio = {
    ok: audioPassCount >= normalizedMinPass,
    mode: 'stability_probe',
    attempts: normalizedAttempts,
    minPass: normalizedMinPass,
    passed: audioPassCount,
    summary,
    error: audioPassCount >= normalizedMinPass ? undefined : `audio fetch stability failed (${audioPassCount}/${normalizedAttempts})`
  };
  const sovits = {
    ok: sovitsPassCount >= normalizedMinPass,
    mode: 'e2e_tts_probe',
    attempts: normalizedAttempts,
    minPass: normalizedMinPass,
    passed: sovitsPassCount,
    summary,
    error: sovitsPassCount >= normalizedMinPass
      ? undefined
      : `SoVITS stable probe failed (${sovitsPassCount}/${normalizedAttempts})`
  };

  return {
    attempts: normalizedAttempts,
    minPass: normalizedMinPass,
    attemptResults,
    warmup,
    audio,
    sovits
  };
}

function estimateMinDurationSecForText(text) {
  const plain = String(text || '').replace(/\s+/g, '');
  if (!plain) return 0.4;
  const cjkCount = (plain.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinCount = (plain.match(/[A-Za-z0-9]/g) || []).length;
  const weighted = cjkCount + (latinCount * 0.45);
  return Math.max(0.45, Math.min(2.8, weighted * 0.06));
}

function upsertCheck(checks, name, result) {
  const index = checks.findIndex((item) => item && item.name === name);
  const payload = { name, ...(result || {}) };
  if (index >= 0) {
    checks[index] = payload;
  } else {
    checks.push(payload);
  }
}

async function runLivePreflight({ warmTts = true } = {}) {
  const checks = [];
  const push = (name, result) => checks.push({ name, ...result });

  push('manager', await checkHttp(`http://127.0.0.1:${PORT}/health`, 2000));
  push('memory-universe', await checkHttp(`${MU_URL}/health`, 5000));
  push('memory-tts', await checkHttp(`${TTS_URL}/health`, 5000));
  const sovitsRouteProbe = await checkSovitsReady(5000);
  push('sovits-api', sovitsRouteProbe);

  const baseReady = checks
    .filter((item) => ['manager', 'memory-universe', 'memory-tts'].includes(item.name))
    .every((item) => item.ok);
  if (warmTts && baseReady) {
    const probe = await runTtsWarmupProbe();
    push('tts-warmup', probe.warmup);
    push('tts-audio-fetch', probe.audio);
    upsertCheck(checks, 'sovits-api', {
      ...probe.sovits,
      routeProbeStatus: sovitsRouteProbe.status
    });
  }

  const result = {
    success: checks.every((item) => item.ok),
    checks,
    timestamp: new Date().toISOString()
  };
  lastLivePreflightResult = result;
  return result;
}

async function waitForLivePreflight({
  warmTts = true,
  timeoutMs = PRELAUNCH_CHECK_TIMEOUT_MS,
  intervalMs = PRELAUNCH_CHECK_INTERVAL_MS
} = {}) {
  const startedAt = Date.now();
  let attempts = 0;
  let last = null;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    last = await runLivePreflight({ warmTts });
    if (last.success) {
      return {
        ...last,
        attempts,
        elapsedMs: Date.now() - startedAt
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    ...(last || { success: false, checks: [], timestamp: new Date().toISOString() }),
    attempts,
    elapsedMs: Date.now() - startedAt
  };
}

function collectFailedChecks(checks = []) {
  return (Array.isArray(checks) ? checks : [])
    .filter((item) => item && item.ok !== true)
    .map((item) => ({
      name: item.name || 'unknown',
      ok: false,
      status: item.status,
      mode: item.mode,
      error: item.error || ''
    }));
}

function formatFailedChecksText(failedChecks = []) {
  const failed = Array.isArray(failedChecks) ? failedChecks : [];
  if (failed.length === 0) return [];
  return failed.map((item) => {
    const reason = item.error
      ? item.error
      : (Number.isFinite(item.status) ? `status=${item.status}` : 'not ready');
    return `${item.name}: ${reason}`;
  });
}

function buildGoLiveHints({ failedChecks = [], smoke = null } = {}) {
  const hints = [];
  if (failedChecks.some((item) => item.name === 'sovits-api')) {
    hints.push(
      SOVITS_EXTERNAL_MANAGED
        ? 'SoVITS 为外部托管模式，请先手动启动 SoVITS Web/API（通常是 9874/9880），再重试门禁。'
        : 'SoVITS 未就绪，可先尝试在 Manager 里执行“重启 SoVITS”，再重试门禁。'
    );
  }
  if (failedChecks.some((item) => item.name === 'memory-tts')) {
    hints.push('memory-tts 健康检查未通过，请先重启 memory-tts。');
  }
  if (smoke && smoke.success === false) {
    hints.push(smoke.error || 'TTS 烟测失败，请检查 SoVITS 输出音频是否可读。');
  }
  return hints;
}

async function runTtsSmokeProbe({
  text = TTS_SMOKE_TEXT,
  playAudio = false
} = {}) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) {
    return {
      success: false,
      httpCode: 400,
      error: 'text is required'
    };
  }

  const ttsResp = await axios.post(
    `${TTS_URL}/api/tts`,
    { text: normalizedText, emotion: 'neutral', bypass_cache: true },
    { timeout: Math.max(30000, PRELAUNCH_TTS_WARMUP_TIMEOUT_MS), validateStatus: () => true }
  );
  const ttsOk = ttsResp.status >= 200 && ttsResp.status < 300 && !!ttsResp.data?.success;
  if (!ttsOk) {
    return {
      success: false,
      httpCode: 502,
      error: ttsResp.data?.error || `TTS HTTP ${ttsResp.status}`,
      ttsStatus: ttsResp.status
    };
  }

  const audioUrl = ttsResp.data?.audio_url || ttsResp.data?.audioPath || '';
  const duration = Number(ttsResp.data?.duration || 0);
  const minExpected = Number(ttsResp.data?.min_expected_duration || estimateMinDurationSecForText(normalizedText));
  const audioProbe = await checkAudioUrlReadable(audioUrl, PRELAUNCH_TTS_AUDIO_FETCH_TIMEOUT_MS);

  let playResult = null;
  if (playAudio && audioProbe.ok) {
    const playResp = await axios.post(
      `${LIVE2D_URL}/audio/play`,
      {
        audioPath: audioUrl,
        duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
        text: normalizedText,
        emotion: 'neutral'
      },
      { timeout: 8000, validateStatus: () => true }
    );
    playResult = {
      ok: playResp.status >= 200 && playResp.status < 300,
      status: playResp.status
    };
  }

  const suspiciousShort = Boolean(
    ttsResp.data?.suspicious_short === true
    || (Number.isFinite(duration) && duration > 0 && duration < minExpected)
  );
  const qualityOk = ttsResp.data?.quality_ok !== false && !suspiciousShort;
  const success = audioProbe.ok && qualityOk;
  const httpCode = success ? 200 : 202;

  return {
    success,
    httpCode,
    text: normalizedText,
    engine: ttsResp.data?.engine || 'unknown',
    duration,
    minExpectedDuration: Number(minExpected.toFixed(2)),
    suspiciousShort,
    qualityOk,
    audioUrl,
    audioProbe,
    playResult,
    error: success
      ? undefined
      : (
        !audioProbe.ok
          ? (audioProbe.error || 'audio not readable')
          : `duration too short (${duration}s < expected ${Number(minExpected.toFixed(2))}s), text may be malformed`
      )
  };
}

async function startAllManagedServices({ runPreflight = true } = {}) {
  lastLivePreflightResult = null;
  lastGoLiveGateResult = null;
  let targets = Object.values(services)
    .filter((service) => service && service.pm2Name && service.pm2Name !== 'memory-manager')
    .map((service) => service.pm2Name);

  const sovitsState = await probeSovits();
  let shouldStartSovits = !(SOVITS_PERSISTENT_MODE && sovitsState.ready);
  if (SOVITS_EXTERNAL_MANAGED) {
    shouldStartSovits = false;
    targets = targets.filter((name) => name !== 'sovits-api');
  }
  if (shouldStartSovits && !targets.includes('sovits-api')) {
    targets.unshift('sovits-api');
  }

  for (const svc of Object.values(services)) {
    if (!svc || !Number.isFinite(svc.port)) continue;
    await cleanupPort(svc.port, svc.name);
  }
  if (shouldStartSovits) {
    await cleanupPort(9880, 'sovits-api');
  }

  const args = targets.length > 0
    ? ['start', 'pm2.config.cjs', '--only', targets.join(','), '--time']
    : ['start', 'pm2.config.cjs', '--time'];
  const result = await runPm2(args);
  await refreshAllServiceStatus();

  if (result.code !== 0) {
    return {
      success: false,
      started: false,
      code: 500,
      error: result.stderr || 'Failed to start services'
    };
  }

  const basePayload = {
    success: true,
    started: true,
    sovitsReused: !shouldStartSovits,
    sovitsRouteProbe: sovitsState.probe || null,
    sovitsExternalManaged: SOVITS_EXTERNAL_MANAGED
  };

  if (!runPreflight) {
    return {
      ...basePayload,
      preflightSkipped: true
    };
  }

  const preflight = await waitForLivePreflight({ warmTts: true });
  if (preflight.success) {
    return {
      ...basePayload,
      preflight
    };
  }

  return {
    ...basePayload,
    success: false,
    code: 202,
    warning: 'Services started but preflight not fully ready.',
    preflight
  };
}

async function areCoreLiveServicesRunning() {
  await refreshAllServiceStatus();
  const required = ['memory-universe', 'memory-danmaku', 'memory-tts'];
  return required.every((id) => services[id] && services[id].status === 'running');
}

async function runGoLiveGate({
  startServices = true,
  warmTts = true,
  waitReady = true,
  playAudio = false,
  smokeText = TTS_SMOKE_TEXT,
  strict = true
} = {}) {
  const startedAt = Date.now();
  let startResult = {
    success: true,
    started: false,
    skipped: true
  };

  if (startServices) {
    const alreadyRunning = await areCoreLiveServicesRunning();
    if (alreadyRunning) {
      startResult = {
        success: true,
        started: false,
        skipped: true,
        reason: 'core_services_already_running'
      };
    } else {
      startResult = await startAllManagedServices({ runPreflight: false });
    }
    if (!startResult.success) {
      const failedGate = {
        success: false,
        blocked: true,
        stage: 'start_services',
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        startResult,
        preflight: null,
        smoke: null,
        failedChecks: [],
        failedLines: [startResult.error || 'Failed to start services'],
        hints: ['服务启动失败，请先检查 PM2 进程和端口占用。'],
        strict
      };
      lastGoLiveGateResult = failedGate;
      return failedGate;
    }
  }

  const preflight = waitReady
    ? await waitForLivePreflight({ warmTts })
    : await runLivePreflight({ warmTts });
  const smoke = await runTtsSmokeProbe({
    text: smokeText,
    playAudio
  });

  const failedChecks = collectFailedChecks(preflight?.checks || []);
  const failedLines = [
    ...formatFailedChecksText(failedChecks),
    ...(smoke.success ? [] : [`tts-smoke: ${smoke.error || 'failed'}`])
  ];
  const blocked = strict ? (!preflight.success || !smoke.success) : false;
  const gate = {
    success: !blocked,
    blocked,
    stage: blocked ? 'blocked' : 'ready',
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    strict,
    startResult,
    preflight,
    smoke,
    failedChecks,
    failedLines,
    hints: buildGoLiveHints({ failedChecks, smoke }),
    sovitsExternalManaged: SOVITS_EXTERNAL_MANAGED
  };
  lastGoLiveGateResult = gate;
  return gate;
}

function killProcessByPort(port) {
  try {
    const pid = getPortPid(port);
    if (!pid) return false;
    return killProcess(pid);
  } catch {
    return false;
  }
}

function pushEvalLog(line) {
  if (!line) return;
  evalIntelligenceState.output.push(line);
  if (evalIntelligenceState.output.length > 400) {
    evalIntelligenceState.output = evalIntelligenceState.output.slice(-400);
  }
}

function listIntelligenceReports(limit = 20) {
  const reportDir = path.join(SUITE_ROOT, 'reports', 'intelligence');
  if (!fs.existsSync(reportDir)) return [];
  const files = fs.readdirSync(reportDir);
  const mdFiles = files.filter((name) => name.endsWith('.md')).sort().reverse();
  const result = [];
  for (const mdName of mdFiles) {
    const stamp = mdName.replace(/^intelligence-eval-/, '').replace(/\.md$/, '');
    const jsonName = `intelligence-eval-${stamp}.json`;
    const mdPath = path.join(reportDir, mdName);
    const jsonPath = path.join(reportDir, jsonName);
    let summary = null;
    if (fs.existsSync(jsonPath)) {
      try {
        const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        summary = json.summary || null;
      } catch {
        summary = null;
      }
    }
    result.push({
      stamp,
      mdName,
      jsonName: fs.existsSync(jsonPath) ? jsonName : null,
      updatedAt: fs.statSync(mdPath).mtimeMs,
      summary
    });
    if (result.length >= limit) break;
  }
  return result;
}

function pushSleepStep(name, ok, detail = '') {
  sleepModeState.steps.push({
    at: Date.now(),
    name,
    ok,
    detail
  });
  if (sleepModeState.steps.length > 50) {
    sleepModeState.steps = sleepModeState.steps.slice(-50);
  }
}

function buildDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildHHMM(date = new Date()) {
  const h = `${date.getHours()}`.padStart(2, '0');
  const m = `${date.getMinutes()}`.padStart(2, '0');
  return `${h}:${m}`;
}

function writeSleepDailyReport(trigger = 'manual') {
  try {
    const day = buildDateKey();
    const reportDir = path.join(SUITE_ROOT, 'reports', 'learning');
    fs.mkdirSync(reportDir, { recursive: true });
    const mdPath = path.join(reportDir, `sleep-daily-${day}.md`);

    const lines = [
      `# Sleep Daily Report (${day})`,
      '',
      `- trigger: ${trigger}`,
      `- startedAt: ${sleepModeState.startedAt ? new Date(sleepModeState.startedAt).toISOString() : 'n/a'}`,
      `- finishedAt: ${sleepModeState.finishedAt ? new Date(sleepModeState.finishedAt).toISOString() : 'n/a'}`,
      `- trainingExit: ${lastTrainingResult?.exitCode ?? 'n/a'}`,
      ''
    ];

    if (sleepModeState.steps.length > 0) {
      lines.push('## Steps');
      for (const step of sleepModeState.steps) {
        lines.push(`- [${step.ok ? 'ok' : 'fail'}] ${new Date(step.at).toISOString()} ${step.name}: ${step.detail || ''}`);
      }
      lines.push('');
    }

    fs.appendFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  } catch (error) {
    console.warn('[SleepAuto] Failed to write daily report:', error.message || error);
  }
}

function clampNumber(value, min, max, fallback = min) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function readJsonlTail(filePath, maxLines = 500) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw) return [];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(Math.max(0, lines.length - maxLines));
  const records = [];
  for (const line of tail) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
  return records;
}

function buildBrainSleepMemories(maxItems = SLEEP_MODE_BRAINNN_MAX_MEMORIES) {
  const limit = Math.max(5, Number.parseInt(String(maxItems), 10) || SLEEP_MODE_BRAINNN_MAX_MEMORIES);
  const memories = [];
  const seen = new Set();
  const pushMemory = (content, importance = 0.5, source = 'unknown') => {
    const text = String(content || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    memories.push({
      content: text.slice(0, 480),
      importance: clampNumber(importance, 0.1, 1.0, 0.5),
      source
    });
  };

  const knowledgeBudget = Math.max(5, Math.floor(limit * 0.35));
  for (const item of knowledgeStore.slice(0, knowledgeBudget)) {
    const sourceText = item.title
      ? `${item.title}: ${item.content || ''}`
      : String(item.content || '');
    pushMemory(sourceText, 0.7, 'knowledge_store');
  }

  const nightlyRecords = readJsonlTail(NIGHTLY_SAMPLES_FILE, limit * 4);
  for (const item of nightlyRecords) {
    const text = String(item.text || item.content || '').trim();
    if (!text) continue;
    const inferredImportance = clampNumber(
      item.importance,
      0.1,
      1.0,
      Math.min(0.85, 0.35 + text.length / 220)
    );
    pushMemory(text, inferredImportance, item.source || 'nightly_samples');
    if (memories.length >= limit) break;
  }

  return memories.slice(0, limit);
}

async function runBrainSleepConsolidation(trigger = 'manual') {
  if (!SLEEP_MODE_BRAINNN_ENABLED) {
    return { ok: true, skipped: true, detail: 'disabled by SLEEP_MODE_BRAINNN_ENABLED=false' };
  }

  const health = await checkHttp(`${BRAINNN_URL}/health`, 4000);
  if (!health.ok) {
    return { ok: false, detail: `BrainNN unavailable (${health.error || health.status || 'health failed'})` };
  }

  const memories = buildBrainSleepMemories(SLEEP_MODE_BRAINNN_MAX_MEMORIES);
  if (!memories.length) {
    return { ok: true, skipped: true, detail: 'no sleep memories available' };
  }

  const consolidateResp = await axios.post(
    `${BRAINNN_URL}/memory/consolidate`,
    { memories },
    { timeout: 20000, validateStatus: () => true }
  );
  const consolidateOk = consolidateResp.status >= 200 && consolidateResp.status < 300;
  if (!consolidateOk) {
    const detail = consolidateResp.data?.error || `HTTP ${consolidateResp.status}`;
    return { ok: false, detail: `brainnn consolidate failed: ${detail}` };
  }

  const consolidatedCount = Number.parseInt(
    String(consolidateResp.data?.consolidated_count ?? memories.length),
    10
  ) || 0;
  const feedbackResp = await axios.post(
    `${BRAINNN_URL}/learning/feedback`,
    {
      feedback: {
        type: 'sleep_mode',
        trigger,
        consolidated_count: consolidatedCount,
        sample_count: memories.length,
        top_slangs: (danmakuStyleState.topSlangs || []).slice(0, 6)
      }
    },
    { timeout: 12000, validateStatus: () => true }
  );
  const feedbackOk = feedbackResp.status >= 200 && feedbackResp.status < 300;
  const detail = `memories=${memories.length}, consolidated=${consolidatedCount}, feedback=${feedbackOk ? 'ok' : `fail(${feedbackResp.status})`}`;

  return {
    ok: feedbackOk,
    detail,
    consolidatedCount,
    memoryCount: memories.length
  };
}

let trainingInProgress = false;
let trainingStartedAt = null;
let trainingProcess = null;
let lastTrainingResult = null;
let rollbackInProgress = false;
let lastRollbackResult = null;

function resolveTrainingCommand() {
  const legacyTrainScript = path.join(SUITE_ROOT, 'brainnn', 'scripts', 'inject_soul.py');
  if (fs.existsSync(legacyTrainScript)) {
    return {
      command: npmCommand,
      args: ['run', 'train'],
      note: 'legacy python train script'
    };
  }

  const nightlyLearningScript = path.join(SUITE_ROOT, 'scripts', 'nightly-learn.mjs');
  if (fs.existsSync(nightlyLearningScript)) {
    return {
      command: 'node',
      args: ['scripts/nightly-learn.mjs'],
      note: 'nightly-learn'
    };
  }

  return null;
}

function spawnTrainingProcess(stepName = 'policy_training') {
  const trainTarget = resolveTrainingCommand();
  if (!trainTarget) {
    pushSleepStep(stepName, true, 'skipped: no training script found');
    return false;
  }

  const startedAt = Date.now();
  const trainProcess = spawn(trainTarget.command, trainTarget.args, {
    cwd: SUITE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
    shell: true
  });

  trainingInProgress = true;
  trainingStartedAt = startedAt;
  trainingProcess = trainProcess;
  pushSleepStep(stepName, true, `started (${trainTarget.note})`);

  trainProcess.stdout.on('data', (data) => console.log(`[sleep-train] ${data.toString()}`));
  trainProcess.stderr.on('data', (data) => console.error(`[sleep-train-error] ${data.toString()}`));
  trainProcess.on('close', (code) => {
    trainingInProgress = false;
    trainingProcess = null;
    lastTrainingResult = {
      exitCode: code,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      command: `${trainTarget.command} ${trainTarget.args.join(' ')}`
    };
    pushSleepStep('policy_training_finished', code === 0, `exit=${code}`);
  });
  trainProcess.on('error', (error) => {
    trainingInProgress = false;
    trainingProcess = null;
    lastTrainingResult = {
      exitCode: null,
      error: error.message,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      command: `${trainTarget.command} ${trainTarget.args.join(' ')}`
    };
    pushSleepStep('policy_training_finished', false, error.message || 'spawn error');
  });

  return true;
}

function triggerSleepMode(trigger = 'manual') {
  if (sleepModeState.running) {
    return { started: false, error: 'Sleep mode already running', state: sleepModeState };
  }

  sleepModeState.running = true;
  sleepModeState.startedAt = Date.now();
  sleepModeState.finishedAt = null;
  sleepModeState.steps = [];
  pushSleepStep('trigger', true, trigger);
  sleepAutoState.lastTriggeredAt = Date.now();

  setTimeout(async () => {
    try {
      try {
        const token = process.env.MU_CREATOR_TOKEN || '';
        const dreamResp = await axios.post(`${MU_URL}/api/memory/dream`, {}, {
          timeout: 45000,
          headers: { 'Authorization': `Bearer ${token}` }
        });
        pushSleepStep('memory_dream', true, JSON.stringify(dreamResp.data || {}).slice(0, 120));
      } catch (error) {
        pushSleepStep('memory_dream', false, error.message || 'dream failed');
      }

      try {
        const brainSleepResult = await runBrainSleepConsolidation(trigger);
        pushSleepStep('brainnn_consolidation', brainSleepResult.ok, brainSleepResult.detail || '');
      } catch (error) {
        pushSleepStep('brainnn_consolidation', false, error.message || 'brainnn consolidation failed');
      }

      try {
        if (trainingInProgress) {
          pushSleepStep('policy_training', true, 'already running');
        } else {
          spawnTrainingProcess('policy_training');
        }
      } catch (error) {
        pushSleepStep('policy_training', false, error.message || 'training trigger failed');
      }
    } finally {
      sleepModeState.running = false;
      sleepModeState.finishedAt = Date.now();
      sleepAutoState.lastResult = {
        trigger,
        at: sleepModeState.finishedAt,
        ok: sleepModeState.steps.every((step) => step.ok)
      };
      writeSleepDailyReport(trigger);
    }
  }, 0);

  return { started: true, state: sleepModeState };
}

function checkSleepAutoSchedule() {
  if (!sleepAutoState.enabled) return;
  const now = new Date();
  const currentHHMM = buildHHMM(now);
  if (currentHHMM !== sleepAutoState.time) return;

  const dateKey = buildDateKey(now);
  if (sleepAutoState.lastRunDate === dateKey) return;
  if (sleepModeState.running || trainingInProgress) return;

  const started = triggerSleepMode('auto_schedule');
  if (started.started) {
    sleepAutoState.lastRunDate = dateKey;
    sleepAutoState.lastError = null;
    console.log(`[SleepAuto] triggered at ${currentHHMM}`);
  } else {
    sleepAutoState.lastError = started.error || 'auto trigger failed';
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'memory-manager',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

app.get('/api/health-check', async (req, res) => {
  try {
    await refreshAllServiceStatus();
    const checks = Object.entries(services)
      .filter(([, service]) => service)
      .map(([id, service]) => ({
        service: id,
        status: service.status === 'running' ? 'healthy' : 'unhealthy',
        port: service.port,
        pm2Status: service.pm2Status || 'unknown',
        portPid: service.portPid || null,
        pm2Pid: service.pm2Pid || null,
        ownerMismatch: Boolean(service.ownerMismatch),
        warnings: Array.isArray(service.warnings) ? service.warnings : []
      }));

    const healthyCount = checks.filter(c => c.status === 'healthy').length;
    const totalCount = checks.length;

    res.json({
      success: healthyCount === totalCount,
      healthy: healthyCount,
      total: totalCount,
      results: {
        timestamp: new Date().toISOString(),
        checks
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Health check failed' });
  }
});

app.get('/api/services', async (req, res) => {
  try {
    await refreshAllServiceStatus();
    const list = Object.entries(services)
      .filter(([, service]) => service)
      .map(([id, service]) => ({
        id,
        name: service.name,
        port: service.port,
        status: service.status || 'stopped',
        priority: service.priority || 0,
        group: service.group || 'default',
        logCount: Array.isArray(service.logs) ? service.logs.length : 0,
        pm2Status: service.pm2Status || 'unknown',
        pm2Pid: service.pm2Pid || null,
        portPid: service.portPid || null,
        ownerMismatch: Boolean(service.ownerMismatch),
        warnings: Array.isArray(service.warnings) ? service.warnings : []
      }));
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to list services' });
  }
});

app.get('/api/services/:id/logs', (req, res) => {
  const serviceId = req.params.id;
  const service = services[serviceId];
  if (!service) {
    return res.status(404).json({ error: 'Service not found' });
  }

  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
  const logPaths = LOG_PATHS[serviceId];
  if (logPaths) {
    const outLines = readLastLines(logPaths.out, Number.isFinite(limit) ? limit : 100);
    const errorLines = readLastLines(logPaths.error, Number.isFinite(limit) ? limit : 100);
    const fileLogs = [
      ...buildLogEntries(outLines, 'stdout'),
      ...buildLogEntries(errorLines, 'stderr')
    ];
    if (fileLogs.length > 0) {
      return res.json(fileLogs);
    }
  }

  res.json(service.logs || []);
});

app.get('/api/services/:id/health', async (req, res) => {
  const serviceId = req.params.id;
  const service = services[serviceId];

  if (!service) {
    return res.status(404).json({ success: false, error: 'Service not found' });
  }

  try {
    await refreshServiceStatus(service, await getPm2ProcessMap());
    const response = await axios.get(`http://127.0.0.1:${service.port}/health`, { timeout: 3000 });
    res.json({
      success: true,
      status: service.status === 'running' ? 'healthy' : 'unhealthy',
      service: serviceId,
      pm2Status: service.pm2Status || 'unknown',
      portPid: service.portPid || null,
      pm2Pid: service.pm2Pid || null,
      ownerMismatch: Boolean(service.ownerMismatch),
      warnings: Array.isArray(service.warnings) ? service.warnings : [],
      details: response.data
    });
  } catch (error) {
    await refreshServiceStatus(service, await getPm2ProcessMap());
    res.json({
      success: false,
      status: service.status === 'running' ? 'degraded' : 'unhealthy',
      service: serviceId,
      pm2Status: service.pm2Status || 'unknown',
      portPid: service.portPid || null,
      pm2Pid: service.pm2Pid || null,
      ownerMismatch: Boolean(service.ownerMismatch),
      warnings: Array.isArray(service.warnings) ? service.warnings : [],
      error: error.message
    });
  }
});

app.post('/api/services/:id/start', async (req, res) => {
  const serviceId = req.params.id;
  const service = services[serviceId];
  if (!service) return res.status(404).json({ success: false, error: 'Service not found' });
  if (!service.pm2Name) {
    return res.json({ success: false, error: 'Service is not managed by PM2' });
  }

  let sovitsReused = false;
  let linkedPm2Names = [service.pm2Name];
  let linkedServices = [service];

  if (serviceId === 'memory-tts' && !SOVITS_EXTERNAL_MANAGED) {
    const sovitsState = await probeSovits();
    const shouldReuseSovits = SOVITS_PERSISTENT_MODE && sovitsState.ready;
    sovitsReused = shouldReuseSovits;
    linkedPm2Names = shouldReuseSovits
      ? [service.pm2Name]
      : ['sovits-api', service.pm2Name];
    linkedServices = shouldReuseSovits
      ? [service]
      : [service, { name: 'sovits-api', port: 9880 }];
  }
  for (const target of linkedServices) {
    if (!target || !Number.isFinite(target.port)) continue;
    await cleanupPort(target.port, target.name || serviceId);
  }
  const result = await runPm2(['start', 'pm2.config.cjs', '--only', linkedPm2Names.join(',')]);
  await refreshServiceStatus(service, await getPm2ProcessMap());

  if (result.code === 0) {
    return res.json({
      success: true,
      message: 'Service started',
      sovitsReused,
      sovitsExternalManaged: SOVITS_EXTERNAL_MANAGED
    });
  }
  res.status(500).json({ success: false, error: result.stderr || 'Failed to start service' });
});

app.post('/api/services/:id/repair', async (req, res) => {
  const serviceId = req.params.id;
  const service = services[serviceId];
  if (!service) return res.status(404).json({ success: false, error: 'Service not found' });
  if (!service.pm2Name) {
    return res.json({ success: false, error: 'Service is not managed by PM2' });
  }

  const includeSovits = serviceId === 'memory-tts'
    && !SOVITS_EXTERNAL_MANAGED
    && (req.body?.includeSovits === true);

  const linkedPm2Names = includeSovits
    ? ['sovits-api', service.pm2Name]
    : [service.pm2Name];
  const linkedPorts = includeSovits
    ? [service.port, 9880]
    : [service.port];

  try {
    await refreshServiceStatus(service, await getPm2ProcessMap());
    const before = {
      status: service.status || 'unknown',
      pm2Status: service.pm2Status || 'unknown',
      pm2Pid: service.pm2Pid || null,
      portPid: service.portPid || null,
      ownerMismatch: Boolean(service.ownerMismatch)
    };

    await runPm2(['stop', ...linkedPm2Names]);
    for (const port of linkedPorts) {
      await cleanupPort(port, `repair:${serviceId}`);
    }

    const startResult = await runPm2(['start', 'pm2.config.cjs', '--only', linkedPm2Names.join(','), '--update-env']);
    await refreshServiceStatus(service, await getPm2ProcessMap());

    const success = startResult.code === 0 && service.status === 'running' && !service.ownerMismatch;
    return res.status(success ? 200 : 500).json({
      success,
      message: success ? 'Service repaired' : 'Service repair incomplete',
      service: serviceId,
      includeSovits,
      before,
      after: {
        status: service.status || 'unknown',
        pm2Status: service.pm2Status || 'unknown',
        pm2Pid: service.pm2Pid || null,
        portPid: service.portPid || null,
        ownerMismatch: Boolean(service.ownerMismatch),
        warnings: Array.isArray(service.warnings) ? service.warnings : []
      },
      startResult: {
        code: startResult.code,
        stderr: startResult.stderr || '',
        stdout: startResult.stdout || ''
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      service: serviceId,
      error: error.message || 'Repair failed'
    });
  }
});

app.post('/api/services/:id/stop', async (req, res) => {
  const serviceId = req.params.id;
  const service = services[serviceId];
  if (!service) return res.status(404).json({ success: false, error: 'Service not found' });
  if (!service.pm2Name) {
    return res.json({ success: false, error: 'Service is not managed by PM2' });
  }

  const stopSovits = serviceId === 'memory-tts'
    ? (!SOVITS_EXTERNAL_MANAGED && (((req.body && req.body.stopSovits === true) || !SOVITS_KEEP_ON_TTS_STOP)))
    : false;
  const linkedPm2Names = serviceId === 'memory-tts'
    ? (stopSovits ? ['sovits-api', service.pm2Name] : [service.pm2Name])
    : [service.pm2Name];
  const result = await runPm2(['stop', ...linkedPm2Names]);
  await refreshServiceStatus(service, await getPm2ProcessMap());

  if (result.code === 0) {
    if (['memory-tts', 'memory-universe', 'live2d'].includes(serviceId)) {
      lastLivePreflightResult = null;
      lastGoLiveGateResult = null;
    }
    return res.json({
      success: true,
      message: 'Service stopped',
      sovitsStopped: stopSovits
    });
  }
  res.status(500).json({ success: false, error: result.stderr || 'Failed to stop service' });
});

app.post('/api/services/start-all', async (req, res) => {
  try {
    const runPreflight = !(req.body && req.body.preflight === false);
    const data = await startAllManagedServices({ runPreflight });
    const code = data.code || (data.success ? 200 : (data.started ? 202 : 500));
    return res.status(code).json(data);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to start services' });
  }
});

app.post('/api/live/preflight', async (req, res) => {
  try {
    const warmTts = !(req.body && req.body.warmTts === false);
    const waitReady = !(req.body && req.body.waitReady === false);
    const preflight = waitReady
      ? await waitForLivePreflight({ warmTts })
      : await runLivePreflight({ warmTts });

    const code = preflight.success ? 200 : 202;
    res.status(code).json({
      success: preflight.success,
      preflight
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Preflight check failed'
    });
  }
});

app.get('/api/live/preflight/latest', (req, res) => {
  res.json({
    success: true,
    preflight: lastLivePreflightResult
  });
});

// --- Memory / Task Management API ---
app.get('/api/memory/tasks', (req, res) => {
  try {
    const memoryPath = path.join(SUITE_ROOT, 'data', 'canonical-memory.json');
    if (!fs.existsSync(memoryPath)) {
      return res.json([]);
    }
    const raw = fs.readFileSync(memoryPath, 'utf8');
    const data = JSON.parse(raw);
    const userId = process.env.CREATOR_USER_ID || 'Jieice';
    const user = data.users && data.users[userId];
    if (!user || !user.tasks) {
      return res.json([]);
    }
    const sorted = [...user.tasks].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json(sorted);
  } catch (error) {
    console.error(`[Manager] Failed to get tasks: ${error.message}`);
    res.status(500).json({ success: false, error: 'Failed to read memory file' });
  }
});

app.post('/api/memory/tasks/update', (req, res) => {
  try {
    const { text, status } = req.body;
    if (!text || !status) {
      return res.status(400).json({ success: false, error: 'Missing text or status' });
    }
    const memoryPath = path.join(SUITE_ROOT, 'data', 'canonical-memory.json');
    if (!fs.existsSync(memoryPath)) {
      return res.status(404).json({ success: false, error: 'Memory file not found' });
    }
    const raw = fs.readFileSync(memoryPath, 'utf8');
    const data = JSON.parse(raw);
    const userId = process.env.CREATOR_USER_ID || 'Jieice';
    const user = data.users && data.users[userId];

    if (!user || !user.tasks) {
      return res.status(404).json({ success: false, error: 'User or tasks not found' });
    }

    const task = user.tasks.find(t => t.text === text);
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    task.status = status;
    task.updatedAt = Date.now();
    data.savedAt = Date.now();

    fs.writeFileSync(memoryPath, JSON.stringify(data, null, 2), 'utf8');
    res.json({ success: true, task });
  } catch (error) {
    console.error(`[Manager] Failed to update task: ${error.message}`);
    res.status(500).json({ success: false, error: 'Failed to update memory file' });
  }
});

app.post('/api/live/preflight/tts', async (req, res) => {
  try {
    const warmupAttempts = Number.parseInt(
      String(req.body?.attempts || PRELAUNCH_TTS_WARMUP_ATTEMPTS),
      10
    ) || PRELAUNCH_TTS_WARMUP_ATTEMPTS;
    const minPass = Number.parseInt(
      String(req.body?.minPass || PRELAUNCH_TTS_WARMUP_MIN_PASS),
      10
    ) || PRELAUNCH_TTS_WARMUP_MIN_PASS;
    const ttsHealth = await checkHttp(`${TTS_URL}/health`, 5000);
    if (!ttsHealth.ok) {
      return res.status(503).json({
        success: false,
        error: 'memory-tts is not healthy',
        ttsHealth
      });
    }

    const sovitsRouteProbe = await checkSovitsReady(5000);
    const probe = await runTtsWarmupProbe({ attempts: warmupAttempts, minPass });
    const result = {
      success: probe.sovits.ok,
      timestamp: new Date().toISOString(),
      checks: [
        { name: 'memory-tts', ...ttsHealth },
        { name: 'sovits-api', ...probe.sovits, routeProbeStatus: sovitsRouteProbe.status, routeProbeOk: sovitsRouteProbe.ok },
        { name: 'tts-warmup', ...probe.warmup },
        { name: 'tts-audio-fetch', ...probe.audio }
      ],
      attempts: probe.attemptResults
    };
    lastLivePreflightResult = {
      success: result.success,
      timestamp: result.timestamp,
      checks: result.checks
    };
    const code = result.success ? 200 : 202;
    res.status(code).json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'TTS preflight failed'
    });
  }
});

app.post('/api/live/tts/smoke', async (req, res) => {
  try {
    const text = String(req.body?.text || TTS_SMOKE_TEXT).trim();
    const playAudio = !(req.body && req.body.playAudio === false);
    const result = await runTtsSmokeProbe({ text, playAudio });
    const code = result.httpCode || (result.success ? 200 : 202);
    return res.status(code).json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'TTS smoke test failed'
    });
  }
});

app.post('/api/live/go', async (req, res) => {
  try {
    const startServices = !(req.body && req.body.startServices === false);
    const warmTts = !(req.body && req.body.warmTts === false);
    const waitReady = !(req.body && req.body.waitReady === false);
    const playAudio = req.body?.playAudio === true;
    const strict = !(req.body && req.body.strict === false);
    const smokeText = String(req.body?.text || TTS_SMOKE_TEXT).trim();

    const gate = await runGoLiveGate({
      startServices,
      warmTts,
      waitReady,
      playAudio,
      smokeText,
      strict
    });
    const code = gate.success ? 200 : (gate.stage === 'start_services' ? 500 : 409);
    return res.status(code).json({
      success: gate.success,
      blocked: gate.blocked,
      gate
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      blocked: true,
      error: error.message || 'Go-live gate failed'
    });
  }
});

app.get('/api/live/go/latest', (req, res) => {
  res.json({
    success: true,
    gate: lastGoLiveGateResult
  });
});

app.get('/api/live/readiness', async (req, res) => {
  try {
    const refresh = String(req.query?.refresh || '').toLowerCase() === 'true';
    const warmTts = String(req.query?.warmTts || '').toLowerCase() === 'true';
    const waitReady = String(req.query?.waitReady || '').toLowerCase() === 'true';
    const includeSmoke = String(req.query?.includeSmoke || '').toLowerCase() === 'true';

    let preflight = lastLivePreflightResult;
    if (refresh || !preflight) {
      preflight = waitReady
        ? await waitForLivePreflight({ warmTts })
        : await runLivePreflight({ warmTts });
    }

    let smoke = null;
    if (includeSmoke) {
      smoke = await runTtsSmokeProbe({ text: TTS_SMOKE_TEXT, playAudio: false });
    } else if (lastGoLiveGateResult?.smoke) {
      smoke = lastGoLiveGateResult.smoke;
    }

    const failedChecks = collectFailedChecks(preflight?.checks || []);
    const failedLines = [
      ...formatFailedChecksText(failedChecks),
      ...(smoke && smoke.success === false ? [`tts-smoke: ${smoke.error || 'failed'}`] : [])
    ];
    const blocked = failedLines.length > 0;
    const readiness = {
      success: !blocked,
      blocked,
      timestamp: new Date().toISOString(),
      preflight,
      smoke,
      failedChecks,
      failedLines,
      hints: buildGoLiveHints({ failedChecks, smoke }),
      latestGate: lastGoLiveGateResult,
      sovitsExternalManaged: SOVITS_EXTERNAL_MANAGED
    };

    return res.status(readiness.success ? 200 : 202).json({
      success: true,
      readiness
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to query readiness'
    });
  }
});

app.get('/api/sovits/status', async (req, res) => {
  try {
    const state = await probeSovits(Math.max(3000, SOVITS_FAST_PROBE_TIMEOUT_MS));
    const portInUse = await isPortInUse(9880);
    const deepReady = Boolean(
      lastLivePreflightResult
      && Array.isArray(lastLivePreflightResult.checks)
      && lastLivePreflightResult.checks.some((item) => item?.name === 'sovits-api' && item?.ok === true)
    );
    res.json({
      success: true,
      ready: state.ready || deepReady,
      routeReady: state.ready,
      deepReady,
      portInUse,
      probe: state.probe,
      externalManaged: SOVITS_EXTERNAL_MANAGED
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'failed to query sovits status'
    });
  }
});

app.get('/api/sovits/config', (req, res) => {
  res.json({
    success: true,
    externalManaged: SOVITS_EXTERNAL_MANAGED,
    webUrl: SOVITS_WEB_URL || null,
    apiUrl: SOVITS_URL
  });
});

app.post('/api/sovits/restart', async (req, res) => {
  try {
    if (SOVITS_EXTERNAL_MANAGED) {
      return res.status(409).json({
        success: false,
        error: 'sovits is external managed; restart it manually',
        externalManaged: true
      });
    }
    const waitReady = !(req.body && req.body.waitReady === false);
    const timeoutMsRaw = Number.parseInt(String(req.body?.timeoutMs || '180000'), 10);
    const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 180000;
    await cleanupPort(9880, 'sovits-api');
    const startResult = await runPm2(['start', 'pm2.config.cjs', '--only', 'sovits-api', '--time']);
    if (startResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: startResult.stderr || 'failed to start sovits-api'
      });
    }
    if (!waitReady) {
      return res.json({
        success: true,
        restarted: true,
        waitReady: false
      });
    }
    const readyResult = await waitForSovitsReady({ timeoutMs, intervalMs: 2000 });
    const code = readyResult.success ? 200 : 202;
    return res.status(code).json({
      success: readyResult.success,
      restarted: true,
      waitReady: true,
      ready: readyResult.success,
      attempts: readyResult.attempts,
      elapsedMs: readyResult.elapsedMs,
      probe: readyResult.probe
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'failed to restart sovits-api'
    });
  }
});

app.post('/api/eval/intelligence/run', async (req, res) => {
  try {
    if (evalIntelligenceState.running) {
      return res.status(409).json({
        success: false,
        error: 'Evaluation is already running',
        state: evalIntelligenceState
      });
    }

    const dataset = (req.body?.dataset || 'eval/intelligence/dataset.stress.v1.json').trim();
    const endpoint = (req.body?.endpoint || 'http://127.0.0.1:4005/api/chat').trim();
    const timeout = String(req.body?.timeout || process.env.EVAL_TIMEOUT_MS || '35000').trim();
    const retries = String(req.body?.retries || process.env.EVAL_RETRIES || '2').trim();

    evalIntelligenceState.running = true;
    evalIntelligenceState.startedAt = Date.now();
    evalIntelligenceState.finishedAt = null;
    evalIntelligenceState.exitCode = null;
    evalIntelligenceState.output = [];
    evalIntelligenceState.reportJson = null;
    evalIntelligenceState.reportMarkdown = null;
    evalIntelligenceState.command = `node scripts/run-intelligence-eval.mjs --endpoint ${endpoint} --dataset ${dataset} --timeout ${timeout} --retries ${retries}`;

    const child = spawn('node', [
      'scripts/run-intelligence-eval.mjs',
      '--endpoint', endpoint,
      '--dataset', dataset,
      '--timeout', timeout,
      '--retries', retries
    ], {
      cwd: SUITE_ROOT,
      windowsHide: true
    });

    child.stdout.on('data', (data) => {
      const text = data.toString();
      text.split(/\r?\n/).forEach((line) => {
        if (!line.trim()) return;
        pushEvalLog(line);
        const mdMatch = line.match(/\[Eval\]\s+markdown:\s+(.+)$/i);
        if (mdMatch) {
          evalIntelligenceState.reportMarkdown = mdMatch[1].trim();
        }
        const jsonMatch = line.match(/\[Eval\]\s+json:\s+(.+)$/i);
        if (jsonMatch) {
          evalIntelligenceState.reportJson = jsonMatch[1].trim();
        }
      });
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      text.split(/\r?\n/).forEach((line) => {
        if (!line.trim()) return;
        pushEvalLog(`[stderr] ${line}`);
      });
    });

    child.on('close', (code) => {
      evalIntelligenceState.running = false;
      evalIntelligenceState.exitCode = code;
      evalIntelligenceState.finishedAt = Date.now();
      pushEvalLog(`[Eval] process exited with code ${code}`);
    });

    child.on('error', (error) => {
      evalIntelligenceState.running = false;
      evalIntelligenceState.exitCode = -1;
      evalIntelligenceState.finishedAt = Date.now();
      pushEvalLog(`[Eval] failed to start: ${error.message || String(error)}`);
    });

    res.json({
      success: true,
      message: 'Evaluation started',
      state: evalIntelligenceState
    });
  } catch (error) {
    evalIntelligenceState.running = false;
    res.status(500).json({ success: false, error: error.message || 'Failed to start evaluation' });
  }
});

app.get('/api/eval/intelligence/status', (req, res) => {
  res.json({
    success: true,
    state: evalIntelligenceState
  });
});

app.get('/api/eval/intelligence/reports', (req, res) => {
  const limit = Number.parseInt(req.query.limit || '20', 10) || 20;
  const items = listIntelligenceReports(limit);
  res.json({
    success: true,
    items
  });
});

app.get('/api/eval/intelligence/reports/:name', (req, res) => {
  const name = String(req.params.name || '');
  const safe = path.basename(name);
  if (!/^intelligence-eval-[\w\-:.]+?\.(md|json)$/i.test(safe)) {
    return res.status(400).json({ success: false, error: 'Invalid report name' });
  }
  const filePath = path.join(SUITE_ROOT, 'reports', 'intelligence', safe);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'Report not found' });
  }
  const content = fs.readFileSync(filePath, 'utf8');
  res.json({
    success: true,
    name: safe,
    content
  });
});

app.post('/api/live/sleep-mode/start', async (req, res) => {
  const started = triggerSleepMode('manual');
  if (!started.started) {
    return res.status(409).json({ success: false, error: started.error, state: started.state || sleepModeState });
  }
  res.json({ success: true, message: 'Sleep mode started', state: sleepModeState });
});

app.get('/api/live/sleep-mode/status', (req, res) => {
  res.json({
    success: true,
    state: sleepModeState,
    trainingInProgress,
    auto: sleepAutoState
  });
});

app.post('/api/live/sleep-mode/auto', (req, res) => {
  const enabledRaw = req.body?.enabled;
  const timeRaw = String(req.body?.time || '').trim();

  if (typeof enabledRaw === 'boolean') {
    sleepAutoState.enabled = enabledRaw;
  }
  if (timeRaw) {
    if (!/^\d{2}:\d{2}$/.test(timeRaw)) {
      return res.status(400).json({ success: false, error: 'time must be HH:MM' });
    }
    sleepAutoState.time = timeRaw;
  }

  res.json({
    success: true,
    auto: sleepAutoState
  });
});

app.post('/api/services/stop-all', async (req, res) => {
  lastLivePreflightResult = null;
  lastGoLiveGateResult = null;
  const stopSovits = !SOVITS_EXTERNAL_MANAGED
    && (((req.body && req.body.stopSovits === true) || !SOVITS_KEEP_ON_STOP_ALL));
  const targets = Object.values(services)
    .filter(service => service && service.pm2Name && service.pm2Name !== 'memory-manager')
    .map(service => service.pm2Name);
  if (stopSovits && !targets.includes('sovits-api')) {
    targets.unshift('sovits-api');
  }
  const args = targets.length > 0
    ? ['stop', ...targets]
    : ['stop', 'all'];
  const result = await runPm2(args);
  await refreshAllServiceStatus();
  if (result.code === 0) {
    return res.json({
      success: true,
      sovitsStopped: stopSovits,
      sovitsExternalManaged: SOVITS_EXTERNAL_MANAGED
    });
  }
  res.status(500).json({ success: false, error: result.stderr || 'Failed to stop services' });
});

app.post('/api/services/force-cleanup', async (req, res) => {
  try {
    const ports = Object.values(services)
      .filter(service => service && Number.isFinite(service.port))
      .map(service => service.port);
    const unique = Array.from(new Set(ports));
    const cleaned = [];
    for (const port of unique) {
      await cleanupPort(port);
      cleaned.push(port);
    }
    res.json({ success: true, ports: cleaned });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Cleanup failed' });
  }
});

// Live control proxies
app.post('/api/live/emergency-stop', async (req, res) => {
  try {
    const requests = [
      axios.post(`${LIVE2D_URL}/api/audio/stop`, req.body || {}, { timeout: 8000 }),
      axios.post(`${LIVE2D_URL}/api/subtitle/clear`, req.body || {}, { timeout: 8000 })
    ];
    const settled = await Promise.allSettled(requests);
    const failed = settled.filter(item => item.status === 'rejected');
    res.json({
      success: failed.length === 0,
      stopped: true,
      details: settled.map((item) => (
        item.status === 'fulfilled'
          ? { ok: true, data: item.value.data }
          : { ok: false, error: item.reason?.message || 'request failed' }
      ))
    });
  } catch (error) {
    res.json({ success: false, error: error.message || 'Emergency stop failed' });
  }
});

app.post('/api/live/clear-subtitle', async (req, res) => {
  try {
    const response = await axios.post(`${LIVE2D_URL}/api/subtitle/clear`, req.body, { timeout: 15000 });
    res.json(response.data);
  } catch (error) {
    res.json({ success: false, error: error.message || 'Clear subtitle failed' });
  }
});

app.post('/api/live/stop-tts', async (req, res) => {
  try {
    const response = await axios.post(`${LIVE2D_URL}/api/audio/stop`, req.body, { timeout: 15000 });
    res.json(response.data);
  } catch (error) {
    res.json({ success: false, error: error.message || 'Stop TTS failed' });
  }
});

app.post('/api/live/silence-mode', async (req, res) => {
  try {
    const requested = req.body && Object.prototype.hasOwnProperty.call(req.body, 'enabled')
      ? Boolean(req.body.enabled)
      : null;
    silenceMode = requested === null ? !silenceMode : requested;
    res.json({ success: true, silenceMode });
  } catch (error) {
    res.json({ success: false, error: error.message || 'Silence mode failed' });
  }
});

app.get('/api/live/status', async (req, res) => {
  try {
    const response = await axios.get(`${LIVE2D_URL}/api/status`, { timeout: 5000 });
    res.json({
      success: true,
      silenceMode,
      ...response.data
    });
  } catch (error) {
    res.json({ success: false, silenceMode, error: error.message || 'Live status failed' });
  }
});

// Training (local)
app.post('/api/training/start', async (req, res) => {
  try {
    if (trainingInProgress) {
      return res.json({
        success: false,
        message: 'Training already in progress',
        trainingInProgress: true,
        data: { success: false, reason: 'Training already in progress' }
      });
    }

    const started = spawnTrainingProcess('policy_training_manual');
    if (!started) {
      return res.json({
        success: false,
        message: 'No training script found',
        trainingInProgress: false,
        data: { success: false, reason: 'No training script found' }
      });
    }

    res.json({
      success: true,
      message: 'Training started',
      trainingInProgress: true,
      data: {
        success: true,
        state: 'started',
        samplesUsed: learningState.totalKnowledge,
        modelVersion: learningState.currentModelVersion
      }
    });
  } catch (error) {
    res.json({ success: false, error: error.message || 'Training start failed' });
  }
});

app.get('/api/training/status', async (req, res) => {
  const stats = {
    isRunning: trainingInProgress,
    totalSamples: danmakuStyleState.totalSamples,
    positiveExamples: Math.floor(danmakuStyleState.totalSamples * 0.6),
    negativeExamples: Math.floor(danmakuStyleState.totalSamples * 0.4)
  };
  res.json({
    success: true,
    trainingInProgress,
    trainingStartedAt,
    lastResult: lastTrainingResult,
    rollbackInProgress,
    lastRollbackResult,
    stats
  });
});

app.get('/api/training/last-result', async (req, res) => {
  const data = lastTrainingResult ? {
    success: lastTrainingResult.exitCode === 0,
    endTime: lastTrainingResult.finishedAt || null,
    durationMs: lastTrainingResult.durationMs || null,
    modelVersion: learningState.currentModelVersion,
    error: lastTrainingResult.error || null
  } : null;
  res.json({ success: true, lastResult: lastTrainingResult, data });
});

app.post('/api/training/rollback', async (req, res) => {
  try {
    if (trainingInProgress || rollbackInProgress) {
      return res.json({ success: false, message: 'Training or rollback already in progress' });
    }

    const packageJsonPath = path.join(SUITE_ROOT, 'package.json');
    let hasRollbackScript = false;
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        hasRollbackScript = Boolean(pkg?.scripts?.['train:rollback']);
      } catch {
        hasRollbackScript = false;
      }
    }

    if (!hasRollbackScript) {
      lastRollbackResult = {
        exitCode: 0,
        finishedAt: Date.now(),
        durationMs: 0,
        skipped: true
      };
      return res.json({
        success: true,
        message: 'Rollback script not configured, skipped',
        rollbackInProgress: false,
        skipped: true
      });
    }

    const startedAt = Date.now();
    const rollbackProcess = spawn(npmCommand, ['run', 'train:rollback'], {
      cwd: SUITE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
      shell: true
    });

    rollbackInProgress = true;

    rollbackProcess.stdout.on('data', (data) => {
      console.log(`[rollback] ${data.toString()}`);
    });

    rollbackProcess.stderr.on('data', (data) => {
      console.error(`[rollback-error] ${data.toString()}`);
    });

    rollbackProcess.on('close', (code) => {
      rollbackInProgress = false;
      lastRollbackResult = {
        exitCode: code,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt
      };
    });

    rollbackProcess.on('error', (error) => {
      rollbackInProgress = false;
      lastRollbackResult = {
        exitCode: null,
        error: error.message,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt
      };
    });

    res.json({ success: true, message: 'Rollback started', rollbackInProgress: true });
  } catch (error) {
    res.json({ success: false, error: error.message || 'Rollback start failed' });
  }
});

// Tool system
app.get('/api/tools', (req, res) => {
  try {
    const tools = listInstalledTools();
    res.json({ success: true, tools });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Failed to list tools' });
  }
});

app.get('/api/tools/schemas', (req, res) => {
  try {
    const schemas = getEnabledToolSchemas();
    res.json({ success: true, schemas });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Failed to get schemas' });
  }
});

app.get('/api/tools/enabled', (req, res) => {
  try {
    const schemas = getEnabledToolSchemas();
    res.json({ success: true, schemas });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Failed to get schemas' });
  }
});

app.get('/api/tools/scheduler/status', (req, res) => {
  res.json({
    success: true,
    ...toolSchedulerState
  });
});

app.post('/api/tools/scheduler/trigger', async (req, res) => {
  const query = req.body?.query || null;
  toolSchedulerState.lastTriggeredAt = Date.now();
  toolSchedulerState.lastQuery = query;
  res.json({
    success: true,
    triggeredAt: toolSchedulerState.lastTriggeredAt,
    query
  });
});

app.post('/api/tools/:id/enable', (req, res) => {
  try {
    const toolId = req.params.id;
    const state = setToolEnabled(toolId, true);
    res.json({ success: true, toolId, enabled: true, state });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Failed to enable tool' });
  }
});

app.post('/api/tools/:id/disable', (req, res) => {
  try {
    const toolId = req.params.id;
    const state = setToolEnabled(toolId, false);
    res.json({ success: true, toolId, enabled: false, state });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Failed to disable tool' });
  }
});

app.post('/api/tools/call', async (req, res) => {
  try {
    const { toolId, args, options } = req.body || {};
    if (!toolId || typeof toolId !== 'string') {
      return res.status(400).json({ success: false, error: 'toolId is required' });
    }
    const result = await callTool(toolId, args || {}, options || {});
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Tool call failed' });
  }
});

app.post('/api/tools/:id/run', async (req, res) => {
  try {
    const toolId = req.params.id;
    const body = req.body || {};
    const args = body.args && typeof body.args === 'object' ? body.args : body;
    const result = await callTool(toolId, args || {}, body.options || {});
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Tool run failed' });
  }
});

app.get('/api/tools/:id/logs', (req, res) => {
  try {
    const toolId = req.params.id;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const rows = getToolCallLogs(toolId, Number.isFinite(limit) ? limit : 50);
    res.json({ success: true, toolId, rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Failed to get tool logs' });
  }
});

app.get('/api/tools/:id/network', (req, res) => {
  try {
    const toolId = req.params.id;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 200;
    const files = getToolNetworkLogs(toolId, Number.isFinite(limit) ? limit : 200);
    res.json({ success: true, toolId, files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Failed to get tool network logs' });
  }
});

app.post('/api/tools/orchestrate', async (req, res) => {
  try {
    const { userText, userId, context } = req.body || {};

    if (!userText || typeof userText !== 'string') {
      return res.status(400).json({ success: false, error: 'userText is required' });
    }

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    const { ToolOrchestrator } = require('../shared/ToolOrchestrator');
    const orchestrator = new ToolOrchestrator();

    const result = await orchestrator.orchestrate(userText, userId, context);

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Orchestration failed' });
  }
});

app.post('/api/tools/route', async (req, res) => {
  try {
    const { userText, userId, context } = req.body || {};

    if (!userText || typeof userText !== 'string') {
      return res.status(400).json({ success: false, error: 'userText is required' });
    }

    const { ToolRouterNN } = require('../shared/ToolRouterNN');
    const router = new ToolRouterNN();

    const schemas = getEnabledToolSchemas();

    const routerContext = {
      userText,
      userId: userId || 'test',
      ...context
    };

    const routing = await router.route(routerContext, schemas);

    res.json({ success: true, routing });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Routing failed' });
  }
});

// ShowRunner integration used by danmaku orchestrator
app.get('/api/showrunner/state', (req, res) => {
  res.json({
    success: true,
    state: showrunnerState
  });
});

app.post('/api/showrunner/topic', (req, res) => {
  const topic = String(req.body?.topic || '').trim();
  if (!topic) {
    return res.status(400).json({ success: false, error: 'topic is required' });
  }

  showrunnerState.topic = topic;
  showrunnerState.updatedAt = Date.now();
  res.json({
    success: true,
    state: showrunnerState
  });
});

// Compatibility APIs expected by frontend pages
app.get('/api/stats', (req, res) => {
  const successRate = chatRequestCount > 0
    ? `${((chatSuccessCount / chatRequestCount) * 100).toFixed(1)}%`
    : 'N/A';

  res.json({
    success: true,
    stats: {
      messages: {
        total: chatRequestCount,
        successRate
      },
      memory: {
        totalNodes: learningState.totalKnowledge
      },
      llm: {
        totalCalls: chatRequestCount
      },
      uptime: formatUptime(process.uptime())
    }
  });
});

app.post('/api/reflection/check', (req, res) => {
  const patterns = styleProfiles.map(profile => ({
    type: profile.type,
    confidence: profile.confidence
  }));

  const reflection = knowledgeStore.length > 0
    ? {
      patterns,
      contradictions: []
    }
    : null;

  res.json({
    success: true,
    reflection
  });
});

app.get('/api/knowledge/store/search', (req, res) => {
  const query = String(req.query?.q || '').trim().toLowerCase();
  const limit = Number.parseInt(String(req.query?.limit || '10'), 10);
  const max = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 50)) : 10;

  const results = query
    ? knowledgeStore.filter((item) => (
      item.title.toLowerCase().includes(query) ||
      item.content.toLowerCase().includes(query) ||
      item.source.toLowerCase().includes(query)
    ))
    : knowledgeStore;

  res.json({
    success: true,
    results: results.slice(0, max)
  });
});

app.post('/api/knowledge/fetch/:source', (req, res) => {
  try {
    const source = String(req.params.source || 'manual').trim().toLowerCase();
    const keyword = String(req.body?.keyword || '').trim() || 'topic';
    const limitRaw = Number.parseInt(String(req.body?.limit || '5'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 20)) : 5;

    const now = Date.now();
    let timestampField = 'lastForumUpdate';
    if (source === 'hottopic') timestampField = 'lastHotTopicUpdate';
    if (source === 'baike' || source === 'encyclopedia') timestampField = 'lastEncyclopediaUpdate';
    if (source === 'literature') timestampField = 'lastLiteratureUpdate';

    const items = [];
    for (let i = 0; i < limit; i += 1) {
      items.push(addKnowledgeEntry({
        source,
        title: `${keyword} #${i + 1}`,
        content: `[${source}] ${keyword} generated snippet ${i + 1}`
      }));
    }

    knowledgeSchedulerState.totalFetched += items.length;
    knowledgeSchedulerState[timestampField] = now;

    res.json({
      success: true,
      source,
      keyword,
      added: items.length,
      items
    });
  } catch (error) {
    knowledgeSchedulerState.totalFailed += 1;
    res.status(500).json({ success: false, error: error.message || 'fetch failed' });
  }
});

app.post('/api/knowledge/style/train', (req, res) => {
  const counts = new Map();
  for (const item of knowledgeStore) {
    counts.set(item.source, (counts.get(item.source) || 0) + 1);
  }
  const total = knowledgeStore.length || 1;

  styleProfiles = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, sampleCount]) => ({
      type,
      sampleCount,
      confidence: sampleCount / total
    }));

  res.json({
    success: true,
    profiles: styleProfiles
  });
});

app.get('/api/knowledge/style/profiles', (req, res) => {
  res.json({
    success: true,
    profiles: styleProfiles
  });
});

app.get('/api/knowledge/scheduler/stats', (req, res) => {
  res.json({
    success: true,
    stats: knowledgeSchedulerState
  });
});

app.post('/api/knowledge/scheduler/start', (req, res) => {
  knowledgeSchedulerState.isRunning = true;
  res.json({ success: true, isRunning: true });
});

app.post('/api/knowledge/scheduler/stop', (req, res) => {
  knowledgeSchedulerState.isRunning = false;
  res.json({ success: true, isRunning: false });
});

app.post('/api/knowledge/scheduler/trigger', (req, res) => {
  const triggerType = String(req.body?.type || 'manual').trim();
  const keyword = triggerType === 'hotTopic' ? 'hot-topic' : (triggerType || 'manual');
  const source = triggerType === 'hotTopic' ? 'hottopic' : (triggerType || 'manual');
  const limitRaw = Number.parseInt(String(req.body?.limit || '3'), 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 20)) : 3;

  const now = Date.now();
  let timestampField = 'lastForumUpdate';
  if (source === 'hottopic') timestampField = 'lastHotTopicUpdate';
  if (source === 'baike' || source === 'encyclopedia') timestampField = 'lastEncyclopediaUpdate';
  if (source === 'literature') timestampField = 'lastLiteratureUpdate';

  const items = [];
  for (let i = 0; i < limit; i += 1) {
    items.push(addKnowledgeEntry({
      source,
      title: `${keyword} #${i + 1}`,
      content: `[${source}] ${keyword} scheduled snippet ${i + 1}`
    }));
  }
  knowledgeSchedulerState.totalFetched += items.length;
  knowledgeSchedulerState[timestampField] = now;

  res.json({
    success: true,
    triggerType,
    added: items.length
  });
});

app.post('/api/learning/start', (req, res) => {
  learningState.isRunning = true;
  res.json({ success: true, isRunning: true });
});

app.post('/api/learning/stop', (req, res) => {
  learningState.isRunning = false;
  res.json({ success: true, isRunning: false });
});

app.post('/api/learning/train', (req, res) => {
  learningState.totalTrainingSessions += 1;
  learningState.lastTrainingTime = Date.now();
  learningState.currentModelVersion = `policy-v${learningState.totalTrainingSessions}`;
  learningState.newKnowledgeSinceLastTrain = 0;

  res.json({
    success: true,
    message: 'Training completed',
    modelVersion: learningState.currentModelVersion
  });
});

app.get('/api/learning/stats', (req, res) => {
  updateKnowledgeCounters();
  res.json({
    success: true,
    stats: {
      ...learningState,
      layeredTraining: buildLayeredTrainingStats()
    }
  });
});

app.post('/api/danmaku-style/learn/batch', (req, res) => {
  const samples = Array.isArray(req.body?.samples) ? req.body.samples : [];
  if (samples.length === 0) {
    return res.json({ success: true, added: 0, totalSamples: danmakuStyleState.totalSamples });
  }

  danmakuStyleState.totalSamples += samples.length;
  updateDanmakuStyle(samples);
  res.json({
    success: true,
    added: samples.length,
    totalSamples: danmakuStyleState.totalSamples
  });
});

app.get('/api/danmaku-style/stats', (req, res) => {
  res.json({
    success: true,
    stats: danmakuStyleState
  });
});

function writeProxyJsonBody(proxyReq, req) {
  if (!req.body || typeof req.body !== 'object' || !Object.keys(req.body).length) {
    return;
  }
  const bodyData = JSON.stringify(req.body);
  proxyReq.setHeader('Content-Type', 'application/json');
  proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
  const token = process.env.MU_CREATOR_TOKEN || '';
  if (token) {
    proxyReq.setHeader('Authorization', `Bearer ${token}`);
  }
  proxyReq.write(bodyData);
}

function createMuProxy(mountPath) {
  return createProxyMiddleware({
    target: MU_URL,
    changeOrigin: true,
    logLevel: 'silent',
    pathRewrite: (path) => `${mountPath}${path === '/' ? '' : path}`,
    onProxyReq: writeProxyJsonBody
  });
}

app.post('/api/chat/stream', async (req, res) => {
  const upstreamUrl = `${MU_URL}/api/chat/stream`;
  console.log(`[Manager] Streaming Proxy hit: ${upstreamUrl}`);

  try {
    const streamTimeoutMs = Number.parseInt(process.env.MANAGER_STREAM_PROXY_TIMEOUT_MS || '60000', 10) || 60000;
    const response = await axios({
      method: 'POST',
      url: upstreamUrl,
      data: req.body,
      responseType: 'stream',
      proxy: false,
      timeout: streamTimeoutMs,
      headers: {
        ...req.headers,
        host: new URL(MU_URL).host,
        'Authorization': `Bearer ${process.env.MU_CREATOR_TOKEN || ''}`
      }
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    response.data.pipe(res);
  } catch (error) {
    console.error('[Manager] Streaming proxy failed:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ success: false, error: 'Streaming proxy failed' });
    }
  }
});

app.use('/api/chat', (req, res, next) => {
  console.log(`[Manager] Chat Proxy hit: ${req.method} ${req.path}`);
  if (req.method === 'POST') {
    chatRequestCount += 1;
    res.on('finish', () => {
      if (res.statusCode < 500) {
        chatSuccessCount += 1;
      }
    });
  }
  next();
}, async (req, res) => {
  const upstreamPath = `/api/chat${req.path === '/' ? '' : req.path}`;
  const upstreamUrl = `${MU_URL}${upstreamPath}`;
  const timeoutMs = Number.parseInt(process.env.MANAGER_CHAT_PROXY_TIMEOUT_MS || '45000', 10) || 45000;

  // 全链路 requestId：若无则生成，并传给 Universe，便于日志排查
  let requestId = req.headers['x-request-id'] || (req.body && req.body.requestId);
  if (!requestId && req.method === 'POST' && req.body && typeof req.body === 'object') {
    requestId = crypto.randomUUID();
    req.body.requestId = requestId;
  }

  // 可选：Redis 缓冲模式，高并发时先入队再异步转发
  if (CHAT_QUEUE_USE && req.method === 'POST' && req.path === '/' && req.body && typeof req.body === 'object') {
    try {
      const { getChatQueueClient } = require('./redis-chat-queue');
      const client = getChatQueueClient();
      if (client) {
        await client.lPush(CHAT_QUEUE_KEY, JSON.stringify(req.body));
        return res.status(202).json({ success: true, queued: true, requestId: requestId || req.body.requestId });
      }
    } catch (e) {
      console.warn('[Manager] Chat queue push failed, falling back to sync proxy:', e.message);
    }
  }

  // 记录关键路径的 body 解析情况
  if (req.method === 'POST') {
    const bodyStr = JSON.stringify(req.body || {});
    // 使用 console.error 确保在任何日志配置下都能看到
    console.error(`[Manager] Incoming POST ${req.path}, body length: ${bodyStr.length}, raw length: ${req.headers['content-length']}`);
    if (bodyStr.length < 5) {
      console.error(`[Manager] Body suspicious:`, bodyStr);
    }
  }

  const headers = { ...req.headers };
  headers['Authorization'] = `Bearer ${process.env.MU_CREATOR_TOKEN || ''}`;
  if (requestId) {
    headers['x-request-id'] = requestId;
  }

  // 关键修复：确保转发的是 JSON 字符串，并同步更新 Content-Length
  let forwardingData = req.body;
  if (forwardingData && typeof forwardingData === 'object') {
    forwardingData = JSON.stringify(forwardingData);
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(forwardingData).toString();
  }

  try {
    const upstreamResp = await axios({
      method: req.method,
      url: upstreamUrl,
      params: req.query,
      data: forwardingData,
      headers,
      timeout: timeoutMs,
      proxy: false,
      validateStatus: () => true
    });

    if (upstreamResp.status === 400) {
      console.error(`[Manager] Universe returned 400 for ${req.path}. Body length: ${JSON.stringify(req.body).length}, Body preview: ${JSON.stringify(req.body).slice(0, 200)}`);
    }

    const contentType = upstreamResp.headers?.['content-type'];
    if (contentType) {
      res.setHeader('content-type', contentType);
    }

    res.status(upstreamResp.status);
    if (Buffer.isBuffer(upstreamResp.data) || typeof upstreamResp.data === 'string') {
      return res.send(upstreamResp.data);
    }
    return res.json(upstreamResp.data);
  } catch (error) {
    const err = error && error.response && error.response.data
      ? error.response.data
      : { success: false, error: error.message || 'Chat proxy failed' };
    return res.status(502).json(err);
  }
});
app.use('/api/stats', createMuProxy('/api/stats'));
app.use('/api/connection', createMuProxy('/api/connection'));
app.use('/api/unified', createMuProxy('/api/unified'));
app.use('/api/knowledge', createMuProxy('/api/knowledge'));
app.use('/api/learning', createMuProxy('/api/learning'));
app.use('/api/danmaku-style', createMuProxy('/api/danmaku-style'));
app.use('/api/reflection', createMuProxy('/api/reflection'));
app.use('/api/memory', createMuProxy('/api/memory'));
app.use('/api/control', createMuProxy('/api/control'));

// ═══════════════════════════════════════════════════════════
// LoRA Training API
// ═══════════════════════════════════════════════════════════
const trainingState = {
  status: 'idle',       // idle | preparing | training | exporting | done | error
  progress: null,       // { epoch, totalEpochs, step, loss, lr }
  logs: [],             // last N log lines
  pid: null,
  startedAt: null,
  error: null,
  history: [],          // [{ id, params, startedAt, finishedAt, status, finalLoss }]
};
const TRAINING_DIR = path.join(__dirname, '..', 'training');
const TRAINING_LOG_MAX = 200;

function pushTrainingLog(line) {
  trainingState.logs.push(line);
  if (trainingState.logs.length > TRAINING_LOG_MAX) {
    trainingState.logs = trainingState.logs.slice(-TRAINING_LOG_MAX);
  }
}

function parseTrainingProgress(line) {
  // Match trl/transformers progress: {'loss': 1.234, 'learning_rate': 2e-4, 'epoch': 1.0}
  const lossMatch = line.match(/'loss':\s*([\d.]+)/);
  const epochMatch = line.match(/'epoch':\s*([\d.]+)/);
  const lrMatch = line.match(/'learning_rate':\s*([\d.e-]+)/);
  if (lossMatch) {
    if (!trainingState.progress) trainingState.progress = {};
    trainingState.progress.loss = parseFloat(lossMatch[1]);
    if (epochMatch) trainingState.progress.epoch = parseFloat(epochMatch[1]);
    if (lrMatch) trainingState.progress.lr = parseFloat(lrMatch[1]);
  }
  // Match step progress: Step X/Y
  const stepMatch = line.match(/(\d+)\/(\d+)\s/);
  if (stepMatch && trainingState.progress) {
    trainingState.progress.step = parseInt(stepMatch[1], 10);
    trainingState.progress.totalSteps = parseInt(stepMatch[2], 10);
  }
}

// GET /api/training/data-stats — 获取数据源统计
app.get('/api/training/data-stats', async (req, res) => {
  try {
    const dataDir = path.join(__dirname, '..', 'data');
    const stats = { sources: [], totalSamples: 0 };

    // Check evo_memory
    const evoPath = path.join(dataDir, 'evo_memory', 'experiences.jsonl');
    if (fs.existsSync(evoPath)) {
      const lines = fs.readFileSync(evoPath, 'utf8').split('\n').filter(l => l.trim()).length;
      stats.sources.push({ name: 'evo_memory', path: evoPath, samples: lines });
      stats.totalSamples += lines;
    }

    // Check database
    const dbPath = path.join(dataDir, 'memory_universe.db');
    if (fs.existsSync(dbPath)) {
      stats.sources.push({ name: 'database', path: dbPath, samples: '(需运行 prepare_data 统计)' });
    }

    // Check nightly samples
    const nightlyPath = path.join(dataDir, 'training', 'nightly-samples.jsonl');
    if (fs.existsSync(nightlyPath)) {
      const lines = fs.readFileSync(nightlyPath, 'utf8').split('\n').filter(l => l.trim()).length;
      stats.sources.push({ name: 'nightly-samples', path: nightlyPath, samples: lines });
      stats.totalSamples += lines;
    }

    // Check existing train.jsonl
    const trainPath = path.join(dataDir, 'train.jsonl');
    if (fs.existsSync(trainPath)) {
      const lines = fs.readFileSync(trainPath, 'utf8').split('\n').filter(l => l.trim()).length;
      stats.trainData = { path: trainPath, samples: lines };
    }

    res.json({ success: true, ...stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/training/prepare-data — 执行数据准备
app.post('/api/training/prepare-data', async (req, res) => {
  if (trainingState.status !== 'idle' && trainingState.status !== 'done' && trainingState.status !== 'error') {
    return res.status(409).json({ success: false, error: `训练系统忙碌: ${trainingState.status}` });
  }

  trainingState.status = 'preparing';
  trainingState.logs = [];
  trainingState.error = null;

  const outputPath = req.body?.output || path.join(__dirname, '..', 'data', 'train.jsonl');
  const proc = spawn('python', ['prepare_data.py', '--output', outputPath], {
    cwd: TRAINING_DIR,
    env: { ...process.env },
  });

  proc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) pushTrainingLog(line);
  });
  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) pushTrainingLog(`[stderr] ${line}`);
  });
  proc.on('close', (code) => {
    if (code === 0) {
      trainingState.status = 'idle';
      pushTrainingLog('[prepare_data] 数据准备完成');
    } else {
      trainingState.status = 'error';
      trainingState.error = `prepare_data 退出码: ${code}`;
      pushTrainingLog(`[prepare_data] 失败，退出码: ${code}`);
    }
  });

  res.json({ success: true, message: '数据准备已启动' });
});

// POST /api/training/start — 启动 LoRA 训练
app.post('/api/training/start', async (req, res) => {
  if (trainingState.status === 'training') {
    return res.status(409).json({ success: false, error: '训练已在进行中' });
  }

  const params = {
    data: req.body?.data || path.join(__dirname, '..', 'data', 'train.jsonl'),
    baseModel: req.body?.baseModel || 'Qwen/Qwen3-4B-Instruct',
    output: req.body?.output || path.join(TRAINING_DIR, 'output', 'yuanying-lora'),
    epochs: req.body?.epochs || 3,
    lr: req.body?.lr || '2e-4',
    batchSize: req.body?.batchSize || 4,
    loraR: req.body?.loraR || 16,
    loraAlpha: req.body?.loraAlpha || 32,
  };

  trainingState.status = 'training';
  trainingState.progress = { epoch: 0, totalEpochs: params.epochs, loss: null, lr: null };
  trainingState.logs = [];
  trainingState.error = null;
  trainingState.startedAt = Date.now();

  const args = [
    'train_lora.py',
    '--data', params.data,
    '--base-model', params.baseModel,
    '--output', params.output,
    '--epochs', String(params.epochs),
    '--lr', params.lr,
    '--batch-size', String(params.batchSize),
    '--lora-r', String(params.loraR),
    '--lora-alpha', String(params.loraAlpha),
  ];

  const proc = spawn('python', args, {
    cwd: TRAINING_DIR,
    env: { ...process.env },
  });

  trainingState.pid = proc.pid;

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      pushTrainingLog(trimmed);
      parseTrainingProgress(trimmed);
    }
  });

  proc.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      pushTrainingLog(`[stderr] ${trimmed}`);
      parseTrainingProgress(trimmed);
    }
  });

  proc.on('close', (code) => {
    const entry = {
      id: Date.now().toString(36),
      params,
      startedAt: trainingState.startedAt,
      finishedAt: Date.now(),
      status: code === 0 ? 'success' : 'failed',
      finalLoss: trainingState.progress?.loss || null,
    };
    trainingState.history.unshift(entry);
    if (trainingState.history.length > 20) trainingState.history = trainingState.history.slice(0, 20);

    if (code === 0) {
      trainingState.status = 'done';
      pushTrainingLog('[train] 训练完成!');
    } else {
      trainingState.status = 'error';
      trainingState.error = `训练退出码: ${code}`;
      pushTrainingLog(`[train] 训练失败，退出码: ${code}`);
    }
    trainingState.pid = null;
  });

  res.json({ success: true, message: '训练已启动', pid: proc.pid, params });
});

// GET /api/training/status — 获取训练状态
app.get('/api/training/status', (req, res) => {
  res.json({
    success: true,
    status: trainingState.status,
    progress: trainingState.progress,
    logs: trainingState.logs.slice(-50),
    startedAt: trainingState.startedAt,
    error: trainingState.error,
  });
});

// POST /api/training/abort — 中止训练
app.post('/api/training/abort', (req, res) => {
  if (trainingState.pid) {
    try {
      process.kill(trainingState.pid, 'SIGTERM');
      trainingState.status = 'idle';
      trainingState.pid = null;
      pushTrainingLog('[train] 训练已被用户中止');
      res.json({ success: true, message: '训练已中止' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  } else {
    trainingState.status = 'idle';
    res.json({ success: true, message: '无活跃训练进程' });
  }
});

// POST /api/training/export — 导出 GGUF + 部署
app.post('/api/training/export', async (req, res) => {
  if (trainingState.status === 'training' || trainingState.status === 'exporting') {
    return res.status(409).json({ success: false, error: `系统忙碌: ${trainingState.status}` });
  }

  trainingState.status = 'exporting';
  trainingState.logs = [];
  trainingState.error = null;

  const loraPath = req.body?.loraPath || path.join(TRAINING_DIR, 'output', 'yuanying-lora-merged');
  const outputDir = req.body?.outputDir || path.join(TRAINING_DIR, 'output', 'gguf');

  const proc = spawn('powershell', [
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(TRAINING_DIR, 'export_gguf.ps1'),
    '-LoraPath', loraPath,
    '-OutputDir', outputDir,
  ], {
    cwd: TRAINING_DIR,
    env: { ...process.env },
  });

  proc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) pushTrainingLog(line);
  });
  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) pushTrainingLog(`[stderr] ${line}`);
  });
  proc.on('close', (code) => {
    if (code === 0) {
      trainingState.status = 'done';
      pushTrainingLog('[export] GGUF 导出完成!');
    } else {
      trainingState.status = 'error';
      trainingState.error = `export 退出码: ${code}`;
      pushTrainingLog(`[export] 导出失败，退出码: ${code}`);
    }
  });

  res.json({ success: true, message: 'GGUF 导出已启动' });
});

// GET /api/training/history — 训练历史
app.get('/api/training/history', (req, res) => {
  res.json({ success: true, history: trainingState.history });
});

let server = null;
let sleepAutoTimer = null;

function startManagerServer(attempt = 0) {
  server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`Memory Suite Manager running on http://localhost:${PORT}`);
    if (CHAT_QUEUE_USE) {
      const { initRedisChatQueue } = require('./redis-chat-queue');
      initRedisChatQueue().catch((e) => console.warn('[Manager] Redis chat queue:', e.message));
    }
    if (!sleepAutoTimer) {
      sleepAutoTimer = setInterval(checkSleepAutoSchedule, SLEEP_MODE_AUTO_CHECK_INTERVAL_MS);
    }
    if (sleepAutoState.enabled) {
      console.log(`[SleepAuto] enabled at ${sleepAutoState.time}`);
    }
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n[Manager] Port ${PORT} is already in use (127.0.0.1:${PORT}).`);
      console.error('[Manager] Fix options:');
      console.error(`- Stop the process using port ${PORT}`);
      console.error(`- Or change port via MANAGER_PORT in .env (e.g. MANAGER_PORT=${PORT + 1})`);
      console.error(`- Windows check: netstat -ano | findstr :${PORT}`);

      const autoKill = process.env.MANAGER_AUTO_KILL_PORT === 'true';
      if (autoKill) {
        console.error(`[Manager] MANAGER_AUTO_KILL_PORT=true, trying to free port ${PORT} and retry...`);
        try {
          killProcessByPort(PORT);
        } catch {
          // ignore
        }

        if (attempt < 1) {
          setTimeout(() => startManagerServer(attempt + 1), 1200);
          return;
        }
      }

      process.exit(1);
    }

    console.error(`\n[Manager] Server error: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });

  return server;
}

startManagerServer();

process.on('SIGINT', () => {
  try {
    const { stopRedisChatQueue } = require('./redis-chat-queue');
    stopRedisChatQueue();
  } catch (_) { }
  if (server) {
    server.close(() => process.exit(0));
    return;
  }
  process.exit(0);
});
