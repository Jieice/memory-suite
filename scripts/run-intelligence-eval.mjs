import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const now = new Date();

function parseArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

const endpoint = parseArg('--endpoint', process.env.EVAL_CHAT_ENDPOINT || 'http://127.0.0.1:4005/api/chat');
const datasetPath = parseArg('--dataset', path.join(rootDir, 'eval', 'intelligence', 'dataset.v2.json'));
const outDir = parseArg('--out-dir', path.join(rootDir, 'reports', 'intelligence'));
const baselinePath = parseArg('--baseline', '');
const timeoutMs = Number.parseInt(parseArg('--timeout', process.env.EVAL_TIMEOUT_MS || '35000'), 10) || 35000;
const setupDelayMs = Number.parseInt(parseArg('--setup-delay-ms', '100'), 10) || 100;
const retryCount = Number.parseInt(parseArg('--retries', process.env.EVAL_RETRIES || '2'), 10) || 2;

const sloFastP95Ms = Number.parseInt(parseArg('--slo-fast-p95-ms', process.env.SLO_FAST_P95_MS || '1200'), 10) || 1200;
const sloFastP99Ms = Number.parseInt(parseArg('--slo-fast-p99-ms', process.env.SLO_FAST_P99_MS || '1800'), 10) || 1800;
const sloSlowP95Ms = Number.parseInt(parseArg('--slo-slow-p95-ms', process.env.SLO_SLOW_P95_MS || '12000'), 10) || 12000;
const sloSlowP99Ms = Number.parseInt(parseArg('--slo-slow-p99-ms', process.env.SLO_SLOW_P99_MS || '20000'), 10) || 20000;
const sloFallbackRateMax = Number.parseFloat(parseArg('--slo-fallback-rate-max', process.env.SLO_FALLBACK_RATE_MAX || '0.003')) || 0.003;

const FALLBACK_PHRASES = [
  '\u62b1\u6b49\uff0c\u6211\u521a\u521a\u6389\u7ebf\u4e86\uff0c\u8bf7\u518d\u8bf4\u4e00\u6b21\u3002',
  '\u8bf7\u544a\u8bc9\u6211\u7684\u521b\u9020\u8005\uff0c\u6211\u7684ai\u51fa\u73b0\u95ee\u9898\u4e86',
  'ai service temporarily unavailable'
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text || '');
}

function hasLatin(text) {
  return /[a-zA-Z]/.test(text || '');
}

function includesAny(text, list = []) {
  const source = String(text || '').toLowerCase();
  return list.some((item) => source.includes(String(item).toLowerCase()));
}

function includesAll(text, list = []) {
  const source = String(text || '').toLowerCase();
  return list.every((item) => source.includes(String(item).toLowerCase()));
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.min(sorted.length - 1, idx)];
}

async function callChat({ userId, userName, prompt }) {
  let last = null;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, userName, content: prompt }),
        signal: controller.signal
      });

      const elapsedMs = Date.now() - started;
      const json = await resp.json().catch(() => ({}));
      const result = { ok: resp.ok, status: resp.status, elapsedMs, data: json, attempt };
      if (result.ok) return result;
      last = result;
    } catch (error) {
      last = {
        ok: false,
        status: 0,
        elapsedMs: Date.now() - started,
        error: String(error?.message || error),
        data: {},
        attempt
      };
    } finally {
      clearTimeout(timer);
    }

    await sleep(200 * (attempt + 1));
  }

  return last || { ok: false, status: 0, elapsedMs: 0, data: {}, error: 'unknown' };
}

function deriveStatsEndpoint(chatEndpoint) {
  try {
    const u = new URL(chatEndpoint);
    u.pathname = '/api/intelligence/stats';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return 'http://127.0.0.1:4005/api/intelligence/stats';
  }
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'GET', signal: controller.signal });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message || error), data: {} };
  } finally {
    clearTimeout(timer);
  }
}

function safePickGenerationPolicy(statsEnvelope) {
  const payload = statsEnvelope?.data?.data || statsEnvelope?.data || {};
  return payload?.generationPolicy || null;
}

function compareGenerationPolicy(current, baseline) {
  if (!current || !baseline) return null;
  const keys = ['evaluated', 'dualCandidates', 'noveltyRewrites', 'alternativesAccepted', 'emojiTrimmed'];
  const delta = {};
  for (const k of keys) {
    const a = Number(current[k] || 0);
    const b = Number(baseline[k] || 0);
    delta[k] = a - b;
  }
  return delta;
}

