/* MCP Memory Space - Memory Suite */
let knowledgeItems = [];
let learningStats = {};
let schedulerStats = {};
let styleProfiles = [];
let danmakuStyleInfo = {};

function switchTab(t) {
  const names = ['browse', 'danmaku', 'fetch'];
  document.querySelectorAll('.tab').forEach((x, i) => x.classList.toggle('active', names[i] === t));
  document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
  document.getElementById('p-' + t).classList.add('active');
}

function showToast(message, type) {
  type = type || 'info';
  const toast = document.createElement('div');
  toast.className = 'toast';
  const color = type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--primary-light)';
  toast.innerHTML = '<div style="color:' + color + ';font-weight:600">' + esc(message) + '</div>';
  document.body.appendChild(toast);
  setTimeout(function() { toast.remove(); }, 3000);
}

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function api(url, options) {
  try { const res = await fetch(url, options); return await res.json(); }
  catch (e) { console.error('API Error:', e); return { success: false, error: e.message }; }
}

// ── Stats ──
async function refreshAll() {
  await Promise.all([refreshLearningStats(), refreshSchedulerStats(), refreshStyleProfiles(), refreshDanmakuStyle()]);
}

async function refreshLearningStats() {
  const data = await api('/api/learning/stats');
  if (data.success) {
    learningStats = data.stats || {};
    updateStats();
  }
}

async function refreshSchedulerStats() {
  const data = await api('/api/knowledge/scheduler/stats');
  if (data.success) {
    schedulerStats = data.stats || {};
    updateFetchInfo();
  }
}

async function refreshStyleProfiles() {
  const data = await api('/api/knowledge/style/profiles');
  if (data.success) styleProfiles = data.profiles || [];
}

async function refreshDanmakuStyle() {
  try {
    const data = await api('/api/danmaku-style/status');
    if (data.success) { danmakuStyleInfo = data; renderDanmakuStyle(); }
  } catch (e) {}
}

function updateStats() {
  const s = learningStats;
  document.getElementById('sTotalK').textContent = s.totalKnowledge || 0;
  document.getElementById('sUntrained').textContent = s.newKnowledgeSinceLastTrain || 0;
  document.getElementById('sSessions').textContent = s.totalTrainingSessions || 0;
  document.getElementById('sModel').textContent = s.currentModelVersion || '-';
  const isRunning = s.isRunning;
  document.getElementById('sStatus').innerHTML = isRunning
    ? '<span class="dot dot-g"></span>监控中'
    : '<span class="dot dot-r"></span>已停止';
}

// ── Knowledge Browser ──
async function searchKnowledge() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) { showToast('请输入关键词', 'error'); return; }
  const data = await api('/api/knowledge/store/search?q=' + encodeURIComponent(q) + '&limit=30');
  if (data.success) {
    knowledgeItems = data.results || [];
    renderKnowledgeList();
    showToast('找到 ' + knowledgeItems.length + ' 条结果', 'success');
  } else {
    showToast('搜索失败: ' + (data.error || ''), 'error');
  }
}

async function loadAllKnowledge() {
  const data = await api('/api/knowledge/store/search?q=&limit=50');
  if (data.success) {
    knowledgeItems = data.results || [];
    renderKnowledgeList();
  }
}

function renderKnowledgeList() {
  const el = document.getElementById('kList');
  if (!knowledgeItems.length) {
    el.innerHTML = '<div class="empty">暂无知识条目，尝试搜索或获取新知识</div>';
    return;
  }
  el.innerHTML = knowledgeItems.map(function(item) {
    return '<div class="k-item">' +
      '<div class="k-item-hdr">' +
        '<span class="k-item-title">' + esc(item.title || '无标题') + '</span>' +
        '<span class="badge bdg-p">' + esc(item.source || 'unknown') + '</span>' +
      '</div>' +
      '<div class="k-item-content">' + esc((item.content || '').slice(0, 200)) + (item.content && item.content.length > 200 ? '...' : '') + '</div>' +
      (item.createdAt ? '<div class="k-item-time">' + new Date(item.createdAt).toLocaleString() + '</div>' : '') +
    '</div>';
  }).join('');
}

