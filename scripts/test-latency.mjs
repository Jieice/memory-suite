/**
 * Memory Suite unified runtime latency probe.
 *
 * Usage:
 *   node scripts/test-latency.mjs
 */

const BASE_URL = process.env.MEMORY_SUITE_URL || 'http://localhost:8080';
const ITERATIONS = Number.parseInt(process.env.ITERATIONS || '5', 10);

const tests = [
  { name: 'Health Check', endpoint: '/api/health', method: 'GET', category: 'core' },
  { name: 'Runtime Overview', endpoint: '/api/runtime/overview', method: 'GET', category: 'core' },
  { name: 'Live2D State', endpoint: '/api/live2d/state', method: 'GET', category: 'overlay' },
  { name: 'Danmaku State', endpoint: '/api/danmaku/state', method: 'GET', category: 'gateway' },
  { name: 'Overlay Live2D', endpoint: '/overlay/live2d', method: 'GET', category: 'overlay' },
  { name: 'Overlay Danmaku', endpoint: '/overlay/danmaku', method: 'GET', category: 'overlay' },
  {
    name: 'Chat Roundtrip',
    endpoint: '/api/chat',
    method: 'POST',
    category: 'core',
    body: { text: 'latency probe', user_id: 'latency_probe_user' },
  },
];

const thresholds = {
  fast: 100,
  normal: 500,
  slow: 2000,
  verySlow: 5000,
};

function getStatus(avg) {
  if (avg < 0) return 'FAILED';
  if (avg < thresholds.fast) return 'FAST';
  if (avg < thresholds.normal) return 'OK';
  if (avg < thresholds.slow) return 'SLOW';
  if (avg < thresholds.verySlow) return 'VERY_SLOW';
  return 'CRITICAL';
}

async function measureLatency(test) {
  const times = [];
  let lastError = null;

  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now();
    try {
      const response = await fetch(`${BASE_URL}${test.endpoint}`, {
        method: test.method,
        headers: { 'Content-Type': 'application/json' },
        body: test.body ? JSON.stringify(test.body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      const end = performance.now();
      if (response.ok) {
        times.push(end - start);
      } else {
        lastError = `HTTP ${response.status}`;
        times.push(-1);
      }
    } catch (error) {
      lastError = error.message;
      times.push(-1);
    }

    if (i < ITERATIONS - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const valid = times.filter((value) => value >= 0).sort((a, b) => a - b);
  if (valid.length === 0) {
    return {
      name: test.name,
      category: test.category,
      status: 'FAILED',
      avg: -1,
      min: -1,
      max: -1,
      p95: -1,
      successRate: 0,
      error: lastError,
    };
  }

  const avg = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  return {
    name: test.name,
    category: test.category,
    status: getStatus(avg),
    avg,
    min: valid[0],
    max: valid[valid.length - 1],
    p95: valid[Math.min(valid.length - 1, Math.floor(valid.length * 0.95))],
    successRate: valid.length / ITERATIONS,
    error: lastError,
  };
}

async function ensureRuntimeUp() {
  const response = await fetch(`${BASE_URL}/api/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    throw new Error(`health probe failed: HTTP ${response.status}`);
  }
}

async function main() {
  console.log(`Memory Suite unified latency probe`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log(`Started: ${new Date().toLocaleString('zh-CN')}\n`);

  try {
    await ensureRuntimeUp();
  } catch (error) {
    console.error(`Unified runtime is not reachable: ${error.message}`);
    console.error(`Start it with start-electron.bat or cargo run -p daemon`);
    process.exit(1);
  }

  const results = [];
  for (const test of tests) {
    process.stdout.write(`Testing ${test.name.padEnd(18)} ... `);
    const result = await measureLatency(test);
    results.push(result);
    if (result.status === 'FAILED') {
      console.log(`FAILED (${result.error || 'unknown error'})`);
    } else {
      console.log(`${result.avg.toFixed(0)}ms [${result.status}]`);
    }
  }

  console.log('\nSummary');
  console.log('='.repeat(72));
  for (const result of results) {
    const avg = result.avg < 0 ? 'failed'.padStart(8) : `${result.avg.toFixed(0)}ms`.padStart(8);
    const p95 = result.p95 < 0 ? '-'.padStart(8) : `${result.p95.toFixed(0)}ms`.padStart(8);
    console.log(
      `${result.category.padEnd(8)} ${result.name.padEnd(18)} ${avg} ${p95} ${result.status.padEnd(10)} ${Math.round(result.successRate * 100)}%`,
    );
  }

  const failures = results.filter((result) => result.status === 'FAILED');
  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