function scoreCase(item, result) {
  const text = String(result?.data?.text || '');
  const route = result?.data?.metadata?.route || 'unknown';
  const expect = item.expect || {};

  const checks = [];
  let score = 100;

  const hasFallbackText = includesAny(text, FALLBACK_PHRASES);
  if (hasFallbackText) {
    checks.push({ name: 'fallback_not_used', pass: false, note: 'fallback text returned' });
    score -= 50;
  } else {
    checks.push({ name: 'fallback_not_used', pass: true });
  }

  if (expect.language === 'zh') {
    const pass = hasChinese(text);
    checks.push({ name: 'language_zh', pass });
    if (!pass) score -= 10;
  }
  if (expect.language === 'en') {
    const pass = hasLatin(text);
    checks.push({ name: 'language_en', pass });
    if (!pass) score -= 10;
  }

  if (Array.isArray(expect.forbiddenContains) && expect.forbiddenContains.length > 0) {
    const pass = !includesAny(text, expect.forbiddenContains);
    checks.push({ name: 'forbidden_contains', pass, note: pass ? '' : 'contains forbidden phrase' });
    if (!pass) score -= 15;
  }

  if (Array.isArray(expect.mustContainAny) && expect.mustContainAny.length > 0) {
    const pass = includesAny(text, expect.mustContainAny);
    checks.push({ name: 'must_contain_any', pass });
    if (!pass) score -= 20;
  }

  if (Array.isArray(expect.mustContainAll) && expect.mustContainAll.length > 0) {
    const pass = includesAll(text, expect.mustContainAll);
    checks.push({ name: 'must_contain_all', pass });
    if (!pass) score -= 20;
  }

  if (expect.route) {
    const pass = route === expect.route;
    checks.push({ name: 'route', pass, note: `expected=${expect.route}, got=${route}` });
    if (!pass) score -= 10;
  }

  if (expect.maxLatencyMs) {
    const pass = result.elapsedMs <= expect.maxLatencyMs;
    checks.push({ name: 'latency', pass, note: `${result.elapsedMs}ms <= ${expect.maxLatencyMs}ms` });
    if (!pass) {
      const overflow = result.elapsedMs - expect.maxLatencyMs;
      score -= clamp(Math.round(overflow / 500), 3, 20);
    }
  }

  if (!result.ok) {
    score -= 25;
    checks.push({ name: 'http_ok', pass: false, note: `status=${result.status}, error=${result.error || ''}` });
  } else {
    checks.push({ name: 'http_ok', pass: true, note: `status=${result.status}` });
  }

  return {
    id: item.id,
    prompt: item.prompt,
    route,
    elapsedMs: result.elapsedMs,
    text,
    score: clamp(score, 0, 100),
    checks,
    metadata: result?.data?.metadata || null
  };
}

function buildSummary(results) {
  const total = results.length;
  const passed = results.filter((x) => x.score >= 80).length;
  const avgScore = total > 0 ? results.reduce((a, b) => a + b.score, 0) / total : 0;

  const successful = results.filter((x) => x.checks.some((c) => c.name === 'http_ok' && c.pass));
  const latencies = successful.map((x) => x.elapsedMs).sort((a, b) => a - b);
  const fastLatencies = successful.filter((x) => x.route === 'fast').map((x) => x.elapsedMs).sort((a, b) => a - b);
  const slowLatencies = successful.filter((x) => x.route === 'slow').map((x) => x.elapsedMs).sort((a, b) => a - b);

  const routeFast = results.filter((x) => x.route === 'fast').length;
  const routeSlow = results.filter((x) => x.route === 'slow').length;

  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);
  const fastP95 = percentile(fastLatencies, 0.95);
  const fastP99 = percentile(fastLatencies, 0.99);
  const slowP95 = percentile(slowLatencies, 0.95);
  const slowP99 = percentile(slowLatencies, 0.99);

  const fallbackHits = results.filter((x) => includesAny(x.text, FALLBACK_PHRASES)).length;
  const fallbackRate = total > 0 ? fallbackHits / total : 0;

  const sloChecks = [
    { name: 'fast_p95', pass: routeFast === 0 ? true : fastP95 <= sloFastP95Ms, value: fastP95, threshold: sloFastP95Ms, op: '<=' },
    { name: 'fast_p99', pass: routeFast === 0 ? true : fastP99 <= sloFastP99Ms, value: fastP99, threshold: sloFastP99Ms, op: '<=' },
    { name: 'slow_p95', pass: routeSlow === 0 ? true : slowP95 <= sloSlowP95Ms, value: slowP95, threshold: sloSlowP95Ms, op: '<=' },
    { name: 'slow_p99', pass: routeSlow === 0 ? true : slowP99 <= sloSlowP99Ms, value: slowP99, threshold: sloSlowP99Ms, op: '<=' },
    { name: 'fallback_rate', pass: fallbackRate <= sloFallbackRateMax, value: Number(fallbackRate.toFixed(6)), threshold: sloFallbackRateMax, op: '<=' }
  ];

  return {
    total,
    passed,
    passRate: total > 0 ? Number((passed / total).toFixed(4)) : 0,
    avgScore: Number(avgScore.toFixed(2)),
    p95LatencyMs: p95,
    p99LatencyMs: p99,
    fastP95LatencyMs: fastP95,
    fastP99LatencyMs: fastP99,
    slowP95LatencyMs: slowP95,
    slowP99LatencyMs: slowP99,
    route: { fast: routeFast, slow: routeSlow, other: total - routeFast - routeSlow },
    fallbackHits,
    fallbackRate: Number(fallbackRate.toFixed(6)),
    slo: {
      version: 'v2',
      verdict: sloChecks.every((x) => x.pass) ? 'pass' : 'fail',
      checks: sloChecks
    }
  };
}

