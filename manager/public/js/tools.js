/* MCP Tool Registry - JavaScript */
let tools = [];
let sched = {};

const ICONS = { echo:'📢', datetime:'🕐', manager_control:'🎛', calculator:'🔢', random:'🎲' };
const ic = id => ICONS[id] || '🔧';
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ── Tab switching ──
function switchTab(t) {
  const names = ['registry','schemas','logs','scheduler'];
  document.querySelectorAll('.tab').forEach((x,i) => x.classList.toggle('active', names[i] === t));
  document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
  document.getElementById('p-' + t).classList.add('active');
  if (t === 'schemas') renderSchemas();
  if (t === 'logs') populateLogSelect();
  if (t === 'scheduler') renderScheduler();
}

// ── Data fetching ──
async function refreshAll() {
  await Promise.all([fetchTools(), fetchScheduler()]);
}

async function fetchTools() {
  try {
    const d = await fetch('/api/tools').then(r => r.json());
    if (d.success) { tools = d.tools; renderTools(); updateStats(); }
  } catch(e) { console.error('fetchTools:', e); }
}

async function fetchScheduler() {
  try {
    const d = await fetch('/api/tools/scheduler/status').then(r => r.json());
    if (d.success) { sched = d; updateStats(); }
  } catch(e) {}
}

// ── Stats ──
function updateStats() {
  document.getElementById('sTotal').textContent = tools.length;
  document.getElementById('sEnabled').textContent = tools.filter(t => t.enabled !== false).length;
  document.getElementById('sSchemas').textContent = tools.reduce((s,t) => s + (t.schemas?.length||0), 0);
  document.getElementById('sAdmin').textContent = tools.filter(t => t.accessLevel === 'admin').length;
  const on = sched.enabled;
  document.getElementById('sSched').innerHTML = on === undefined ? '—'
    : on ? '<span class="dot dot-g"></span>运行中' : '<span class="dot dot-r"></span>已停止';
}

// ── Render tool cards ──
function renderTools() {
  const grid = document.getElementById('toolsGrid');
  if (!tools.length) {
    grid.innerHTML = '<div class="empty"><div class="empty-icon">🔌</div><div>暂无已安装工具</div></div>';
    return;
  }
  grid.innerHTML = '';
  tools.forEach(tool => {
    const en = tool.enabled !== false;
    const card = document.createElement('div');
    card.className = 'tool-card' + (en ? '' : ' off');

    const pills = (tool.schemas||[]).map(s =>
      '<span class="schema-pill" onclick="openSchemaModal(\'' + tool.id + '\')" title="' + esc(s.description||'') + '">' + esc(s.name) + '</span>'
    ).join('');

    const abadge = tool.accessLevel === 'admin'
      ? '<span class="badge bdg-w">Admin</span>'
      : '<span class="badge bdg-s">Public</span>';
    const sbadge = en
      ? '<span class="badge bdg-s"><span class="dot dot-g" style="width:6px;height:6px"></span>启用</span>'
      : '<span class="badge bdg-d">禁用</span>';
    const nbadge = tool.confirmationLevel === 'notify' ? '<span class="badge bdg-p">Notify</span>' : '';

    card.innerHTML =
      '<div class="tc-hdr">' +
        '<div style="display:flex;align-items:flex-start">' +
          '<div class="tc-icon">' + ic(tool.id) + '</div>' +
          '<div><div class="tc-name">' + esc(tool.name) + '</div>' +
          '<div class="tc-id">' + esc(tool.id) + ' · v' + (tool.version||'1.0.0') + '</div></div>' +
        '</div>' +
        '<div class="tc-badges">' + sbadge + abadge + nbadge + '</div>' +
      '</div>' +
      '<div class="tc-body">' +
        '<div class="tc-meta">' +
          '<span>⚙ ' + (tool.runtime||'node') + '</span>' +
          '<span>📄 ' + (tool.entry||'index.js') + '</span>' +
          '<span>⏱ ' + (tool.timeout ? tool.timeout/1000+'s' : '5s') + '</span>' +
          '<span>🔧 ' + (tool.schemas?.length||0) + ' fn</span>' +
        '</div>' +
        (pills ? '<div class="schema-list">' + pills + '</div>' : '<div style="font-size:.82rem;color:var(--tm)">无 Schema</div>') +
      '</div>' +
      '<div class="tc-footer">' +
        (en
          ? '<button class="btn btn-d btn-sm" onclick="toggleTool(\'' + tool.id + '\',false)">禁用</button>'
          : '<button class="btn btn-g btn-sm" onclick="toggleTool(\'' + tool.id + '\',true)">启用</button>') +
        '<button class="btn btn-s btn-sm" onclick="openSchemaModal(\'' + tool.id + '\')">📋 Schema</button>' +
        '<button class="btn btn-s btn-sm" onclick="openRunModal(\'' + tool.id + '\')">▶ 运行</button>' +
        '<button class="btn btn-s btn-sm" onclick="viewToolLogs(\'' + tool.id + '\')">📜 日志</button>' +
      '</div>';
    grid.appendChild(card);
  });
}

