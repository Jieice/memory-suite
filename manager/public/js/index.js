/* MCP Dashboard - Memory Suite */
const state = {
  services: [],
  selectedId: null,
  timer: null,
  preflight: null,
  ui: { advancedVisible: false, sovitsExternalManaged: false }
};

const PREFLIGHT_NAMES = ['manager', 'memory-universe', 'live2d', 'memory-tts', 'sovits-api', 'tts-warmup', 'tts-audio-fetch'];

function renderPreflightBoard(preflight) {
  const grid = document.getElementById('pf-grid');
  const meta = document.getElementById('pf-meta');
  if (!grid || !meta) return;
  const checks = Array.isArray(preflight?.checks) ? preflight.checks : [];
  const byName = Object.fromEntries(checks.map(item => [item.name, item]));
  grid.innerHTML = PREFLIGHT_NAMES.map(name => {
    const item = byName[name];
    const klass = item ? (item.ok ? 'ok' : 'bad') : '';
    const status = item ? (item.ok ? 'READY' : 'FAIL') : 'N/A';
    return '<div class="lamp-card"><span class="lamp ' + klass + '"></span><span class="lamp-label">' + name + ': ' + status + '</span></div>';
  }).join('');
  if (!preflight) { meta.textContent = 'Preflight not run.'; return; }
  const okCount = checks.filter(item => item.ok).length;
  const stamp = preflight.timestamp ? ' | ' + new Date(preflight.timestamp).toLocaleTimeString() : '';
  meta.textContent = 'Result: ' + (preflight.success ? 'READY' : 'NOT READY') + ' | ' + okCount + '/' + checks.length + ' checks' + stamp;
}

function statusClass(status) {
  return status === 'running' ? 'running' : 'stopped';
}

function updateAdvancedUi() {
  const adv = document.getElementById('adv-actions');
  const btn = document.getElementById('adv-toggle');
  if (adv) adv.hidden = !state.ui.advancedVisible;
  if (btn) btn.textContent = state.ui.advancedVisible ? '收起' : '更多';
}

function toggleAdvancedActions() {
  state.ui.advancedVisible = !state.ui.advancedVisible;
  updateAdvancedUi();
}

function applySovitsConfig(config) {
  const ext = config?.externalManaged === true;
  state.ui.sovitsExternalManaged = ext;
  const rb = document.getElementById('sovits-restart-btn');
  if (rb) rb.style.display = ext ? 'none' : '';
  const mt = document.getElementById('sovits-mode-tag');
  if (mt) mt.textContent = ext ? 'SoVITS: 外部托管' : 'SoVITS: 内部托管';
}

async function fetchSovitsConfig() {
  const res = await fetch('/api/sovits/config');
  const data = await res.json().catch(() => ({}));
  if (res.ok && data?.success) applySovitsConfig(data);
  return data;
}

async function fetchServices() {
  return (await fetch('/api/services')).json();
}

function renderServices() {
  const container = document.getElementById('services');
  container.innerHTML = '';
  if (!state.services.length) {
    container.innerHTML = '<div class="empty">No services found.</div>';
    return;
  }
  state.services.forEach(svc => {
    const card = document.createElement('div');
    card.className = 'svc-card';
    const running = svc.status === 'running';
    card.innerHTML =
      '<div class="svc-header" onclick="selectService(\'' + svc.id + '\')">' +
        '<div class="svc-title"><span class="dot ' + statusClass(svc.status) + '"></span>' + svc.name + '</div>' +
        '<div style="font-size:12px;color:' + (running ? 'var(--green)' : 'var(--red)') + '">' + (running ? 'running' : 'stopped') + '</div>' +
      '</div>' +
      '<div class="svc-meta"><span>Port: ' + svc.port + '</span><span>' + svc.group + '</span></div>' +
      '<div class="svc-actions">' +
        '<button class="bi" onclick="startService(\'' + svc.id + '\')">Start</button>' +
        '<button class="bw" onclick="restartService(\'' + svc.id + '\')">Restart</button>' +
        '<button class="br" onclick="stopService(\'' + svc.id + '\')">Stop</button>' +
      '</div>';
    container.appendChild(card);
  });
}

async function refreshAll() {
  try {
    state.services = await fetchServices();
    const pf = await fetchLatestPreflight();
    if (pf) { state.preflight = pf; renderPreflightBoard(state.preflight); }
    await fetchSovitsConfig().catch(() => {});
    renderServices();
    if (state.selectedId) loadLogs();
  } catch (e) { console.error('refreshAll:', e); }
}

