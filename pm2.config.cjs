const fs = require('fs');
const path = require('path');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) return;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    const commentIndex = value.indexOf('#');
    if (commentIndex !== -1) {
      value = value.slice(0, commentIndex).trim();
    }

    process.env[key] = value;
  });
}

loadEnvFile(path.join(__dirname, '.env'));

const nodeArgsLarge = ['--max-old-space-size=6144'];
const nodeArgsMedium = ['--max-old-space-size=2048'];

const pythonExe = process.env.PYTHON_EXE || 'python';
const pythonExeConfigured = (process.env.PYTHON_EXE || '').trim();
const pythonExists = pythonExeConfigured ? fs.existsSync(pythonExeConfigured) : true;

const disablePyServices = String(process.env.DISABLE_PY_SERVICES || 'false').toLowerCase() === 'true';
const disableTts = String(process.env.DISABLE_TTS || 'false').toLowerCase() === 'true';
const enablePyServices = !disablePyServices && pythonExists;
const enableTts = !disableTts && enablePyServices;
const sovitsProjectDir = process.env.SOVITS_PROJECT_DIR || './memory-tts/sovits/GPT-SoVITS-v2pro-20250604';
const sovitsPythonExe = process.env.SOVITS_PYTHON_EXE || path.join(sovitsProjectDir, 'runtime', 'python.exe');
const sovitsConfigPath = process.env.SOVITS_CONFIG_PATH || 'GPT_SoVITS/configs/tts_infer.yaml';
const sovitsBindHost = process.env.SOVITS_BIND_HOST || '127.0.0.1';
const sovitsPort = process.env.SOVITS_PORT || '9880';
const sovitsExternalManaged = String(process.env.SOVITS_EXTERNAL_MANAGED || 'false').toLowerCase() === 'true';
const enableSovits = !disableTts && !sovitsExternalManaged && fs.existsSync(sovitsProjectDir) && fs.existsSync(sovitsPythonExe);

