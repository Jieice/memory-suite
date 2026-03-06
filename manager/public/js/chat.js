/* MCP Creator Chat - Memory Suite */
const WEB_MANAGER_URL = '';
let isConnected = false;
let isTyping = false;
let activeBackgroundJobId = null;
let backgroundPollTimer = null;
const DEFAULT_VARIATION = 0.35;

async function checkConnection() {
  const statusEl = document.getElementById('connection-status');
  try {
    const resp = await fetch('/api/services/memory-universe/health', { timeout: 3000 });
    if (resp.ok) {
      const data = await resp.json();
      isConnected = data.success !== false;
      if (isConnected) {
        statusEl.className = 'status connected';
        statusEl.innerHTML = '<span class="status-dot"></span><span>已连接 Memory Suite</span>';
      } else { throw new Error('Service not healthy'); }
    } else { throw new Error('Not OK'); }
  } catch (e) {
    try {
      const resp = await fetch('/health', { timeout: 3000 });
      if (resp.ok) {
        isConnected = true;
        statusEl.className = 'status connected';
        statusEl.innerHTML = '<span class="status-dot"></span><span>已连接 Web Manager</span>';
        return;
      }
    } catch (e2) {}
    isConnected = false;
    statusEl.className = 'status';
    statusEl.innerHTML = '<span class="status-dot"></span><span>未连接</span>';
  }
}