// ── Schema browser ──
function renderSchemas() {
  const el = document.getElementById('schemasBrowser');
  if (!tools.length) { el.innerHTML = '<div style="color:var(--tm);padding:1rem">暂无 Schema</div>'; return; }
  let html = '';
  tools.forEach(tool => {
    if (!tool.schemas?.length) return;
    html += '<div style="margin-bottom:1.5rem">' +
      '<div style="font-size:.85rem;font-weight:600;color:var(--t2);margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem">' +
        ic(tool.id) + ' ' + esc(tool.name) + ' <span class="badge bdg-p">' + esc(tool.id) + '</span></div>' +
      '<div class="schema-view">';
    tool.schemas.forEach(s => {
      html += buildSchemaFnHtml(s, tool.id);
    });
    html += '</div></div>';
  });
  el.innerHTML = html || '<div style="color:var(--tm);padding:1rem">暂无 Schema</div>';
}

function buildSchemaFnHtml(s, toolId) {
  const props = s.input?.properties || {};
  const req = s.input?.required || [];
  const params = Object.entries(props).map(([k,v]) =>
    '<div class="sp-row">' +
      '<span class="sp-name">' + esc(k) + '</span>' +
      '<span class="sp-type">' + (v.type||'any') + '</span>' +
      (req.includes(k) ? '<span class="sp-req">*required</span>' : '') +
      '<span class="sp-desc">' + esc(v.description || (v.enum ? v.enum.join(' | ') : '')) + '</span>' +
    '</div>'
  ).join('');
  return '<div class="sfn">' +
    '<div class="sfn-name">fn ' + esc(s.name) + '()</div>' +
    '<div class="sfn-desc">' + esc(s.description||'') + '</div>' +
    (params ? '<div class="sfn-params">' + params + '</div>' : '<div style="font-size:.8rem;color:var(--tm)">无参数</div>') +
    '<button class="btn btn-s btn-sm" style="margin-top:.75rem" onclick="openRunModal(\'' + toolId + '\',\'' + s.name + '\')">▶ 调用此函数</button>' +
  '</div>';
}

// ── Scheduler ──
function renderScheduler() {
  const el = document.getElementById('schedulerInfo');
  const on = sched.enabled;
  const dot = on ? '<span class="dot dot-g"></span>' : '<span class="dot dot-r"></span>';
  el.innerHTML = '<div style="display:flex;gap:2rem;align-items:center;flex-wrap:wrap;font-size:.9rem">' +
    '<div>' + dot + ' 状态: ' + (on ? '运行中' : '已停止') + '</div>' +
    '<div>间隔: ' + (sched.intervalMinutes||5) + ' 分钟</div>' +
    '<div>最小密度: ' + (sched.config?.minInteractionDensity||0) + '</div>' +
    (sched.lastTriggeredAt ? '<div>上次触发: ' + new Date(sched.lastTriggeredAt).toLocaleString() + '</div>' : '') +
  '</div>';
}

async function triggerScheduler() {
  const query = prompt('输入查询（留空使用默认）:');
  try {
    const d = await fetch('/api/tools/scheduler/trigger', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ query: query || undefined })
    }).then(r => r.json());
    alert(d.success ? '调度器触发成功！' : '触发失败: ' + d.error);
  } catch(e) { alert('触发失败: ' + e.message); }
}

// ── Logs ──
function populateLogSelect() {
  const sel = document.getElementById('logToolSelect');
  sel.innerHTML = '<option value="">选择工具</option>';
  tools.forEach(t => {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.appendChild(o);
  });
}

function loadLogs() {
  const id = document.getElementById('logToolSelect').value;
  if (id) viewToolLogs(id);
}

async function viewToolLogs(toolId) {
  switchTab('logs');
  const sel = document.getElementById('logToolSelect');
  if (sel) sel.value = toolId;
  try {
    const d = await fetch('/api/tools/' + toolId + '/logs?limit=30').then(r => r.json());
    const c = document.getElementById('logsContainer');
    if (!d.success || !d.rows?.length) {
      c.innerHTML = '<div style="color:var(--tm);text-align:center;padding:2rem">暂无日志</div>';
      return;
    }
    c.innerHTML = d.rows.map(log =>
      '<div class="log-entry ' + (log.exitCode === 0 ? 'ok' : 'err') + '">' +
        '<div class="log-time">' + new Date(log.startedAt).toLocaleString() + ' · ' + log.durationMs + 'ms · exit:' + log.exitCode + '</div>' +
        '<div style="color:var(--t2);margin-top:.2rem">Args: ' + esc(JSON.stringify(log.args)) + '</div>' +
        (log.stdout ? '<div style="color:var(--s);margin-top:.2rem">' + esc(log.stdout.slice(0,200)) + '</div>' : '') +
      '</div>'
    ).join('');
  } catch(e) { console.error('viewToolLogs:', e); }
}