function renderMarkdown(summary, results, cfg, stats) {
  const lines = [];
  lines.push('# Intelligence Eval Report');
  lines.push('');
  lines.push(`- Time: ${now.toISOString()}`);
  lines.push(`- Endpoint: ${cfg.endpoint}`);
  lines.push(`- Dataset: ${cfg.datasetPath}`);
  lines.push(`- Total: ${summary.total}`);
  lines.push(`- Passed (score>=80): ${summary.passed} (${(summary.passRate * 100).toFixed(1)}%)`);
  lines.push(`- Avg score: ${summary.avgScore}`);
  lines.push(`- P95 latency: ${summary.p95LatencyMs} ms`);
  lines.push(`- P99 latency: ${summary.p99LatencyMs} ms`);
  lines.push(`- Fast P95 latency: ${summary.fastP95LatencyMs} ms`);
  lines.push(`- Fast P99 latency: ${summary.fastP99LatencyMs} ms`);
  lines.push(`- Slow P95 latency: ${summary.slowP95LatencyMs} ms`);
  lines.push(`- Slow P99 latency: ${summary.slowP99LatencyMs} ms`);
  lines.push(`- Route count: fast=${summary.route.fast}, slow=${summary.route.slow}, other=${summary.route.other}`);
  lines.push(`- Fallback hits: ${summary.fallbackHits} (${(summary.fallbackRate * 100).toFixed(2)}%)`);
  if (stats?.generationPolicy) {
    lines.push(`- Policy evaluated: ${stats.generationPolicy.evaluated}`);
    lines.push(`- Policy novelty rewrites: ${stats.generationPolicy.noveltyRewrites}`);
    lines.push(`- Policy dual candidates: ${stats.generationPolicy.dualCandidates}`);
    lines.push(`- Policy accepted alternatives: ${stats.generationPolicy.alternativesAccepted}`);
    lines.push(`- Policy emoji trimmed: ${stats.generationPolicy.emojiTrimmed}`);
  } else {
    lines.push('- Policy metrics: missing `generationPolicy` in /api/intelligence/stats');
  }
  lines.push('');
  if (stats?.generationPolicyDelta) {
    lines.push('## Policy Delta (vs baseline)');
    lines.push('');
    for (const [k, v] of Object.entries(stats.generationPolicyDelta)) {
      const sign = v > 0 ? '+' : '';
      lines.push(`- ${k}: ${sign}${v}`);
    }
    lines.push('');
  }
  lines.push('## Intelligence Stats Snapshot');
  lines.push('');
  lines.push(`- Stats endpoint: ${stats?.statsEndpoint || 'unknown'}`);
  lines.push(`- Stats fetch ok: ${stats?.statsFetchOk ? 'yes' : 'no'}`);
  if (stats?.statsFetchError) {
    lines.push(`- Stats error: ${stats.statsFetchError}`);
  }
  lines.push('');
  lines.push('## SLO v2');
  lines.push('');
  lines.push(`- Verdict: ${String(summary.slo?.verdict || 'unknown').toUpperCase()}`);
  for (const check of (summary.slo?.checks || [])) {
    const tag = check.pass ? 'PASS' : 'FAIL';
    lines.push(`- [${tag}] ${check.name}: ${check.value} ${check.op} ${check.threshold}`);
  }
  lines.push('');
  lines.push('## Case Results');
  lines.push('');
  lines.push('| id | score | latency(ms) | route | text_preview |');
  lines.push('|---|---:|---:|---|---|');
  for (const r of results) {
    const preview = (r.text || '').replace(/\s+/g, ' ').slice(0, 70).replace(/\|/g, '\\|');
    lines.push(`| ${r.id} | ${r.score} | ${r.elapsedMs} | ${r.route} | ${preview} |`);
  }
  lines.push('');
  lines.push('## Failed Checks');
  lines.push('');
  let hasFail = false;
  for (const r of results) {
    const fails = r.checks.filter((c) => !c.pass);
    if (fails.length === 0) continue;
    hasFail = true;
    lines.push(`### ${r.id}`);
    for (const f of fails) {
      lines.push(`- ${f.name}: ${f.note || 'failed'}`);
    }
    lines.push('');
  }
  if (!hasFail) lines.push('All checks passed.');
  return lines.join('\n');
}