async function fetchLatestPreflight() {
  try {
    const res = await fetch('/api/live/preflight/latest');
    const data = await res.json().catch(() => ({}));
    return data?.preflight || null;
  } catch (e) { return null; }
}

function selectService(id) {
  state.selectedId = id;
  loadLogs();
}

async function loadLogs() {
  const el = document.getElementById('logs');
  const titleEl = document.getElementById('log-title');
  const svc = state.services.find(s => s.id === state.selectedId);
  if (!svc) {
    el.innerHTML = '<div class="empty">Select a service to view logs.</div>';
    titleEl.textContent = 'Logs';
    return;
  }
  titleEl.textContent = 'Logs: ' + svc.name;
  try {
    const res = await fetch('/api/services/' + svc.id + '/logs?limit=200');
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) { el.innerHTML = '<div class="empty">No logs.</div>'; return; }
    el.innerHTML = data.map(item => {
      const type = item.type === 'stderr' ? 'stderr' : 'stdout';
      const time = item.timestamp ? '<span class="time">[' + item.timestamp + ']</span>' : '';
      return '<div class="log-line ' + type + '">' + time + escHtml(item.message) + '</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    el.innerHTML = '<div class="empty">Failed to load logs: ' + e.message + '</div>';
  }
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function startService(id) {
  await fetch('/api/services/' + id + '/start', { method: 'POST' });
  await refreshAll();
}

async function stopService(id) {
  await fetch('/api/services/' + id + '/stop', { method: 'POST' });
  await refreshAll();
}

async function restartService(id) {
  await stopService(id);
  await new Promise(r => setTimeout(r, 500));
  await startService(id);
}

function collectFailedLabels(checks) {
  const failed = Array.isArray(checks) ? checks.filter(item => !item.ok) : [];
  return failed.map(item => item.name + (item.error ? ' (' + item.error + ')' : ''));
}

async function goLive() {
  const res = await fetch('/api/live/go', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startServices: true, waitReady: true, warmTts: true, playAudio: false, strict: true })
  });
  const data = await res.json().catch(() => ({}));
  const gate = data?.gate || null;
  state.preflight = gate?.preflight || null;
  renderPreflightBoard(state.preflight);
  await refreshAll();
  const failed = gate?.failedLines || collectFailedLabels(gate?.preflight?.checks || []);
  if (res.ok && data.success && gate && !gate.blocked) {
    alert('开播门禁通过：服务、预检、TTS链路均已就绪。');
    return;
  }
  const hintText = Array.isArray(gate?.hints) && gate.hints.length ? '\n建议:\n' + gate.hints.join('\n') : '';
  const failText = Array.isArray(failed) && failed.length ? '\n未通过:\n' + failed.join('\n') : '';
  alert('开播已被门禁阻止。' + failText + hintText);
}

async function startAll() {
  const res = await fetch('/api/services/start-all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preflight: true })
  });
  const data = await res.json().catch(() => ({}));
  state.preflight = data?.preflight || null;
  renderPreflightBoard(state.preflight);
  if (!res.ok || data.success === false) {
    const failed = collectFailedLabels(data?.preflight?.checks || []);
    const tips = failed.length ? '\n未通过: ' + failed.join(', ') : '';
    alert('Start All 已执行，但预检未完全通过。' + tips);
  }
  await refreshAll();
}

async function runPreflightCheck() {
  const res = await fetch('/api/live/preflight', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waitReady: true, warmTts: true })
  });
  const data = await res.json().catch(() => ({}));
  state.preflight = data?.preflight || null;
  renderPreflightBoard(state.preflight);
  const failed = collectFailedLabels(data?.preflight?.checks || []);
  if (res.ok && data.success) { alert('开播预检通过：语音链路已预热。'); }
  else { alert('开播预检未通过:\n' + (failed.length ? failed.join('\n') : '未知错误')); }
}

async function runTtsPreflightCheck() {
  const res = await fetch('/api/live/preflight/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attempts: 3, minPass: 2 })
  });
  const data = await res.json().catch(() => ({}));
  state.preflight = {
    success: !!data?.success,
    checks: Array.isArray(data?.checks) ? data.checks : [],
    timestamp: data?.timestamp || new Date().toISOString()
  };
  renderPreflightBoard(state.preflight);
  if (res.ok && data.success) { alert('TTS 精测通过：SoVITS 可稳定合成。'); }
  else {
    const failed = collectFailedLabels(data?.checks || []);
    alert('TTS 精测未通过:\n' + (failed.length ? failed.join('\n') : (data?.error || '未知错误')));
  }
}