const apps = [
  {
    name: 'memory-manager',
    cwd: './manager',
    script: 'server.js',
    interpreter: 'node',
    env: {
      NODE_ENV: 'production',
      MANAGER_PORT: process.env.MANAGER_PORT || 8080,
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=2048'
    },
    node_args: nodeArgsMedium,
    out_file: './logs/manager-out.log',
    error_file: './logs/manager-error.log',
    autorestart: true,
    max_restarts: 5,
    restart_delay: 2000
  },
  {
    name: 'memory-universe',
    cwd: './memory-universe',
    script: 'src/index.ts',
    interpreter: 'node',
    env: {
      NODE_ENV: 'production',
      MEMORY_UNIVERSE_PORT: process.env.MEMORY_UNIVERSE_PORT || 4005,
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=6144',
      USE_LOCAL_LLM: process.env.USE_LOCAL_LLM || 'false',
      LOCAL_LLM_ENGINE: process.env.LOCAL_LLM_ENGINE || 'cpp',
      LOCAL_LLM_MODEL_PATH: process.env.LOCAL_LLM_MODEL_PATH || '',
      LOCAL_LLM_CONTEXT_SIZE: process.env.LOCAL_LLM_CONTEXT_SIZE || '2048',
      LOCAL_LLM_MAX_TOKENS: process.env.LOCAL_LLM_MAX_TOKENS || '256',
      LOCAL_LLM_GPU_LAYERS: process.env.LOCAL_LLM_GPU_LAYERS || 'auto',
      LOCAL_LLM_TIMEOUT_MS: process.env.LOCAL_LLM_TIMEOUT_MS || '60000',
      LLM_CLOUD_FIRST: process.env.LLM_CLOUD_FIRST || 'true',
      LLM_LOCAL_FALLBACK: process.env.LLM_LOCAL_FALLBACK || 'false',
      LLM_PREFER_LOCAL: process.env.LLM_PREFER_LOCAL || 'false',
      LLM_CLOUD_TIMEOUT_MS: process.env.LLM_CLOUD_TIMEOUT_MS || '3000',
      LLM_LOCAL_MAX_TIME_MS: process.env.LLM_LOCAL_MAX_TIME_MS || '2000',
      SLOW_PATH_CLOUD_ENABLED: process.env.SLOW_PATH_CLOUD_ENABLED || 'true',
      SLOW_PATH_CLOUD_ALWAYS: process.env.SLOW_PATH_CLOUD_ALWAYS || 'false',
      SLOW_PATH_CLOUD_COMPLEX_ONLY: process.env.SLOW_PATH_CLOUD_COMPLEX_ONLY || 'true',
      SLOW_PATH_CLOUD_PROBABILITY: process.env.SLOW_PATH_CLOUD_PROBABILITY || '1.00',
      LIVE_REALTIME_MODE: process.env.LIVE_REALTIME_MODE || 'true',
      LIVE_SKIP_HEAVY_POST: process.env.LIVE_SKIP_HEAVY_POST || 'true',
      LIVE_FORCE_LOCAL_FAST: process.env.LIVE_FORCE_LOCAL_FAST || 'false',
      LIVE_FAST_LLM_TIMEOUT_MS: process.env.LIVE_FAST_LLM_TIMEOUT_MS || '2200',
      LIVE_SLOW_LLM_TIMEOUT_MS: process.env.LIVE_SLOW_LLM_TIMEOUT_MS || '4200',
      LIVE_FAST_MAX_TOKENS: process.env.LIVE_FAST_MAX_TOKENS || '72',
      LIVE_SLOW_MAX_TOKENS: process.env.LIVE_SLOW_MAX_TOKENS || '128',
      FAST_PATH_SIMPLE_COMPLEXITY_THRESHOLD: process.env.FAST_PATH_SIMPLE_COMPLEXITY_THRESHOLD || '0.14',
      ROUTE_COMPLEXITY_THRESHOLD: process.env.ROUTE_COMPLEXITY_THRESHOLD || '0.38'
    },
    node_args: [...nodeArgsLarge, '-r', 'ts-node/register/transpile-only'],
    out_file: './logs/mu-out.log',
    error_file: './logs/mu-error.log',
    autorestart: true,
    max_restarts: 5,
    restart_delay: 2000
  },
  {
    name: 'edge-tts-api',
    cwd: './memory-tts',
    script: 'edge_tts_server.py',
    interpreter: pythonExe,
    env: {
      PYTHONIOENCODING: 'utf-8',
    },
    out_file: './logs/edge-out.log',
    error_file: './logs/edge-error.log',
    autostart: true,
    autorestart: true,
    max_restarts: 5,
    restart_delay: 3000
  },
  {
    name: 'sovits-api',
    cwd: './memory-tts/sovits/GPT-SoVITS-v2pro-20250604',
    script: 'api_v2.py',
    interpreter: sovitsPythonExe,
    args: '-a 127.0.0.1 -p 9882 -c GPT_SoVITS/configs/tts_infer.yaml',
    env: {
      PYTHONIOENCODING: 'utf-8',
    },
    out_file: './logs/sovits-out.log',
    error_file: './logs/sovits-error.log',
    autostart: enableTts,
    autorestart: enableTts,
    max_restarts: enableTts ? 5 : 0,
    restart_delay: enableTts ? 3000 : 0,
    kill_timeout: 5000
  },
  {
    name: 'memory-tts',
    cwd: './memory-tts',
    script: 'server.js',
    interpreter: 'node',
    env: {
      NODE_ENV: 'production',
      TTS_SERVICE_PORT: process.env.TTS_SERVICE_PORT || 4014,
      TTS_SERVICE_HOST: process.env.TTS_SERVICE_HOST || '127.0.0.1',
      EDGE_API_URL: process.env.EDGE_API_URL || 'http://127.0.0.1:9881',
      SOVITS_API_URL: process.env.SOVITS_API_URL || 'http://127.0.0.1:9882',
      SOVITS_TIMEOUT_MS: process.env.SOVITS_TIMEOUT_MS || 45000,
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=2048'
    },
    node_args: nodeArgsMedium,
    out_file: './logs/tts-out.log',
    error_file: './logs/tts-error.log',
    autorestart: true,
    max_restarts: 5,
    restart_delay: 2000
  },
  {
    name: 'memory-danmaku',
    cwd: './memory-danmaku',
    script: 'bridge.js',
    interpreter: 'node',
    env: {
      NODE_ENV: 'production',
      DANMAKU_SERVICE_PORT: process.env.DANMAKU_SERVICE_PORT || 4003,
      TTS_SERVICE_PORT: process.env.TTS_SERVICE_PORT || 4014,
      MEMORY_UNIVERSE_PORT: process.env.MEMORY_UNIVERSE_PORT || 4005,
      TTS_SUBTITLE_SYNC_MODE: process.env.TTS_SUBTITLE_SYNC_MODE || 'subtitle_first',
      TTS_SPLIT_MODE: process.env.TTS_SPLIT_MODE || 'sentence',
      TTS_MIN_SPLIT_LENGTH: process.env.TTS_MIN_SPLIT_LENGTH || '20',
      TTS_REQUEST_TIMEOUT_MS: process.env.TTS_REQUEST_TIMEOUT_MS || '120000',
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=2048'
    },
    node_args: nodeArgsMedium,
    out_file: './logs/danmaku-out.log',
    error_file: './logs/danmaku-error.log',
    autorestart: true,
    max_restarts: 5,
    restart_delay: 2000
  },
  {
    name: 'brainnn',
    cwd: './brainnn',
    script: 'server.py',
    interpreter: pythonExe,
    env: {
      PYTHONIOENCODING: 'utf-8',
      BRAINNN_PORT: process.env.BRAINNN_PORT || 4007,
      BRAINNN_DEVICE: process.env.BRAINNN_DEVICE || 'cpu',
      BRAINNN_TIMEOUT: process.env.BRAINNN_TIMEOUT || '3.0'
    },
    out_file: './logs/brainnn-out.log',
    error_file: './logs/brainnn-error.log',
    autorestart: enablePyServices,
    max_restarts: enablePyServices ? 5 : 0,
    restart_delay: enablePyServices ? 3000 : 0,
    kill_timeout: 5000
  }
];

module.exports = { apps };
