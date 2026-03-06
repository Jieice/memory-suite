/**
 * Express server for Edge TTS
 * 
 * Uses Microsoft Edge TTS for fast, reliable voice synthesis
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// Load .env from memory-tts dir, then fallback to project root
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();

const PORT = process.env.TTS_SERVICE_PORT || 4014;
const HOST = process.env.TTS_SERVICE_HOST || '127.0.0.1';
const PUBLIC_BASE_URL = process.env.TTS_PUBLIC_URL || `http://${HOST}:${PORT}`;
const AUDIO_CACHE_DIR = process.env.AUDIO_CACHE_DIR || './audio_cache';

const EDGE_API_URL = process.env.EDGE_API_URL || 'http://127.0.0.1:9881';
const SOVITS_API_URL = process.env.SOVITS_API_URL || 'http://127.0.0.1:9882';
const SOVITS_TIMEOUT_MS = Number(process.env.SOVITS_TIMEOUT_MS) || 10000;

const EMOTION_KEYWORDS = ['开心', '高兴', '快乐', '愤怒', '生气', '难过', '伤心', '悲伤', '兴奋', '激动', '害怕', '恐惧', '恶心', '惊讶', 'happy', 'angry', 'sad', 'excited', 'fearful', 'disgusted', 'surprised'];

let currentEngine = 'edge';

// SoVITS reference audio config from .env
const REF_AUDIO_PATH = process.env.SOVITS_REF_AUDIO || path.join(__dirname, 'reference', 'ref.wav');
const REF_TEXT = process.env.SOVITS_REF_TEXT || '今天天气真好，我们去散步吧';

// SoVITS synthesis parameters from .env
const SOVITS_PARAMS = {
  speed_factor: parseFloat(process.env.SOVITS_SPEED) || 1.0,
  text_split_method: process.env.SOVITS_TEXT_SPLIT_METHOD || 'cut5',
  batch_size: parseInt(process.env.SOVITS_BATCH_SIZE) || 1,
  fragment_interval: parseFloat(process.env.SOVITS_FRAGMENT_INTERVAL) || 0.3,
  top_k: parseInt(process.env.SOVITS_TOP_K) || 15,
  top_p: parseFloat(process.env.SOVITS_TOP_P) || 1.0,
  temperature: parseFloat(process.env.SOVITS_TEMPERATURE) || 1.0,
  media_type: process.env.SOVITS_MEDIA_TYPE || 'wav',
  streaming_mode: false,
};

if (!fs.existsSync(AUDIO_CACHE_DIR)) {
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const synthesisLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many synthesis requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/tts', limiter);
app.use('/synthesize', limiter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', engine: currentEngine, sovitsUrl: SOVITS_API_URL, edgeUrl: EDGE_API_URL });
});

app.get('/voices', (req, res) => {
  res.json({
    voices: [{ name: 'zh-CN-XiaoxuanNeural', language: 'zh-CN' }]
  });
});

function getCachePath(cacheKey) {
  return path.join(AUDIO_CACHE_DIR, `${cacheKey}.mp3`);
}

function getCachedAudio(cacheKey) {
  const cachePath = getCachePath(cacheKey);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }
  return null;
}

function cacheAudio(cacheKey, audioData) {
  const cachePath = getCachePath(cacheKey);
  try {
    fs.writeFileSync(cachePath, audioData);
  } catch (error) {
    console.error('Failed to cache audio:', error);
  }
}

function sanitizeText(text) {
  return text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9，。！？、：；""''（）【】《》…—\s]/g, '').trim();
}

async function synthesizeWithEdge(text, emotion = 'neutral') {
  const sanitizedText = sanitizeText(text);
  if (!sanitizedText) {
    throw new Error('Text is empty after sanitization');
  }

  const cacheKey = crypto.createHash('md5').update(`${sanitizedText}:${emotion}:edge`).digest('hex');
  
  let audioData = getCachedAudio(cacheKey);
  let cached = false;

  if (!audioData) {
    try {
      const response = await axios.post(
        `${EDGE_API_URL}/tts`,
        { text: sanitizedText, character_name: 'feibi' },
        { responseType: 'arraybuffer', timeout: 15000, proxy: false }
      );
      audioData = Buffer.from(response.data);
      cacheAudio(cacheKey, audioData);
    } catch (edgeErr) {
      console.error(`[Edge-TTS call] url=${EDGE_API_URL}/tts status=${edgeErr.response?.status} code=${edgeErr.code} msg=${edgeErr.message}`);
      throw edgeErr;
    }
  } else {
    cached = true;
  }

  return { audioData, cached, cacheKey, engine: 'edge' };
}

function selectEngine(req, text, emotion) {
  const engine = req?.query?.engine || req?.body?.engine;
  if (engine === 'sovits') return 'sovits';
  if (engine === 'edge') return 'edge';
  
  const textLower = (text || '').toLowerCase();
  const emotionLower = (emotion || '').toLowerCase();
  const combined = `${textLower} ${emotionLower}`;
  
  for (const keyword of EMOTION_KEYWORDS) {
    if (combined.includes(keyword.toLowerCase())) {
      return 'sovits';
    }
  }
  
  return 'edge';
}

async function synthesizeWithSovits(text, emotion = 'neutral') {
  const sanitizedText = sanitizeText(text);
  if (!sanitizedText) {
    throw new Error('Text is empty after sanitization');
  }

  const cacheKey = crypto.createHash('md5').update(`${sanitizedText}:${emotion}:sovits`).digest('hex');
  
  let audioData = getCachedAudio(cacheKey);
  let cached = false;

  if (!audioData) {
    try {
      const response = await axios.post(
        `${SOVITS_API_URL}/tts`,
        {
          text: sanitizedText,
          text_lang: process.env.SOVITS_TARGET_LANGUAGE || 'zh',
          ref_audio_path: REF_AUDIO_PATH,
          prompt_lang: process.env.SOVITS_REF_LANGUAGE || 'zh',
          prompt_text: REF_TEXT,
          ...SOVITS_PARAMS
        },
        { 
          responseType: 'arraybuffer',
          timeout: SOVITS_TIMEOUT_MS,
          proxy: false
        }
      );
      
      audioData = Buffer.from(response.data);
      cacheAudio(cacheKey, audioData);
    } catch (sovitsError) {
      console.error(`[SoVITS] Failed (${sovitsError.message}), falling back to Edge TTS`);
      return await synthesizeWithEdge(sanitizedText, emotion);
    }
  } else {
    cached = true;
  }

  return { audioData, cached, cacheKey, engine: 'sovits' };
}

app.post('/tts', synthesisLimiter, async (req, res) => {
  try {
    const { text, emotion, bypass_cache, voice_id, voice_name, language, speech_rate, pitch, engine } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'Text is required' });
    }

    const sanitizedText = sanitizeText(text);
    if (!sanitizedText) {
      return res.status(400).json({ success: false, error: 'Text is empty after sanitization' });
    }

    const selectedEngine = selectEngine(req, sanitizedText, emotion || 'neutral');
    currentEngine = selectedEngine;

    let result;
    if (selectedEngine === 'sovits') {
      result = await synthesizeWithSovits(sanitizedText, emotion || 'neutral');
    } else {
      result = await synthesizeWithEdge(sanitizedText, emotion || 'neutral');
    }

    const contentType = selectedEngine === 'sovits' ? 'audio/wav' : 'audio/mp3';
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Cached', result.cached ? 'true' : 'false');
    res.setHeader('X-Engine', result.engine);
    res.send(result.audioData);

  } catch (error) {
    console.error('[TTS Error]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/synthesize', synthesisLimiter, async (req, res) => {
  try {
    const { text, emotion, bypass_cache, engine } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'Text is required' });
    }

    const sanitizedText = sanitizeText(text);
    if (!sanitizedText) {
      return res.status(400).json({ success: false, error: 'Text is empty after sanitization' });
    }

    const selectedEngine = selectEngine(req, sanitizedText, emotion || 'neutral');
    currentEngine = selectedEngine;

    let result;
    if (selectedEngine === 'sovits') {
      result = await synthesizeWithSovits(sanitizedText, emotion || 'neutral');
    } else {
      result = await synthesizeWithEdge(sanitizedText, emotion || 'neutral');
    }

    res.json({
      success: true,
      audio: result.audioData.toString('base64'),
      cached: result.cached,
      engine: result.engine,
      format: selectedEngine === 'sovits' ? 'wav' : 'mp3'
    });

  } catch (error) {
    console.error('[Synthesis Error]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Estimate audio duration from file size and format
function estimateAudioDuration(audioData, format) {
  const bytes = audioData.length;
  if (format === 'wav') {
    // WAV: try to read from header, fallback to estimate
    if (bytes >= 44) {
      const sampleRate = audioData.readUInt32LE(24);
      const byteRate = audioData.readUInt32LE(28);
      if (byteRate > 0) {
        return Math.max(0.1, (bytes - 44) / byteRate);
      }
    }
    // Fallback: assume 16-bit mono 24kHz
    return Math.max(0.1, (bytes - 44) / (24000 * 2));
  }
  // MP3: ~128kbps average
  return Math.max(0.1, bytes / (128 * 1000 / 8));
}

// === /api/tts — JSON API matching bridge.js / manager / memory-universe contract ===
app.post('/api/tts', synthesisLimiter, async (req, res) => {
  const startTime = Date.now();
  try {
    const { text, emotion, bypass_cache, engine } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'Text is required' });
    }

    const sanitizedText = sanitizeText(text);
    if (!sanitizedText) {
      return res.status(400).json({ success: false, error: 'Text is empty after sanitization' });
    }

    const selectedEngine = selectEngine(req, sanitizedText, emotion || 'neutral');
    currentEngine = selectedEngine;
    let result;
    if (selectedEngine === 'sovits') {
      result = await synthesizeWithSovits(sanitizedText, emotion || 'neutral');
    } else {
      result = await synthesizeWithEdge(sanitizedText, emotion || 'neutral');
    }

    // Save to a file so it can be served via /audio/:filename
    const ext = selectedEngine === 'sovits' ? 'wav' : 'mp3';
    const filename = `${result.cacheKey}.${ext}`;
    const filePath = path.join(AUDIO_CACHE_DIR, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, result.audioData);
    }

    const duration = estimateAudioDuration(result.audioData, ext);
    const audioUrl = `${PUBLIC_BASE_URL}/audio/${filename}`;

    const elapsed = Date.now() - startTime;
    console.log(`[/api/tts] engine=${result.engine} cached=${result.cached} duration=${duration.toFixed(2)}s elapsed=${elapsed}ms`);

    res.json({
      success: true,
      audioPath: audioUrl,
      audio_url: audioUrl,
      audioUrl: audioUrl,
      duration: parseFloat(duration.toFixed(2)),
      engine: result.engine,
      cached: result.cached,
      format: ext,
      elapsed_ms: elapsed
    });

  } catch (error) {
    console.error('[/api/tts Error]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/audio/:filename', (req, res) => {
  const { filename } = req.params;
  const cacheDir = path.resolve(AUDIO_CACHE_DIR);
  const filepath = path.resolve(cacheDir, filename);

  if (!filepath.startsWith(cacheDir)) {
    return res.status(403).json({ error: 'Invalid path' });
  }

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Audio file not found' });
  }

  res.sendFile(filepath);
});

app.post('/api/cache/clear', async (req, res) => {
  try {
    const files = fs.readdirSync(AUDIO_CACHE_DIR);
    let deletedCount = 0;

    for (const file of files) {
      if (file.endsWith('.mp3') || file.endsWith('.wav')) {
        fs.unlinkSync(path.join(AUDIO_CACHE_DIR, file));
        deletedCount++;
      }
    }

    res.json({ success: true, message: `Cleared ${deletedCount} cached audio files` });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to clear cache' });
  }
});

app.get('/api/cache/stats', async (req, res) => {
  try {
    const files = fs.readdirSync(AUDIO_CACHE_DIR);
    const audioFiles = files.filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
    let totalSize = 0;

    for (const file of audioFiles) {
      totalSize += fs.statSync(path.join(AUDIO_CACHE_DIR, file)).size;
    }

    res.json({
      file_count: audioFiles.length,
      total_size_bytes: totalSize,
      cache_dir: AUDIO_CACHE_DIR
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get cache stats' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`TTS Service running at http://${HOST}:${PORT}`);
  console.log(`Audio cache directory: ${AUDIO_CACHE_DIR}`);
  console.log(`Edge-TTS API: ${EDGE_API_URL}`);
  console.log(`GPT-SoVITS API: ${SOVITS_API_URL}`);
});