async function main() {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  const statsEndpoint = deriveStatsEndpoint(endpoint);

  const statsBeforeResp = await getJson(statsEndpoint);
  const statsBeforeGenerationPolicy = safePickGenerationPolicy(statsBeforeResp);

  await callChat({
    userId: 'eval_warmup',
    userName: 'warmup',
    prompt: '\u4f60\u597d'
  });
  await sleep(300);

  const results = [];
  for (const item of dataset) {
    if (Array.isArray(item.setup)) {
      for (const warmupText of item.setup) {
        await callChat({
          userId: item.userId || `eval_${item.id}`,
          userName: item.userName || 'eval_user',
          prompt: warmupText
        });
        await sleep(setupDelayMs);
      }
    }

    const result = await callChat({
      userId: item.userId || `eval_${item.id}`,
      userName: item.userName || 'eval_user',
      prompt: item.prompt
    });

    results.push(scoreCase(item, result));
  }

  const summary = buildSummary(results);
  const statsAfterResp = await getJson(statsEndpoint);
  const statsAfterGenerationPolicy = safePickGenerationPolicy(statsAfterResp);

  let baselineGenerationPolicy = null;
  if (baselinePath) {
    try {
      const baselineRaw = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      baselineGenerationPolicy =
        baselineRaw?.stats?.after?.generationPolicy ||
        baselineRaw?.stats?.generationPolicy ||
        baselineRaw?.generationPolicy ||
        null;
    } catch (error) {
      console.warn('[Eval] failed to load baseline:', String(error?.message || error));
    }
  }

  const generationPolicyDelta = compareGenerationPolicy(statsAfterGenerationPolicy, baselineGenerationPolicy);

  const statsSnapshot = {
    statsEndpoint,
    statsFetchOk: Boolean(statsAfterResp?.ok),
    statsFetchError: statsAfterResp?.ok ? '' : (statsAfterResp?.error || `status=${statsAfterResp?.status || 0}`),
    before: {
      generationPolicy: statsBeforeGenerationPolicy
    },
    after: {
      generationPolicy: statsAfterGenerationPolicy
    },
    baselinePath: baselinePath || null,
    generationPolicyDelta
  };

  const report = {
    generatedAt: now.toISOString(),
    endpoint,
    datasetPath,
    summary,
    stats: statsSnapshot,
    results
  };

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `intelligence-eval-${stamp}.json`);
  const mdPath = path.join(outDir, `intelligence-eval-${stamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(summary, results, { endpoint, datasetPath }, {
    statsEndpoint,
    statsFetchOk: statsSnapshot.statsFetchOk,
    statsFetchError: statsSnapshot.statsFetchError,
    generationPolicy: statsAfterGenerationPolicy,
    generationPolicyDelta
  }), 'utf8');

  console.log('[Eval] done');
  console.log(`[Eval] json: ${jsonPath}`);
  console.log(`[Eval] markdown: ${mdPath}`);
  console.log('[Eval] summary:', JSON.stringify(summary));
}

main().catch((error) => {
  console.error('[Eval] failed:', error);
  process.exit(1);
});
