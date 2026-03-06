const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

function stripBom(text) {
  if (!text) return text;
  return text.replace(/^\uFEFF/, '');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeReadJson(filePath) {
  const text = stripBom(fs.readFileSync(filePath, 'utf-8'));
  return JSON.parse(text);
}

function sha256OfFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function sha256OfDirectory(dirPath) {
  const files = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(full);
    }
  };
  walk(dirPath);
  files.sort();

  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(f);
    hash.update('\0');
    hash.update(fs.readFileSync(f));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function resolveRepoRoot() {
  return path.resolve(__dirname, '..');
}

function resolveDataRoot() {
  return path.join(resolveRepoRoot(), 'data');
}

function resolveToolsRoot() {
  return path.join(resolveDataRoot(), 'tools');
}

function resolveToolDir(toolId) {
  return path.join(resolveToolsRoot(), toolId);
}

function resolveToolStatePath() {
  return path.join(resolveToolsRoot(), 'state.json');
}

function resolveToolLogsDir(toolId) {
  return path.join(resolveDataRoot(), 'tool-logs', toolId);
}

function resolveToolNetworkDir(toolId) {
  return path.join(resolveDataRoot(), 'tool-network', toolId);
}

function resolveToolOutputsDir(toolId) {
  return path.join(resolveDataRoot(), 'tool-outputs', toolId);
}

function resolveToolScreenshotsDir(toolId) {
  return path.join(resolveDataRoot(), 'tool-screenshots', toolId);
}

function resolveToolWorkspaceDir(toolId, callId) {
  return path.join(resolveDataRoot(), 'tool-workspace', toolId, callId);
}

function readToolState() {
  const statePath = resolveToolStatePath();
  if (!fs.existsSync(statePath)) return { tools: {} };
  try {
    const raw = safeReadJson(statePath);
    if (raw && typeof raw === 'object' && raw.tools && typeof raw.tools === 'object') return raw;
  } catch {
    // ignore
  }
  return { tools: {} };
}

function writeToolState(state) {
  ensureDir(resolveToolsRoot());
  const statePath = resolveToolStatePath();
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, statePath);
}

function normalizeManifest(manifest, toolId) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Invalid manifest (not an object)');
  const id = manifest.id || toolId;
  if (!id || typeof id !== 'string') throw new Error('Invalid manifest.id');
  const entry = manifest.entry;
  const runtime = manifest.runtime;
  if (!entry || typeof entry !== 'string') throw new Error('Invalid manifest.entry');
  if (!runtime || typeof runtime !== 'string') throw new Error('Invalid manifest.runtime');

  const permissions = manifest.permissions && typeof manifest.permissions === 'object' ? manifest.permissions : {};
  const network = permissions.network && typeof permissions.network === 'object' ? permissions.network : {};
  const networkEnforcement = network.enforcement || 'best_effort';

  return {
    id,
    name: typeof manifest.name === 'string' ? manifest.name : id,
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    entry,
    runtime,
    enabledByDefault: manifest.enabledByDefault === true,
    schemas: Array.isArray(manifest.schemas) ? manifest.schemas : [],
    permissions: {
      filesystem: permissions.filesystem || {},
      network: {
        enabled: network.enabled === true,
        visible: network.visible !== false,
        enforcement: networkEnforcement
      }
    },
    confirmationLevel: manifest.confirmationLevel || 'confirm',
    accessLevel: manifest.accessLevel || 'admin'
  };
}