async function restartSovits() {
  if (state.ui.sovitsExternalManaged) { alert('当前 SoVITS 为外部托管，请手动启动/重启。'); return; }
  const res = await fetch('/api/sovits/restart', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waitReady: true, timeoutMs: 180000 })
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) { alert('SoVITS 已重启（耗时 ' + (data.elapsedMs || 0) + 'ms）'); }
  else { alert('SoVITS 重启失败: ' + (data.error || 'unknown')); }
  await refreshAll();
}

async function runTtsSmoke() {
  const res = await fetch('/api/live/tts/smoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playAudio: true })
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) { alert('TTS试音通过：duration=' + data.duration + 's, engine=' + data.engine); }
  else { alert('TTS试音异常：' + (data.error || 'unknown') + '\n(duration=' + (data.duration || 0) + 's)'); }
  await refreshAll();
}

async function openSovitsWeb() {
  try {
    const res = await fetch('/api/sovits/config');
    const data = await res.json().catch(() => ({}));
    const target = data?.webUrl || data?.apiUrl;
    if (!target) { alert('未配置 SoVITS Web/API 地址'); return; }
    window.open(target, '_blank');
  } catch (e) { alert('打开失败: ' + e.message); }
}

async function runIntelligenceEval() {
  try {
    const res = await fetch('/api/eval/intelligence/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset: 'eval/intelligence/dataset.stress.v1.json', endpoint: 'http://127.0.0.1:4005/api/chat', timeout: 35000, retries: 2 })
    });
    const data = await res.json();
    if (!res.ok || !data.success) { alert('评测启动失败: ' + (data.error || 'unknown')); return; }
    alert('评测已启动，约 1~3 分钟后完成。');
    await pollEvalStatus();
  } catch (e) { alert('评测启动失败: ' + e.message); }
}

async function pollEvalStatus() {
  const started = Date.now();
  while (Date.now() - started < 240000) {
    const res = await fetch('/api/eval/intelligence/status');
    const data = await res.json();
    if (!data?.success) break;
    if (!data.state.running) {
      if (Number.isInteger(data.state.exitCode) && data.state.exitCode === 0) {
        alert('评测完成。'); await showLatestEvalReport();
      } else { alert('评测失败，exitCode=' + data.state.exitCode); }
      return;
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  alert('评测轮询超时，请稍后手动查看。');
}

async function showLatestEvalReport() {
  try {
    const listRes = await fetch('/api/eval/intelligence/reports?limit=1');
    const listData = await listRes.json();
    const item = (listData?.items || [])[0];
    if (!item?.mdName) { alert('暂无评测报告。'); return; }
    const rRes = await fetch('/api/eval/intelligence/reports/' + encodeURIComponent(item.mdName));
    const rData = await rRes.json();
    if (!rData?.success) { alert('读取报告失败: ' + (rData?.error || 'unknown')); return; }
    const el = document.getElementById('logs');
    const titleEl = document.getElementById('log-title');
    titleEl.textContent = 'Eval Report: ' + item.mdName;
    const s = item.summary || {};
    const verdict = String(s?.slo?.verdict || 'unknown').toUpperCase();
    el.textContent = [
      'SLO v2 Verdict: ' + verdict,
      'Fast P95/P99: ' + (s.fastP95LatencyMs ?? '-') + ' / ' + (s.fastP99LatencyMs ?? '-') + ' ms',
      'Slow P95/P99: ' + (s.slowP95LatencyMs ?? '-') + ' / ' + (s.slowP99LatencyMs ?? '-') + ' ms',
      'Fallback Rate: ' + (s.fallbackRate != null ? (s.fallbackRate * 100).toFixed(2) + '%' : '-'),
      '', rData.content
    ].join('\n');
    el.scrollTop = 0;
  } catch (e) { alert('读取报告失败: ' + e.message); }
}

async function startSleepMode() {
  try {
    const res = await fetch('/api/live/sleep-mode/start', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) { alert('Sleep Mode 失败: ' + (data.error || 'unknown')); return; }
    alert('Sleep Mode 已触发：记忆整理完成。');
  } catch (e) { alert('Sleep Mode 失败: ' + e.message); }
}

async function stopAll() {
  await fetch('/api/services/stop-all', { method: 'POST' });
  await refreshAll();
}

// Init
(async function init() {
  renderPreflightBoard(null);
  updateAdvancedUi();
  await refreshAll();
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(refreshAll, 5000);
})();