// ── Danmaku Style ──
function renderDanmakuStyle() {
  const el = document.getElementById('danmakuInfo');
  const d = danmakuStyleInfo;
  const status = d.learnerStatus || 'unknown';
  const samples = d.sampleCount || 0;
  const patterns = d.patternCount || 0;
  const slangs = d.topSlangs || [];

  let html = '<div class="info-box">' +
    '<div class="info-row"><span class="info-label">学习状态</span><span class="info-value">' + esc(status) + '</span></div>' +
    '<div class="info-row"><span class="info-label">已学习弹幕</span><span class="info-value">' + samples + '</span></div>' +
    '<div class="info-row"><span class="info-label">学习到的模式</span><span class="info-value">' + patterns + '</span></div>' +
    '</div>';

  if (slangs.length) {
    html += '<div style="margin-top:.75rem"><div style="font-size:.85rem;font-weight:600;margin-bottom:.4rem;color:var(--muted)">热门用语</div>';
    html += slangs.map(function(s) { return '<span class="slang-tag">' + esc(s) + '</span>'; }).join('');
    html += '</div>';
  }

  html += '<div style="margin-top:.5rem;font-size:.75rem;color:var(--dim)">💡 弹幕会自动学习，开播后数据会逐渐积累</div>';
  el.innerHTML = html;
}

// ── Knowledge Fetch ──
function updateFetchInfo() {
  const s = schedulerStats;
  const statusEl = document.getElementById('fetchStatus');
  const isRunning = s.isRunning;
  statusEl.innerHTML = isRunning
    ? '<span class="badge bdg-s"><span class="dot dot-g" style="width:6px;height:6px"></span> 运行中</span>'
    : '<span class="badge bdg-d">已停止</span>';

  document.getElementById('fetchCount').textContent = s.totalFetched || 0;
  document.getElementById('fetchFailed').textContent = s.totalFailed || 0;
  document.getElementById('fetchLast').textContent = s.lastFetchTime
    ? new Date(s.lastFetchTime).toLocaleString() : '-';

  const toggleBtn = document.getElementById('btnToggleSched');
  if (toggleBtn) {
    toggleBtn.textContent = isRunning ? '停止调度器' : '启动调度器';
    toggleBtn.className = isRunning ? 'btn btn-s btn-sm' : 'btn btn-p btn-sm';
  }
}

async function toggleScheduler() {
  const isRunning = schedulerStats.isRunning;
  const endpoint = isRunning ? '/api/knowledge/scheduler/stop' : '/api/knowledge/scheduler/start';
  const data = await api(endpoint, { method: 'POST' });
  if (data.success) {
    showToast(isRunning ? '调度器已停止' : '调度器已启动', 'success');
    await refreshSchedulerStats();
  } else {
    showToast('操作失败', 'error');
  }
}

async function fetchHotTopics() {
  showToast('正在抓取热点话题...');
  const data = await api('/api/knowledge/scheduler/trigger', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'hotTopic' })
  });
  if (data.success) {
    showToast('热点话题抓取已触发！', 'success');
    setTimeout(function() { refreshSchedulerStats(); loadAllKnowledge(); }, 5000);
  } else {
    showToast('抓取失败: ' + (data.error || '调度器可能未启动'), 'error');
  }
}

async function fetchFromSource(source) {
  const keyword = document.getElementById('fetchKeyword').value.trim();
  if (!keyword) { showToast('请先输入关键词', 'error'); return; }
  showToast('正在从 ' + source + ' 获取...');
  const data = await api('/api/knowledge/fetch/' + source, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: keyword, limit: 5 })
  });
  if (data.success) {
    showToast('获取成功！', 'success');
    await refreshSchedulerStats();
    await loadAllKnowledge();
  } else {
    showToast('获取失败: ' + (data.error || ''), 'error');
  }
}

async function trainStyle() {
  showToast('正在分析风格...');
  const data = await api('/api/knowledge/style/train', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 50 })
  });
  if (data.success) {
    showToast('风格分析完成！', 'success');
    await refreshStyleProfiles();
  } else {
    showToast('分析失败', 'error');
  }
}

// ── Init ──
refreshAll();
loadAllKnowledge();
setInterval(refreshAll, 30000);