function addMessage(content, isUser, meta) {
  meta = meta || {};
  const messagesEl = document.getElementById('messages');
  const emptyState = messagesEl.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const messageEl = document.createElement('div');
  messageEl.className = 'message ' + (isUser ? 'user' : 'ai');
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  const badges = [];
  if (!isUser && meta.candidate) {
    badges.push('<span class="badge">' + escapeHtml(String(meta.candidate)) + '</span>');
  }
  if (!isUser && meta.llmProvider) {
    const provider = String(meta.llmProvider).trim().toLowerCase();
    if (provider) badges.push('<span class="badge provider provider-' + provider + '">LLM:' + escapeHtml(provider) + '</span>');
  }
  if (!isUser && meta.llmCloudRuntimeMode) {
    const mode = String(meta.llmCloudRuntimeMode).trim().toLowerCase();
    if (mode) badges.push('<span class="badge mode">cloud:' + escapeHtml(mode) + '</span>');
  }

  let metaHtml = '<span>' + time + '</span>';
  if (badges.length) metaHtml += '<span class="badges">' + badges.join('') + '</span>';

  messageEl.innerHTML = '<div class="content">' + escapeHtml(content) + '</div><div class="meta">' + metaHtml + '</div>';
  messagesEl.appendChild(messageEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showTypingIndicator() {
  if (isTyping) return;
  isTyping = true;
  const messagesEl = document.getElementById('messages');
  const indicator = document.createElement('div');
  indicator.className = 'message ai';
  indicator.id = 'typing-indicator';
  indicator.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  messagesEl.appendChild(indicator);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideTypingIndicator() {
  isTyping = false;
  const indicator = document.getElementById('typing-indicator');
  if (indicator) indicator.remove();
}

async function sendMessage() {
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const text = input.value.trim();
  if (!text) return;
  if (!isConnected) { alert('未连接到 Memory Suite，请检查服务是否已启动'); return; }

  addMessage(text, true);
  input.value = '';
  sendBtn.disabled = true;

  if (text.startsWith('/')) {
    const handled = await handleCommand(text);
    if (handled) { sendBtn.disabled = false; return; }
  }

  await sendToCreatorApi(text);
  sendBtn.disabled = false;
  input.focus();
}

function buildReadinessText(readiness) {
  const data = readiness || {};
  const preflight = data.preflight || {};
  const checks = Array.isArray(preflight.checks) ? preflight.checks : [];
  const okCount = checks.filter(function(item) { return item && item.ok; }).length;
  const failedLines = Array.isArray(data.failedLines) ? data.failedLines : [];
  const hints = Array.isArray(data.hints) ? data.hints : [];
  const lines = [];
  lines.push('Readiness: ' + (data.blocked ? 'BLOCKED' : 'READY'));
  lines.push('Preflight: ' + okCount + '/' + checks.length + ' checks');
  if (failedLines.length) { lines.push('Failed:'); failedLines.slice(0, 8).forEach(function(item) { lines.push('- ' + item); }); }
  if (hints.length) { lines.push('Hints:'); hints.slice(0, 4).forEach(function(item) { lines.push('- ' + item); }); }
  return lines.join('\n');
}

function buildGoGateText(gate) {
  const data = gate || {};
  const preflightChecks = Array.isArray(data.preflight?.checks) ? data.preflight.checks : [];
  const preflightOk = preflightChecks.filter(function(item) { return item && item.ok; }).length;
  const status = data.blocked ? 'BLOCKED' : 'READY';
  const lines = [
    'Go-Live Gate: ' + status,
    'Elapsed: ' + Math.max(0, Number(data.elapsedMs || 0)) + 'ms',
    'Preflight: ' + preflightOk + '/' + preflightChecks.length,
    'Smoke: ' + (data.smoke?.success ? 'OK' : 'FAIL')
  ];
  const failedLines = Array.isArray(data.failedLines) ? data.failedLines : [];
  if (failedLines.length) { lines.push('Failed:'); failedLines.slice(0, 8).forEach(function(item) { lines.push('- ' + item); }); }
  const hints = Array.isArray(data.hints) ? data.hints : [];
  if (hints.length) { lines.push('Hints:'); hints.slice(0, 4).forEach(function(item) { lines.push('- ' + item); }); }
  return lines.join('\n');
}

async function fetchReadinessSnapshot(refresh, includeSmoke) {
  const query = new URLSearchParams({
    refresh: refresh ? 'true' : 'false',
    warmTts: 'false', waitReady: 'false',
    includeSmoke: includeSmoke ? 'true' : 'false'
  });
  const resp = await fetch('/api/live/readiness?' + query.toString());
  const data = await resp.json().catch(function() { return {}; });
  if (!resp.ok || !data?.success) throw new Error(data?.error || 'readiness check failed');
  return data.readiness || null;
}

async function handleCommand(command) {
  const raw = String(command || '').trim();
  const head = raw.split(/\s+/, 1)[0];
  const cmd = head.toLowerCase();

  if (cmd === '/readiness') {
    addMessage('正在读取开播就绪状态...', false);
    try { const r = await fetchReadinessSnapshot(true, false); addMessage(buildReadinessText(r), false); }
    catch (e) { addMessage('读取开播就绪状态失败: ' + e.message, false); }
    return true;
  }

  if (cmd === '/go') {
    addMessage('正在执行一键开播门禁...', false);
    try {
      const resp = await fetch('/api/live/go', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startServices: true, waitReady: true, warmTts: true, playAudio: false, strict: true })
      });
      const data = await resp.json().catch(function() { return {}; });
      const gate = data?.gate || null;
      if (!gate) { addMessage('开播门禁执行失败: ' + (data?.error || 'unknown'), false); return true; }
      const header = (resp.ok && data.success && !gate.blocked) ? '开播门禁通过' : '开播门禁未通过';
      addMessage(header + '\n' + buildGoGateText(gate), false);
    } catch (e) { addMessage('开播门禁执行失败: ' + e.message, false); }
    return true;
  }

  if (cmd === '/selfcheck') {
    addMessage('正在执行自我感知测试...', false);
    try {
      const readiness = await fetchReadinessSnapshot(true, true);
      const summary = buildReadinessText(readiness);
      addMessage(summary, false);
      await sendToCreatorApi('请基于以下系统状态，用中文回答三点：\n1) 你当前明确可用的能力\n2) 你当前不确定或不可用的能力\n3) 为了能开播，我下一步该做什么\n\n' + summary);
    } catch (e) { addMessage('自我感知测试失败: ' + e.message, false); }
    return true;
  }

  if (cmd === '/status') {
    try {
      const resp = await fetch('/api/stats');
      const data = await resp.json();
      if (data.success) {
        const s = data.stats;
        addMessage('📊 系统状态\n• 消息总数: ' + (s.messages?.total || 0) + '\n• 成功率: ' + (s.messages?.successRate || 'N/A') + '\n• 记忆节点: ' + (s.memory?.totalNodes || 0) + '\n• LLM调用: ' + (s.llm?.totalCalls || 0) + '\n• 运行时间: ' + (s.uptime || 'N/A'), false);
      } else { addMessage('❌ 获取状态失败', false); }
    } catch (e) { addMessage('❌ 获取状态失败: ' + e.message, false); }
    return true;
  }

  if (cmd === '/train') {
    addMessage('🔄 正在触发训练...', false);
    try {
      const resp = await fetch('/api/training/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'creator-manual' }) });
      const data = await resp.json();
      addMessage(data.success ? '✅ 训练已启动' : '❌ ' + (data.error || '训练启动失败'), false);
    } catch (e) { addMessage('❌ 训练启动失败: ' + e.message, false); }
    return true;
  }

  if (cmd === '/reflect') {
    addMessage('🤔 正在触发反思...', false);
    try {
      const resp = await fetch('/api/reflection/check', { method: 'POST' });
      const data = await resp.json();
      if (data.success && data.reflection) {
        addMessage('✅ 反思完成\n• 发现 ' + (data.reflection.patterns?.length || 0) + ' 个模式\n• 发现 ' + (data.reflection.contradictions?.length || 0) + ' 个矛盾', false);
      } else { addMessage('ℹ️ 暂无需要反思的内容', false); }
    } catch (e) { addMessage('❌ 反思失败: ' + e.message, false); }
    return true;
  }

  return false;
}

async function sendToCreatorApi(text) {
  if (backgroundPollTimer) { clearTimeout(backgroundPollTimer); backgroundPollTimer = null; }
  activeBackgroundJobId = null;
  showTypingIndicator();
  try {
    const resp = await fetch('/api/chat/dual', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, source: 'creator', userId: 'creator', userName: 'creator' })
    });
    const data = await resp.json();
    hideTypingIndicator();
    if (!data.success) { addMessage('❌ 错误: ' + (data.error || '未知错误'), false); return; }

    const fg = data.foreground || {};
    const fgText = fg.text || fg.response || '';
    const fgProvider = fg.llmProvider || fg.metadata?.llmProvider || null;
    const fgCloudMode = fg.metadata?.llmCloudRuntimeMode || null;
    const fgMeta = { candidate: fg.usedCandidate || 'fast', llmProvider: fgProvider, llmCloudRuntimeMode: fgCloudMode };
    addMessage(fgText || JSON.stringify(fg, null, 2), false, fgMeta);

    if (data.jobId) { activeBackgroundJobId = data.jobId; await pollBackgroundResult(data.jobId); }
  } catch (e) { hideTypingIndicator(); addMessage('❌ 请求失败: ' + e.message, false); }
}

