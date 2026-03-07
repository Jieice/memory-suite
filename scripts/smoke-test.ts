/**
 * Memory Suite Smoke Test (Unified Runtime)
 *
 * Validates the active unified daemon surface:
 * - health
 * - runtime overview
 * - live2d state
 * - danmaku state
 * - orchestrated chat
 */

import path from 'path';
import dotenv from 'dotenv';
import { httpGet, httpPost } from '../shared/httpClient';

dotenv.config({ path: path.join(__dirname, '../.env') });

const RUNTIME_URL = process.env.MEMORY_SUITE_URL || 'http://localhost:8080';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface SmokeTestOptions {
  skipChat?: boolean;
  verbose?: boolean;
}

async function runTest(name: string, testFn: () => Promise<void>): Promise<TestResult> {
  const startTime = Date.now();
  try {
    await testFn();
    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (error: any) {
    return {
      name,
      passed: false,
      error: error?.message || String(error),
      duration: Date.now() - startTime,
    };
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function testRuntimeHealth(): Promise<void> {
  const result = await httpGet(`${RUNTIME_URL}/api/health`, { timeout: 8000 });
  assert(result.ok, `Runtime health failed: ${result.error || result.status}`);
  const payload = result.data as any;
  assert(payload?.status === 'ok', 'Runtime health response missing ok status');
  assert(payload?.runtime_mode === 'rust_single_process', 'Runtime mode is not unified Rust');
}

async function testRuntimeOverview(): Promise<void> {
  const result = await httpGet(`${RUNTIME_URL}/api/runtime/overview`, { timeout: 8000 });
  assert(result.ok, `Runtime overview failed: ${result.error || result.status}`);
  const payload = result.data as any;
  assert(payload?.db_ready === true, 'Runtime overview did not report db_ready=true');
}

async function testLive2dState(): Promise<void> {
  const result = await httpGet(`${RUNTIME_URL}/api/live2d/state`, { timeout: 8000 });
  assert(result.ok, `Live2D state failed: ${result.error || result.status}`);
  const payload = result.data as any;
  assert(typeof payload?.subtitle === 'string', 'Live2D subtitle missing');
  assert(typeof payload?.emotion === 'string', 'Live2D emotion missing');
}

async function testDanmakuState(): Promise<void> {
  const result = await httpGet(`${RUNTIME_URL}/api/danmaku/state`, { timeout: 8000 });
  assert(result.ok, `Danmaku state failed: ${result.error || result.status}`);
  const payload = result.data as any;
  assert(typeof payload?.status === 'string', 'Danmaku status missing');
  assert(typeof payload?.attempt_count === 'number', 'Danmaku attempt_count missing');
}

async function testOrchestratedChat(): Promise<void> {
  const result = await httpPost(
    `${RUNTIME_URL}/api/chat`,
    {
      text: 'smoke test message',
      user_id: 'smoke_test_user',
    },
    { timeout: 45000 },
  );

  assert(result.ok, `Chat request failed: ${result.error || result.status}`);
  const payload = result.data as any;
  assert(payload?.session_id, 'Chat response missing session_id');
  assert(payload?.response_text, 'Chat response missing response_text');
}

async function main(options: SmokeTestOptions = {}) {
  console.log('Memory Suite Smoke Test (unified runtime)\n');
  console.log(`Runtime URL: ${RUNTIME_URL}\n`);

  const tests: TestResult[] = [];
  tests.push(await runTest('Runtime health', testRuntimeHealth));
  tests.push(await runTest('Runtime overview', testRuntimeOverview));
  tests.push(await runTest('Live2D state', testLive2dState));
  tests.push(await runTest('Danmaku state', testDanmakuState));

  if (!options.skipChat) {
    tests.push(await runTest('Orchestrated chat', testOrchestratedChat));
  }

  console.log('Results');
  console.log('='.repeat(60));

  let passedCount = 0;
  let totalDuration = 0;
  tests.forEach((test) => {
    const status = test.passed ? 'OK ' : 'FAIL';
    const duration = `${test.duration}ms`;
    console.log(`  ${status} ${test.name.padEnd(26)} ${duration.padStart(8)}`);
    if (test.error && options.verbose) {
      console.log(`     error: ${test.error}`);
    }
    if (test.passed) passedCount += 1;
    totalDuration += test.duration;
  });

  console.log('\n' + '='.repeat(60));
  console.log(`Total: ${passedCount}/${tests.length} passed, total time: ${totalDuration}ms\n`);

  process.exit(passedCount === tests.length ? 0 : 1);
}

function parseArgs(): SmokeTestOptions {
  const args = process.argv.slice(2);
  return {
    skipChat: args.includes('--skip-chat'),
    verbose: args.includes('--verbose') || args.includes('-v'),
  };
}

if (require.main === module) {
  const options = parseArgs();
  main(options).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
