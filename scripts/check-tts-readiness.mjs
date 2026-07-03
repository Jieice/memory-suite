function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function main() {
  const runtimeUrl = String(process.env.MEMORY_SUITE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const attempts = parsePositiveInt(process.argv[2] || process.env.PREFLIGHT_TTS_ATTEMPTS, 3);
  const minPass = parsePositiveInt(process.argv[3] || process.env.PREFLIGHT_TTS_MIN_PASS, 2);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  const response = await fetch(`${runtimeUrl}/api/live/preflight/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ attempts, minPass }),
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));

  const payload = await response.json().catch(() => ({}));
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  const failed = checks.filter((item) => item && item.ok === false);

  console.log(`[TTS-Preflight] runtime=${runtimeUrl} status=${response.status} success=${Boolean(payload.success)}`);
  for (const item of checks) {
    const status = item.ok ? 'READY' : 'FAIL';
    const detail = item.error ? ` (${item.error})` : '';
    console.log(`- ${item.name}: ${status}${detail}`);
  }
  if (Array.isArray(payload.attempts) && payload.attempts.length > 0) {
    for (const attempt of payload.attempts) {
      const warm = attempt.warmOk ? 'ok' : 'fail';
      const audio = attempt.audioReadable?.ok ? 'ok' : 'fail';
      const quality = attempt.qualityOk ? 'ok' : 'fail';
      const engine = attempt.engine || 'unknown';
      const duration = Number.isFinite(Number(attempt.duration)) ? `${Number(attempt.duration).toFixed(2)}s` : 'n/a';
      console.log(`  attempt #${attempt.index}: warm=${warm}, audio=${audio}, quality=${quality}, duration=${duration}, engine=${engine}, cached=${Boolean(attempt.cached)}`);
    }
  }

  if (response.status >= 300 || payload.success !== true || failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[TTS-Preflight] failed: ${error.message || error}`);
  process.exitCode = 1;
});