function listInstalledTools() {
  const toolsRoot = resolveToolsRoot();
  ensureDir(toolsRoot);

  const state = readToolState();
  const dirs = fs.readdirSync(toolsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const tools = [];
  for (const dirName of dirs) {
    const toolDir = resolveToolDir(dirName);
    const manifestPath = path.join(toolDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifestRaw = safeReadJson(manifestPath);
      const manifest = normalizeManifest(manifestRaw, dirName);

      const toolState = state.tools[manifest.id] || {};
      const enabled = toolState.enabled === true || (toolState.enabled == null && manifest.enabledByDefault);

      tools.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        enabled,
        entry: manifest.entry,
        runtime: manifest.runtime,
        schemas: manifest.schemas,
        permissions: manifest.permissions,
        confirmationLevel: manifest.confirmationLevel,
        accessLevel: manifest.accessLevel,
        installedHash: toolState.installedHash || null,
        installedAt: toolState.installedAt || null
      });
    } catch (e) {
      tools.push({
        id: dirName,
        name: dirName,
        version: 'unknown',
        enabled: false,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  return tools;
}

function setToolEnabled(toolId, enabled) {
  const state = readToolState();
  if (!state.tools) state.tools = {};
  if (!state.tools[toolId]) state.tools[toolId] = {};
  state.tools[toolId].enabled = !!enabled;
  state.tools[toolId].updatedAt = Date.now();
  writeToolState(state);
  return state.tools[toolId];
}

function computeInstallHash(toolId) {
  const toolDir = resolveToolDir(toolId);
  if (!fs.existsSync(toolDir)) throw new Error(`Tool not found: ${toolId}`);
  return sha256OfDirectory(toolDir);
}

function ensureInstalledHash(toolId) {
  const state = readToolState();
  if (!state.tools) state.tools = {};
  if (!state.tools[toolId]) state.tools[toolId] = {};

  if (!state.tools[toolId].installedHash) {
    state.tools[toolId].installedHash = computeInstallHash(toolId);
    state.tools[toolId].installedAt = Date.now();
    writeToolState(state);
  }

  return state.tools[toolId].installedHash;
}

function resolveToolManifest(toolId) {
  const toolDir = resolveToolDir(toolId);
  const manifestPath = path.join(toolDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest.json not found for tool: ${toolId}`);
  const manifestRaw = safeReadJson(manifestPath);
  return normalizeManifest(manifestRaw, toolId);
}

function createCallId() {
  return crypto.randomBytes(16).toString('hex');
}

function tailText(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf-8');
}

function readJsonl(filePath, limit) {
  if (!fs.existsSync(filePath)) return [];
  const content = stripBom(fs.readFileSync(filePath, 'utf-8'));
  const lines = content.split(/\r?\n/).filter(Boolean);
  const slice = typeof limit === 'number' ? lines.slice(Math.max(0, lines.length - limit)) : lines;
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore
    }
  }
  return out;
}

function getEnabledToolSchemas() {
  const tools = listInstalledTools().filter(t => t.enabled && Array.isArray(t.schemas));
  return tools.flatMap(t => t.schemas.map(s => ({ ...s, toolId: t.id })));
}

function resolveEntryAbsolute(toolId, entryRel) {
  const toolDir = resolveToolDir(toolId);
  const abs = path.resolve(toolDir, entryRel);
  const rel = path.relative(toolDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Tool entry escapes tool directory');
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`Tool entry not found: ${abs}`);
  }
  return abs;
}

function spawnToolProcess(manifest, toolId, callId, argsObj, options) {
  const startedAt = Date.now();
  const workspaceDir = resolveToolWorkspaceDir(toolId, callId);
  const outputDir = resolveToolOutputsDir(toolId);
  const screenshotDir = resolveToolScreenshotsDir(toolId);
  const networkDir = resolveToolNetworkDir(toolId);
  const logsDir = resolveToolLogsDir(toolId);

  ensureDir(workspaceDir);
  ensureDir(outputDir);
  ensureDir(screenshotDir);
  ensureDir(networkDir);
  ensureDir(logsDir);

  const argsPath = path.join(workspaceDir, 'args.json');
  fs.writeFileSync(argsPath, JSON.stringify(argsObj || {}, null, 2), 'utf-8');

  const networkLogPath = path.join(networkDir, `${callId}.jsonl`);
  const toolLogPath = path.join(logsDir, 'calls.jsonl');

  const entryAbs = resolveEntryAbsolute(toolId, manifest.entry);

  let command = null;
  let commandArgs = [];

  const argsJson = JSON.stringify(argsObj || {});

  if (manifest.runtime === 'node') {
    command = process.execPath;
    commandArgs = [entryAbs, argsJson];
  } else if (manifest.runtime === 'python') {
    command = process.platform === 'win32' ? 'python' : 'python3';
    commandArgs = [entryAbs, argsJson];
  } else if (manifest.runtime === 'powershell') {
    command = process.platform === 'win32' ? 'powershell' : 'pwsh';
    commandArgs = ['-ExecutionPolicy', 'Bypass', '-File', entryAbs, argsJson];
  } else {
    throw new Error(`Unsupported runtime: ${manifest.runtime}`);
  }

  const timeoutMs = Math.max(
    1000,
    parseInt(
      String(
        (options && options.timeoutMs) ||
        manifest.timeout ||
        process.env.TOOL_DEFAULT_TIMEOUT ||
        '30000'
      ),
      10
    )
  );
  const maxStdout = Math.max(1024, parseInt(process.env.TOOL_MAX_OUTPUT_SIZE || String(2 * 1024 * 1024), 10));

  const child = spawn(command, commandArgs, {
    cwd: workspaceDir,
    env: {
      ...process.env,
      TOOL_ID: toolId,
      TOOL_CALL_ID: callId,
      TOOL_ARGS_PATH: argsPath,
      TOOL_ARGS_JSON: argsJson,
      TOOL_OUTPUT_DIR: outputDir,
      TOOL_SCREENSHOT_DIR: screenshotDir,
      TOOL_NETWORK_LOG: networkLogPath,
      TOOL_NETWORK_ENFORCEMENT: manifest.permissions?.network?.enforcement || 'best_effort'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stdout = '';
  let stderr = '';
  let killedByTimeout = false;

  const timer = setTimeout(() => {
    killedByTimeout = true;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
  }, timeoutMs);

  child.stdout.on('data', (buf) => {
    stdout += buf.toString();
    if (stdout.length > maxStdout) stdout = stdout.slice(stdout.length - maxStdout);
  });

  child.stderr.on('data', (buf) => {
    stderr += buf.toString();
    if (stderr.length > maxStdout) stderr = stderr.slice(stderr.length - maxStdout);
  });

  return new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;

      const record = {
        toolId,
        callId,
        startedAt,
        finishedAt,
        durationMs,
        exitCode: code,
        killedByTimeout,
        args: argsObj || {},
        paths: {
          workspaceDir,
          outputDir,
          screenshotDir,
          networkLogPath
        },
        stdoutTail: tailText(stdout, 8000),
        stderrTail: tailText(stderr, 8000)
      };

      appendJsonl(toolLogPath, record);

      resolve({
        ok: code === 0 && !killedByTimeout,
        record
      });
    });
  });
}

async function callTool(toolId, argsObj, options) {
  const manifest = resolveToolManifest(toolId);
  const state = readToolState();
  const toolState = state.tools && state.tools[toolId] ? state.tools[toolId] : {};
  const enabled = toolState.enabled === true || (toolState.enabled == null && manifest.enabledByDefault);
  if (!enabled) throw new Error(`Tool disabled: ${toolId}`);

  ensureInstalledHash(toolId);

  const callId = createCallId();
  const { ok, record } = await spawnToolProcess(manifest, toolId, callId, argsObj, options);

  // Try parse last JSON object from stdout tail (optional convention).
  let parsedResult = null;
  const lines = String(record.stdoutTail || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      parsedResult = JSON.parse(line);
      break;
    } catch {
      // ignore
    }
  }

  return {
    call_id: callId,
    status: ok ? 'ok' : 'error',
    result: parsedResult || { stdout: record.stdoutTail },
    error: ok ? null : { code: record.killedByTimeout ? 'TIMEOUT' : 'CRASH', message: record.stderrTail || 'Tool failed' },
    record
  };
}

function getToolCallLogs(toolId, limit) {
  const logPath = path.join(resolveToolLogsDir(toolId), 'calls.jsonl');
  return readJsonl(logPath, limit || 50);
}

function getToolNetworkLogs(toolId, limit) {
  const dir = resolveToolNetworkDir(toolId);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  const latest = entries.slice(Math.max(0, entries.length - 10)); // cap reads
  const out = [];
  for (const f of latest) {
    const filePath = path.join(dir, f);
    const rows = readJsonl(filePath, limit || 200);
    out.push({ file: f, rows });
  }
  return out;
}

module.exports = {
  resolveToolsRoot,
  listInstalledTools,
  setToolEnabled,
  getEnabledToolSchemas,
  callTool,
  getToolCallLogs,
  getToolNetworkLogs
};
