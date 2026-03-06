console.log('SERVER FILE LOADED', process.pid);

const path = require('path');
const fs = require('fs');
const express = require('express');

const ENV_PATH = path.resolve(__dirname, '../.env');

function parseEnvContent(content) {
  const env = {};

  content.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      return;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      return;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    const commentIndex = value.indexOf('#');
    if (commentIndex >= 0) {
      value = value.slice(0, commentIndex).trim();
    }

    env[key] = value;
  });

  return env;
}

function loadEnvConfig() {
  try {
    if (!fs.existsSync(ENV_PATH)) {
      return;
    }

    const content = fs.readFileSync(ENV_PATH, 'utf8');
    const env = parseEnvContent(content);

    Object.entries(env).forEach(([key, value]) => {
      // Preserve externally provided env vars; .env is only fallback.
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    });

    console.log('[live2d-server] environment loaded from .env');
    console.log('[live2d-server] model config from env:', {
      scale: process.env.LIVE2D_MODEL_SCALE,
      x: process.env.LIVE2D_MODEL_X,
      y: process.env.LIVE2D_MODEL_Y
    });
  } catch (error) {
    console.warn('[live2d-server] failed to load .env:', error.message);
  }
}

function upsertEnvValue(content, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedKey}=.*$`, 'm');
  const line = `${key}=${value}`;

  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  const trimmed = content.trimEnd();
  return trimmed ? `${trimmed}\n${line}\n` : `${line}\n`;
}

loadEnvConfig();

const app = express();
const port = process.env.LIVE2D_SERVICE_PORT || process.env.LIVE2D_PORT || 4002;
const host = process.env.LIVE2D_SERVICE_HOST || process.env.LIVE2D_HOST || '127.0.0.1';
const apiToken = process.env.LIVE2D_SERVICE_TOKEN || '';

let currentSubtitle = '';
let currentEmotion = 'normal';
let currentSubtitleDuration = 0;
let currentAudio = null;
let runtimeConfig = null;

app.use((req, res, next) => {
  if (!apiToken) {
    return next();
  }

  const token = req.headers['x-api-token'] || req.query.token;
  if (token === apiToken) {
    return next();
  }

  return res.status(401).json({ success: false, error: 'Invalid token' });
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Token');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    service: 'memory-live2d',
    subtitle: currentSubtitle,
    emotion: currentEmotion
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'memory-live2d',
    uptime: process.uptime(),
    timestamp: Date.now(),
    details: {
      subtitle: currentSubtitle ? 'active' : 'idle',
      emotion: currentEmotion,
      hasAudio: !!currentAudio
    }
  });
});

app.get('/api/config', (req, res) => {
  const config = {
    model: runtimeConfig || {
      scale: parseFloat(process.env.LIVE2D_MODEL_SCALE || '0.25'),
      x: parseFloat(process.env.LIVE2D_MODEL_X || '0.3'),
      y: parseFloat(process.env.LIVE2D_MODEL_Y || '0.5')
    },
    mouthSpeed: parseInt(process.env.LIVE2D_MOUTH_SPEED || '20', 10),
    subtitle: {
      baseFontSize: parseInt(process.env.LIVE2D_SUBTITLE_FONT_SIZE || '36', 10),
      minFontSize: parseInt(process.env.LIVE2D_SUBTITLE_MIN_FONT_SIZE || '30', 10),
      fontScaleStep: parseFloat(process.env.LIVE2D_SUBTITLE_FONT_SCALE_STEP || '1.5'),
      maxHeight: parseInt(process.env.LIVE2D_SUBTITLE_MAX_HEIGHT || '400', 10),
      maxWidth: parseInt(process.env.LIVE2D_SUBTITLE_MAX_WIDTH || '1200', 10),
      charsPerLine: parseInt(process.env.LIVE2D_SUBTITLE_CHARS_PER_LINE || '20', 10)
    }
  };

  console.log('[live2d-server] config requested:', config.model);
  res.json(config);
});

app.post('/api/config/update', (req, res) => {
  const scale = Number(req.body?.scale);
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);

  if (![scale, x, y].every(Number.isFinite)) {
    return res.status(400).json({ success: false, error: 'Invalid config' });
  }

  runtimeConfig = { scale, x, y };
  console.log('[live2d-server] runtime config updated:', runtimeConfig);

  try {
    let envContent = '';
    if (fs.existsSync(ENV_PATH)) {
      envContent = fs.readFileSync(ENV_PATH, 'utf8');
    }

    envContent = upsertEnvValue(envContent, 'LIVE2D_MODEL_SCALE', scale);
    envContent = upsertEnvValue(envContent, 'LIVE2D_MODEL_X', x);
    envContent = upsertEnvValue(envContent, 'LIVE2D_MODEL_Y', y);

    fs.writeFileSync(ENV_PATH, envContent, 'utf8');
    console.log('[live2d-server] persisted model config to .env');
  } catch (error) {
    console.warn('[live2d-server] failed to persist .env config:', error.message);
  }

  return res.json({ success: true, config: runtimeConfig });
});

app.get('/api/live2d/status', (req, res) => {
  res.json({
    subtitle: currentSubtitle,
    emotion: currentEmotion
  });
});

app.post('/api/subtitle', (req, res) => {
  const { text, streaming, duration_ms } = req.body || {};

  if (text === undefined) {
    return res.status(400).json({ error: 'Text is required' });
  }

  const normalizedText = String(text);
  const normalizedDuration = Number.isFinite(Number(duration_ms))
    ? Math.max(0, Number(duration_ms))
    : 0;

  currentSubtitle = normalizedText;
  currentSubtitleDuration = normalizedDuration;

  console.log('[live2d-server] subtitle updated:', {
    streaming: !!streaming,
    duration_ms: currentSubtitleDuration,
    text: normalizedText.slice(0, 120)
  });

  return res.json({
    success: true,
    streaming: !!streaming,
    duration_ms: currentSubtitleDuration
  });
});

app.post('/api/emotion', (req, res) => {
  const { emotion } = req.body || {};

  if (!emotion) {
    return res.status(400).json({ error: 'Emotion is required' });
  }

  currentEmotion = String(emotion);
  console.log('[live2d-server] emotion updated:', currentEmotion);
  return res.json({ success: true });
});

app.post('/api/subtitle/clear', (req, res) => {
  currentSubtitle = '';
  currentSubtitleDuration = 0;
  return res.json({ success: true });
});

app.post('/api/audio/stop', (req, res) => {
  currentAudio = null;
  console.log('[live2d-server] audio playback stopped');
  return res.json({ success: true, message: 'Audio stopped' });
});

app.post('/api/animation', (req, res) => {
  const { type } = req.body || {};
  console.log('[live2d-server] animation trigger:', type || 'unknown');
  return res.json({ success: true, animation: type });
});

app.post('/audio/play', (req, res) => {
  const {
    audioPath,
    duration,
    mouthParams,
    msg_id,
    isStream,
    text,
    emotion,
    motion
  } = req.body || {};

  currentAudio = {
    audioPath,
    duration: Number.isFinite(Number(duration)) ? Number(duration) : 3,
    mouthParams: Array.isArray(mouthParams) ? mouthParams : [],
    msg_id: msg_id || '',
    isStream: !!isStream,
    text: text || '',
    emotion: emotion || 'normal',
    motion: motion || '',
    timestamp: Date.now()
  };

  if (emotion) {
    currentEmotion = String(emotion);
  }

  console.log('[live2d-server] audio play queued:', {
    hasPath: !!audioPath,
    duration: currentAudio.duration,
    emotion: currentAudio.emotion,
    motion: currentAudio.motion
  });

  return res.json({
    success: true,
    message: 'Audio queued for playback',
    audioInfo: currentAudio
  });
});

app.get('/api/audio/current', (req, res) => {
  return res.json({
    success: true,
    audio: currentAudio,
    subtitle: currentSubtitle,
    subtitleDuration: currentSubtitleDuration,
    emotion: currentEmotion
  });
});

app.post('/control-motion', (req, res) => {
  const { action, emotion_name } = req.body || {};

  if (action === 'trigger_emotion' && emotion_name) {
    currentEmotion = String(emotion_name);
  }

  console.log('[live2d-server] motion control:', { action, emotion_name });
  return res.json({ success: true, action, emotion_name });
});

if (!global.__live2d_server_started__) {
  global.__live2d_server_started__ = true;

  app.listen(port, host, () => {
    console.log(`[live2d-server] running on http://${host}:${port} (pid=${process.pid})`);
    console.log('[live2d-server] endpoints:');
    console.log('  GET  /health');
    console.log('  POST /api/subtitle');
    console.log('  POST /api/emotion');
    console.log('  POST /audio/play');
    console.log('  GET  /api/audio/current');
    console.log('  POST /control-motion');
  });
} else {
  console.log('[live2d-server] already started, skip listen()');
}

module.exports = app;