// ── Toggle tool ──
async function toggleTool(toolId, enable) {
  try {
    const d = await fetch('/api/tools/' + toolId + '/' + (enable ? 'enable' : 'disable'), { method: 'POST' }).then(r => r.json());
    if (d.success) await fetchTools();
  } catch(e) { console.error('toggleTool:', e); }
}

// ── Schema Modal ──
function openSchemaModal(toolId) {
  const tool = tools.find(t => t.id === toolId);
  if (!tool) return;
  document.getElementById('modalToolName').textContent = ic(toolId) + ' ' + tool.name;
  const schemas = tool.schemas || [];
  let html = '<div class="schema-view">';
  if (!schemas.length) {
    html += '<div style="color:var(--tm)">此工具无 Schema 定义</div>';
  } else {
    schemas.forEach(s => { html += buildSchemaFnHtml(s, toolId); });
  }
  html += '</div>';
  document.getElementById('modalToolBody').innerHTML = html;
  document.getElementById('schemaModal').classList.add('active');
}

// ── Run Modal ──
function openRunModal(toolId, fnName) {
  const tool = tools.find(t => t.id === toolId);
  if (!tool) return;
  const schema = fnName ? tool.schemas?.find(s => s.name === fnName) : tool.schemas?.[0];
  document.getElementById('runModalTitle').textContent = '▶ ' + esc(tool.name) + (fnName ? ' · ' + fnName : '');

  const props = schema?.input?.properties || {};
  const req = schema?.input?.required || [];
  let html = '<div class="fg"><label class="fl">Schema</label><div style="font-family:monospace;font-size:.85rem;color:var(--cy)">' + (schema?.name || '(no schema)') + '</div></div>';
  html += '<div id="runFields">';
  Object.entries(props).forEach(([k,v]) => {
    const isEnum = v.enum && v.enum.length;
    html += '<div class="fg"><label class="fl">' + esc(k) +
      (req.includes(k) ? ' <span style="color:var(--d)">*</span>' : '') +
      ' <span style="color:var(--w);font-family:monospace;font-size:.78rem">' + (v.type||'any') + '</span></label>';
    if (isEnum) {
      html += '<select class="fi" data-key="' + esc(k) + '"><option value="">-- 选择 --</option>' +
        v.enum.map(e => '<option>' + esc(e) + '</option>').join('') + '</select>';
    } else {
      html += '<input type="text" class="fi" data-key="' + esc(k) + '" placeholder="' + esc(v.description||'') + '">';
    }
    html += '</div>';
  });
  if (!Object.keys(props).length) html += '<div style="color:var(--tm);font-size:.85rem;margin-bottom:1rem">此函数无参数</div>';
  html += '</div>';
  html += '<button class="btn btn-p" onclick="execRun(\'' + toolId + '\')">▶ 执行</button>';
  html += '<div id="runResult"></div>';

  document.getElementById('runModalBody').innerHTML = html;
  document.getElementById('runModal').classList.add('active');
  document.getElementById('runModal').dataset.toolId = toolId;
}

async function execRun(toolId) {
  const fields = document.querySelectorAll('#runFields [data-key]');
  const args = {};
  fields.forEach(f => { if (f.value) args[f.dataset.key] = f.value; });

  const resEl = document.getElementById('runResult');
  resEl.innerHTML = '<div style="color:var(--t2);padding:.5rem">执行中...</div>';

  try {
    const d = await fetch('/api/tools/' + toolId + '/run', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ args })
    }).then(r => r.json());

    if (d.success) {
      resEl.innerHTML = '<div class="result-box">' + esc(JSON.stringify(d.result, null, 2)) + '</div>';
    } else {
      resEl.innerHTML = '<div class="result-box err">' + esc(d.error?.message || JSON.stringify(d.error)) + '</div>';
    }
  } catch(e) {
    resEl.innerHTML = '<div class="result-box err">' + esc(e.message) + '</div>';
  }
}

// ── Router modal ──
function openRouterModal() {
  document.getElementById('routerModal').classList.add('active');
}

async function runRouterTest() {
  const text = document.getElementById('routerInput').value;
  const userId = document.getElementById('routerUserId').value;
  if (!text) { alert('请输入测试文本'); return; }
  try {
    const d = await fetch('/api/tools/route', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ userText: text, userId })
    }).then(r => r.json());
    document.getElementById('routerResult').innerHTML = '<div class="result-box">' + esc(JSON.stringify(d, null, 2)) + '</div>';
  } catch(e) { alert('路由测试失败: ' + e.message); }
}

async function runRouterInline() {
  const text = document.getElementById('routerInputInline').value;
  const userId = document.getElementById('routerUserIdInline').value;
  if (!text) { alert('请输入测试文本'); return; }
  try {
    const d = await fetch('/api/tools/route', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ userText: text, userId })
    }).then(r => r.json());
    document.getElementById('routerResultInline').innerHTML = '<div class="result-box">' + esc(JSON.stringify(d, null, 2)) + '</div>';
  } catch(e) { alert('路由测试失败: ' + e.message); }
}

// ── Modal utils ──
function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

// ── Init ──
refreshAll();
setInterval(refreshAll, 30000);