async function pollBackgroundResult(jobId) {
  const startedAt = Date.now();
  const maxWaitMs = 90000;
  async function tick() {
    if (!jobId || jobId !== activeBackgroundJobId) return;
    if (Date.now() - startedAt > maxWaitMs) { activeBackgroundJobId = null; return; }
    try {
      const resp = await fetch('/api/chat/result?jobId=' + encodeURIComponent(jobId));
      const data = await resp.json();
      if (!data.success) { backgroundPollTimer = setTimeout(tick, 800); return; }
      if (data.status === 'done') {
        activeBackgroundJobId = null;
        const bg = data.result || {};
        const bgText = bg.text || bg.response || '';
        const bgProvider = bg.llmProvider || bg.metadata?.llmProvider || null;
        const bgCloudMode = bg.metadata?.llmCloudRuntimeMode || null;
        addMessage(bgText || JSON.stringify(bg, null, 2), false, { candidate: '补充', llmProvider: bgProvider, llmCloudRuntimeMode: bgCloudMode });
        return;
      }
      if (data.status === 'error') { activeBackgroundJobId = null; addMessage('❌ 后台错误: ' + (data.error || '未知错误'), false); return; }
      backgroundPollTimer = setTimeout(tick, 800);
    } catch (e) { backgroundPollTimer = setTimeout(tick, 800); }
  }
  await tick();
}

function setInputText(value) {
  const input = document.getElementById('message-input');
  input.value = value; input.focus();
}

function insertCommand(prefix) {
  const input = document.getElementById('message-input');
  const current = input.value || '';
  input.value = !current.trim().length ? prefix : (current + (current.endsWith(' ') ? '' : ' ') + prefix);
  input.focus();
}

