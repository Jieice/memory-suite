import fs from 'fs';
import path from 'path';

const baseUrl = process.env.MEMORY_UNIVERSE_URL || 'http://127.0.0.1:4005';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

async function postJson(url, body, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function chat(userId, message) {
  const start = Date.now();
  const result = await postJson(`${baseUrl}/api/chat`, { userId, userName: userId, message });
  return {
    latencyMs: Date.now() - start,
    ...result
  };
}

function includesAny(text, markers) {
  const t = (text || '').toLowerCase();
  return markers.some((m) => t.includes(m.toLowerCase()));
}

async function run() {
  const cases = [];

  const nameUser = `eval_name_${Date.now()}`;
  await chat(nameUser, 'my name is EvalName');
  const nameRecall = await chat(nameUser, 'what is my name?');
  cases.push({
    id: 'name_recall',
    pass: includesAny(nameRecall.data?.text || '', ['EvalName']),
    latencyMs: nameRecall.latencyMs,
    output: nameRecall.data?.text || ''
  });

  const goalUser = `eval_goal_${Date.now()}`;
  const goalOutputs = [];
  goalOutputs.push(await chat(goalUser, '你好'));
  goalOutputs.push(await chat(goalUser, '我想聊游戏'));
  goalOutputs.push(await chat(goalUser, '动作游戏'));
  goalOutputs.push(await chat(goalUser, '猫咪游戏'));
  goalOutputs.push(await chat(goalUser, '继续'));
  goalOutputs.push(await chat(goalUser, '再说一点'));
  const nudgePass = goalOutputs.some((x) =>
    includesAny(x.data?.text || '', ['要不要', 'can you', 'do you want', '?', '？'])
  );
  cases.push({
    id: 'goal_nudge',
    pass: nudgePass,
    latencyMs: Math.round(goalOutputs.reduce((s, x) => s + x.latencyMs, 0) / goalOutputs.length),
    output: goalOutputs.map((x) => x.data?.text || '')
  });

  const uncertaintyUser = `eval_unc_${Date.now()}`;
  const uncertainty = await chat(
    uncertaintyUser,
    '今天黄金价格美元汇率我只要一个大概区间快结论顺便告诉我波动方向'
  );
  const uncertaintyPass = includesAny(uncertainty.data?.text || '', ['可核验', 'time-sensitive', 'verifiable']);
  cases.push({
    id: 'honest_uncertainty',
    pass: uncertaintyPass,
    latencyMs: uncertainty.latencyMs,
    output: uncertainty.data?.text || ''
  });

  const shadowUser = `eval_shadow_${Date.now()}`;
  const shadow = await chat(shadowUser, 'today weather and gold price brief update');
  const shadowNeeded = !!shadow.data?.toolShadow?.needed;
  const shadowTools = shadow.data?.toolShadow?.tools || [];
  cases.push({
    id: 'tool_shadow',
    pass: shadowNeeded && shadowTools.length > 0,
    latencyMs: shadow.latencyMs,
    output: shadow.data?.toolShadow || null
  });

  const statsResp = await getJson(`${baseUrl}/api/intelligence/stats`);
  const statsData = statsResp.data?.data || {};
  const statsPass =
    !!statsData.routes &&
    !!statsData.viewerGraph &&
    !!statsData.goals &&
    !!statsData.uncertainty &&
    !!statsData.toolShadow;
  cases.push({
    id: 'stats_contract',
    pass: statsPass,
    latencyMs: 0,
    output: {
      routes: statsData.routes,
      viewerGraph: statsData.viewerGraph,
      goals: statsData.goals,
      uncertainty: statsData.uncertainty,
      toolShadow: statsData.toolShadow
    }
  });

  const passed = cases.filter((c) => c.pass).length;
  const summary = {
    passed,
    total: cases.length,
    score: Number((passed / Math.max(cases.length, 1)).toFixed(3))
  };

  const report = {
    version: 'intelligence-eval-v1',
    timestamp: new Date().toISOString(),
    baseUrl,
    summary,
    cases
  };

  const outDir = path.resolve(process.cwd(), 'data', 'eval');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `intelligence-eval-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(JSON.stringify({ summary, outPath }, null, 2));
}

run().catch((error) => {
  console.error('[eval] failed:', error?.message || error);
  process.exit(1);
});
