#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

async function readArgs() {
  const argsPath = process.env.TOOL_ARGS_PATH;
  if (argsPath && fs.existsSync(argsPath)) {
    try {
      return JSON.parse(fs.readFileSync(argsPath, 'utf-8'));
    } catch {
      // ignore
    }
  }
  try {
    return JSON.parse(process.argv[2] || process.env.TOOL_ARGS_JSON || '{}');
  } catch {
    return {};
  }
}

function envUrl(name, fallback) {
  const v = String(process.env[name] || '').trim();
  return v ? v : fallback;
}

function requestJson(method, urlString, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method,
      headers: Object.assign({}, headers || {}, payload ? {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      } : {})
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString('utf8'); });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          json = { raw: String(data || '').slice(0, 4000) };
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
      });
    });

    const ms = Math.max(1000, timeoutMs || 15000);
    req.setTimeout(ms, () => {
      try { req.destroy(new Error('TIMEOUT')); } catch { /* ignore */ }
    });

    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

async function postJson(url, body, headers, timeoutMs) {
  return requestJson('POST', url, body || {}, headers, timeoutMs);
}

async function getJson(url, headers, timeoutMs) {
  return requestJson('GET', url, null, headers, timeoutMs);
}

function requireString(v, name) {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return v;
}

(async () => {
  const args = await readArgs();

  const action = args.action;
  if (!action) {
    console.log(JSON.stringify({ success: false, error: 'action is required' }));
    process.exit(1);
  }

  const managerUrl = envUrl('MANAGER_URL', 'http://127.0.0.1:8080');
  const muUrl = envUrl('MEMORY_UNIVERSE_URL', 'http://127.0.0.1:4005');
  const live2dUrl = envUrl('LIVE2D_SERVICE_URL', 'http://127.0.0.1:4002');
  const ttsUrl = envUrl('TTS_SERVICE_URL', 'http://127.0.0.1:4014');

  // For MU live control endpoints: allow local (tool runs locally). If remote, provide token header.
  const liveToken = String(process.env.LIVE_CONTROL_TOKEN || process.env.LIVE_ADMIN_TOKEN || '').trim();
  const liveHeaders = liveToken ? { 'x-live-token': liveToken } : {};

  let result;

  try {
    switch (action) {
      case 'live_say': {
        const text = requireString(args.text, 'text');
        const tts = await postJson(`${ttsUrl}/api/tts`, { text }, {}, 30000);
        if (!tts.ok || !tts.json || tts.json.success !== true || !tts.json.audioPath) {
          throw new Error(`TTS failed: ${JSON.stringify(tts.json || {})}`);
        }
        const audioPath = tts.json.audioPath;
        const duration = typeof tts.json.duration === 'number' ? tts.json.duration : undefined;

        result = await postJson(
          `${live2dUrl}/audio/play`,
          {
            audioPath,
            duration,
            text
          },
          {},
          20000
        );
        break;
      }
      case 'mu_live_status': {
        result = await getJson(`${muUrl}/api/live/status`, liveHeaders, 15000);
        break;
      }
      case 'live2d_subtitle': {
        const text = requireString(args.text, 'text');
        const duration_ms = typeof args.durationMs === 'number' ? args.durationMs : undefined;
        result = await postJson(`${live2dUrl}/api/subtitle`, { text, duration_ms }, {}, 15000);
        break;
      }
      case 'live2d_clear_subtitle': {
        result = await postJson(`${live2dUrl}/api/subtitle/clear`, {}, {}, 15000);
        break;
      }
      case 'live2d_stop_audio': {
        result = await postJson(`${live2dUrl}/api/audio/stop`, {}, {}, 15000);
        break;
      }
      case 'mu_live_silence': {
        const durationSec = typeof args.durationSec === 'number' ? args.durationSec : undefined;
        const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined;
        const body = {};
        if (durationSec !== undefined) body.duration = durationSec;
        if (enabled !== undefined) body.enabled = enabled;
        result = await postJson(`${muUrl}/api/live/silence-mode`, body, liveHeaders, 15000);
        break;
      }
      case 'mu_live_emergency_stop': {
        result = await postJson(`${muUrl}/api/live/emergency-stop`, {}, liveHeaders, 15000);
        break;
      }
      case 'mu_mode_switch': {
        const mode = typeof args.mode === 'string' ? args.mode : undefined;
        result = await postJson(`${muUrl}/api/mode/switch`, mode ? { mode } : {}, {}, 15000);
        break;
      }
      case 'mu_showrunner_topic': {
        const topic = requireString(args.topic, 'topic');
        result = await postJson(`${muUrl}/api/showrunner/topic`, { topic }, {}, 15000);
        break;
      }
      case 'mu_showrunner_energy': {
        const delta = args.delta;
        if (typeof delta !== 'number') throw new Error('delta is required');
        result = await postJson(`${muUrl}/api/showrunner/energy`, { delta }, {}, 15000);
        break;
      }
      case 'danmaku_proactive_check': {
        // Trigger proactive check in danmaku-bridge mode to get content if any.
        result = await postJson(`${muUrl}/api/proactive/check`, { source: 'danmaku-bridge' }, {}, 20000);
        break;
      }
      case 'tts_synthesize': {
        const text = requireString(args.text, 'text');
        result = await postJson(`${ttsUrl}/api/tts`, { text }, {}, 30000);
        break;
      }
      default:
        throw new Error(`Unsupported action: ${action}`);
    }

    const ok = !!(result && (result.ok || (result.json && result.json.success === true)));

    console.log(JSON.stringify({
      action,
      success: ok,
      result: result ? { status: result.status, data: result.json } : null,
      callId: process.env.TOOL_CALL_ID || null
    }));
  } catch (e) {
    console.log(JSON.stringify({
      action,
      success: false,
      error: e && e.message ? e.message : String(e),
      callId: process.env.TOOL_CALL_ID || null
    }));
    process.exit(1);
  }
})();
