/* MCP LoRA Training - Memory Suite */
let pollTimer = null;

async function refreshDataStats() {
  try {
    const resp = await fetch('/api/training/data-stats');
    const data = await resp.json();
    const el = document.getElementById('data-stats');
    if (!data.success) { el.innerHTML = '<div class="stat-row"><span class="stat-label">加载失败</span></div>'; return; }

    let html = '';
    (data.sources || []).forEach(function(src) {
      html += '<div class="stat-row"><span class="stat-label">' + esc(src.name) + '</span><span class="stat-value">' + src.samples + ' 条</span></div>';
    });
    html += '<div class="stat-row"><span class="stat-label">数据源总计</span><span class="stat-value highlight">' + data.totalSamples + ' 条</span></div>';
    if (data.trainData) {
      html += '<div class="stat-row"><span class="stat-label">已准备训练集 (train.jsonl)</span><span class="stat-value highlight">' + data.trainData.samples + ' 条</span></div>';
    }
    el.innerHTML = html;
  } catch (e) {
    document.getElementById('data-stats').innerHTML = '<div class="stat-row"><span class="stat-label">错误: ' + esc(e.message) + '</span></div>';
  }
}

async function prepareData() {
  if (!confirm('将从所有数据源提取并合并训练数据，是否继续？')) return;
  document.getElementById('btn-prepare').disabled = true;
  try {
    const resp = await fetch('/api/training/prepare-data', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await resp.json();
    if (data.success) { startPolling(); }
    else { alert('启动失败: ' + (data.error || '未知错误')); }
  } catch (e) { alert('请求失败: ' + e.message); }
  finally { document.getElementById('btn-prepare').disabled = false; }
}

async function startTraining() {
  if (!confirm('确认开始 LoRA 训练？这可能需要较长时间。')) return;
  const params = {
    epochs: parseInt(document.getElementById('cfg-epochs').value, 10),
    lr: document.getElementById('cfg-lr').value,
    batchSize: parseInt(document.getElementById('cfg-batch').value, 10),
    loraR: parseInt(document.getElementById('cfg-lora-r').value, 10),
    loraAlpha: parseInt(document.getElementById('cfg-lora-alpha').value, 10),
    baseModel: document.getElementById('cfg-model').value
  };

  document.getElementById('btn-train').disabled = true;
  document.getElementById('btn-abort').disabled = false;

  try {
    const resp = await fetch('/api/training/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    const data = await resp.json();
    if (data.success) { startPolling(); }
    else {
      alert('启动失败: ' + (data.error || '未知错误'));
      document.getElementById('btn-train').disabled = false;
      document.getElementById('btn-abort').disabled = true;
    }
  } catch (e) {
    alert('请求失败: ' + e.message);
    document.getElementById('btn-train').disabled = false;
    document.getElementById('btn-abort').disabled = true;
  }
}

async function abortTraining() {
  if (!confirm('确认中止训练？')) return;
  try { await fetch('/api/training/abort', { method: 'POST' }); }
  catch (e) { alert('中止失败: ' + e.message); }
}

async function exportModel() {
  if (!confirm('将导出 GGUF 量化模型，是否继续？')) return;
  try {
    const resp = await fetch('/api/training/export', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await resp.json();
    if (data.success) { startPolling(); }
    else { alert('导出失败: ' + (data.error || '未知错误')); }
  } catch (e) { alert('请求失败: ' + e.message); }
}

async function pollStatus() {
  try {
    const resp = await fetch('/api/training/status');
    const data = await resp.json();
    if (!data.success) return;

    const badge = document.getElementById('status-badge');
    badge.textContent = data.status.toUpperCase();
    badge.className = 'status-badge ' + data.status;

    const p = data.progress || {};
    document.getElementById('m-epoch').textContent = p.epoch != null ? p.epoch + '/' + (p.totalEpochs || '?') : '-';
    document.getElementById('m-step').textContent = p.step != null ? p.step + '/' + (p.totalSteps || '?') : '-';
    document.getElementById('m-loss').textContent = p.loss != null ? p.loss.toFixed(4) : '-';
    document.getElementById('m-lr').textContent = p.lr != null ? p.lr.toExponential(2) : '-';

    let pct = 0;
    if (p.totalSteps && p.step) pct = Math.min(100, (p.step / p.totalSteps) * 100);
    else if (p.totalEpochs && p.epoch) pct = Math.min(100, (p.epoch / p.totalEpochs) * 100);
    document.getElementById('progress-fill').style.width = pct + '%';

    const logEl = document.getElementById('log-viewer');
    if (data.logs && data.logs.length > 0) {
      logEl.innerHTML = data.logs.map(function(l) {
        var cls = l.startsWith('[stderr]') ? ' class="stderr"' : '';
        return '<div' + cls + '>' + esc(l) + '</div>';
      }).join('');
      logEl.scrollTop = logEl.scrollHeight;
    }

    var isActive = data.status === 'training' || data.status === 'preparing' || data.status === 'exporting';
    document.getElementById('btn-train').disabled = isActive;
    document.getElementById('btn-abort').disabled = data.status !== 'training';
    document.getElementById('btn-prepare').disabled = isActive;
    document.getElementById('btn-export').disabled = isActive;

    if (!isActive && pollTimer) {
      stopPolling();
      refreshDataStats();
      refreshHistory();
    }
  } catch (e) { /* ignore polling errors */ }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollStatus, 2000);
  pollStatus();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function refreshHistory() {
  try {
    const resp = await fetch('/api/training/history');
    const data = await resp.json();
    const tbody = document.getElementById('history-body');
    if (!data.success || !data.history || !data.history.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted);text-align:center">暂无训练记录</td></tr>';
      return;
    }
    tbody.innerHTML = data.history.map(function(h) {
      var duration = h.finishedAt && h.startedAt ? Math.round((h.finishedAt - h.startedAt) / 1000 / 60) + ' min' : '-';
      var statusCls = h.status === 'success' ? 'success' : 'failed';
      return '<tr>' +
        '<td>' + new Date(h.startedAt).toLocaleString() + '</td>' +
        '<td>' + esc(h.params?.baseModel || '-') + '</td>' +
        '<td>' + (h.params?.epochs || '-') + '</td>' +
        '<td>' + esc(h.params?.lr || '-') + '</td>' +
        '<td>' + (h.finalLoss != null ? h.finalLoss.toFixed(4) : '-') + '</td>' +
        '<td class="' + statusCls + '">' + esc(h.status) + '</td>' +
        '<td>' + duration + '</td>' +
        '</tr>';
    }).join('');
  } catch (e) { /* ignore */ }
}

function esc(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Init
refreshDataStats();
refreshHistory();
pollStatus().then(function() {
  var badge = document.getElementById('status-badge');
  if (badge && (badge.textContent === 'TRAINING' || badge.textContent === 'PREPARING' || badge.textContent === 'EXPORTING')) {
    startPolling();
  }
});