async function sendCreatorCommand(prefixOrFull) {
  const quick = document.getElementById('quick-text');
  const text = (quick && quick.value ? quick.value.trim() : '');
  let msg = prefixOrFull;
  if (prefixOrFull.endsWith(' ') && text) msg = prefixOrFull + text;
  if (prefixOrFull.endsWith(' ') && !text) { setInputText(prefixOrFull); return; }
  addMessage(msg, true);
  await sendToCreatorApi(msg);
}

async function sendMessageFromPalette(text) {
  addMessage(text, true);
  const handled = await handleCommand(text);
  if (!handled) await sendToCreatorApi(text);
}

async function quickSay() { await sendCreatorCommand('/say '); }
async function quickSubtitle() { await sendCreatorCommand('/subtitle '); }
async function quickGo() { addMessage('/go', true); await handleCommand('/go'); }
async function quickReadiness() { addMessage('/readiness', true); await handleCommand('/readiness'); }
async function quickSelfCheck() { addMessage('/selfcheck', true); await handleCommand('/selfcheck'); }
async function quickClear() { addMessage('/clear', true); await sendToCreatorApi('/clear'); }
async function quickStop() { addMessage('/stop', true); await sendToCreatorApi('/stop'); }

function format01(value) {
  const n = Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return DEFAULT_VARIATION.toFixed(2);
  return Math.max(0, Math.min(1, n)).toFixed(2);
}

function onVariationSlide(value) {
  const el = document.getElementById('variation-value');
  if (el) el.textContent = format01(value);
}

async function applyTraitVariation() {
  const slider = document.getElementById('variation-slider');
  const value = format01(slider && slider.value ? slider.value : DEFAULT_VARIATION);
  if (slider) slider.value = value;
  onVariationSlide(value);
  const cmd = '/trait variation ' + value;
  addMessage(cmd, true);
  await sendToCreatorApi(cmd);
}

async function quickTraitStatus() { addMessage('/trait status', true); await sendToCreatorApi('/trait status'); }

async function applyCloudMode() {
  const select = document.getElementById('cloud-mode-select');
  const modeRaw = select && select.value ? select.value : 'auto';
  const mode = ['auto', 'on', 'off'].includes(modeRaw) ? modeRaw : 'auto';
  const cmd = '/llm cloud ' + mode;
  addMessage(cmd, true);
  await sendToCreatorApi(cmd);
}

async function quickLlmStatus() { addMessage('/llm status', true); await sendToCreatorApi('/llm status'); }

function togglePalette() {
  const el = document.getElementById('command-palette');
  const btn = document.getElementById('palette-toggle');
  if (!el || !btn) return;
  const isOpen = el.style.display !== 'none';
  el.style.display = isOpen ? 'none' : 'block';
  btn.textContent = isOpen ? '展开命令面板' : '收起命令面板';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, '<br>');
}

async function fetchTasks() {
  try {
    const resp = await fetch('/api/memory/tasks');
    if (!resp.ok) return;
    const tasks = await resp.json();
    renderTasks(tasks);
  } catch (e) { console.error('Failed to fetch tasks', e); }
}

function renderTasks(tasks) {
  const listEl = document.getElementById('task-list');
  const panelEl = document.getElementById('tasks-panel');
  if (!listEl || !panelEl) return;
  const openTasks = tasks.filter(function(t) { return t.status === 'open'; });
  if (!openTasks.length) { panelEl.style.display = 'none'; return; }
  panelEl.style.display = 'block';
  listEl.innerHTML = openTasks.map(function(task) {
    return '<div class="task-item"><div class="task-text">' + escapeHtml(task.text) + '</div><div class="task-actions"><button class="task-btn done-btn" onclick="updateTaskStatus(\'' + task.text.replace(/'/g, "\\'") + '\', \'done\')">完成</button></div></div>';
  }).join('');
}

async function updateTaskStatus(text, status) {
  try {
    const resp = await fetch('/api/memory/tasks/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, status: status })
    });
    if (resp.ok) await fetchTasks();
  } catch (e) { console.error('Failed to update task', e); }
}

// Init
document.getElementById('message-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendMessage(); }
});
onVariationSlide(DEFAULT_VARIATION);
checkConnection();
fetchTasks();
setInterval(checkConnection, 10000);
setInterval(fetchTasks, 30000);
