/**
 * Memory Suite Smoke Test (Current Architecture)
 *
 * Validates the active services:
 * - Web Manager (8080)
 * - Memory Universe (4005)
 * - BrainNN (4007)
 * - TTS (4014)
 * - Live2D (4002)
 * - Local LLM (4008, optional)
 */

import path from 'path';
import dotenv from 'dotenv';
import { httpGet, httpPost } from '../shared/httpClient';

dotenv.config({ path: path.join(__dirname, '../.env') });

const WEB_MANAGER_URL = process.env.MANAGER_URL || 'http://localhost:8080';
const MEMORY_UNIVERSE_URL = process.env.MEMORY_UNIVERSE_URL || 'http://localhost:4005';
const BRAINNN_URL = process.env.BRAINNN_URL || 'http://localhost:4007';
const TTS_URL = process.env.TTS_SERVICE_URL || 'http://localhost:4014';
const LIVE2D_URL = process.env.LIVE2D_SERVICE_URL || 'http://localhost:4002';
const LOCAL_LLM_URL = process.env.LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:4008';

const USE_LOCAL_LLM = String(process.env.USE_LOCAL_LLM || '').toLowerCase() === 'true';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
  service?: string;
}

interface SmokeTestOptions {
  skipChat?: boolean;
  skipLocalLLM?: boolean;
  skipLegacy?: boolean;
  verbose?: boolean;
}

async function runTest(
  name: string,
  testFn: () => Promise<void>,
  service?: string
): Promise<TestResult> {
  const startTime = Date.now();
  try {
    await testFn();
    return {
      name,
      passed: true,
      duration: Date.now() - startTime,
      service
    };
  } catch (error: any) {
    return {
      name,
      passed: false,
      error: error?.message || String(error),
      duration: Date.now() - startTime,
      service
    };
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function testManagerHealth(): Promise<void> {
  const result = await httpGet(`${WEB_MANAGER_URL}/health`, { timeout: 8000 });
  assert(result.ok, `Manager health failed: ${result.error || result.status}`);
  assert(result.data && (result.data as any).status, 'Manager health response missing status');
}

async function testMemoryUniverseHealth(): Promise<void> {
  const result = await httpGet(`${MEMORY_UNIVERSE_URL}/health`, { timeout: 8000 });
  assert(result.ok, `Memory Universe health failed: ${result.error || result.status}`);
  assert((result.data as any)?.status === 'healthy', 'Memory Universe status not healthy');
}

async function testBrainNNHealth(): Promise<void> {
  const result = await httpGet(`${BRAINNN_URL}/health`, { timeout: 8000 });
  assert(result.ok, `BrainNN health failed: ${result.error || result.status}`);
  assert((result.data as any)?.status === 'healthy', 'BrainNN status not healthy');
}

async function testTTSHealth(): Promise<void> {
  const result = await httpGet(`${TTS_URL}/health`, { timeout: 8000 });
  assert(result.ok, `TTS health failed: ${result.error || result.status}`);
  const payload = result.data as any;
  const healthy = payload?.ok === true || payload?.status === 'ok' || payload?.status === 'healthy';
  assert(healthy, 'TTS health response missing ok/healthy status');
}

async function testLive2DHealth(): Promise<void> {
  const result = await httpGet(`${LIVE2D_URL}/health`, { timeout: 8000 });
  assert(result.ok, `Live2D health failed: ${result.error || result.status}`);
  assert((result.data as any)?.status === 'healthy', 'Live2D status not healthy');
}

async function testLocalLLMHealth(): Promise<void> {
  const result = await httpGet(`${LOCAL_LLM_URL}/health`, { timeout: 8000 });
  assert(result.ok, `Local LLM health failed: ${result.error || result.status}`);
}

async function isEndpointHealthy(url: string, timeout = 1500): Promise<boolean> {
  const result = await httpGet(url, { timeout });
  return result.ok;
}

async function testOrchestratedChat(): Promise<void> {
  const result = await httpPost(
    `${WEB_MANAGER_URL}/api/chat`,
    {
      message: 'smoke test message',
      userId: 'smoke_test_user'
    },
    { timeout: 45000 }
  );

  assert(result.ok, `Chat request failed: ${result.error || result.status}`);
  const text = (result.data as any)?.text || (result.data as any)?.response;
  assert(text, `Chat response missing text: ${JSON.stringify(result.data)}`);
}

async function main(options: SmokeTestOptions = {}) {
  console.log('Memory Suite Smoke Test (current architecture)\n');
  console.log('Service URLs:');
  console.log(`  Web Manager:     ${WEB_MANAGER_URL}`);
  console.log(`  Memory Universe: ${MEMORY_UNIVERSE_URL}`);
  console.log(`  BrainNN:         ${BRAINNN_URL}`);
  console.log(`  TTS:             ${TTS_URL}`);
  console.log(`  Live2D:          ${LIVE2D_URL}`);
  console.log(`  Local LLM:       ${LOCAL_LLM_URL}`);
  console.log('');

  const tests: TestResult[] = [];

  tests.push(await runTest('Web Manager health', testManagerHealth, 'WebManager'));
  tests.push(await runTest('Memory Universe health', testMemoryUniverseHealth, 'MemoryUniverse'));
  tests.push(await runTest('BrainNN health', testBrainNNHealth, 'BrainNN'));
  tests.push(await runTest('TTS health', testTTSHealth, 'TTS'));

  const canCheckLive2D = !options.skipLegacy && await isEndpointHealthy(`${LIVE2D_URL}/health`);
  if (canCheckLive2D) {
    tests.push(await runTest('Live2D health', testLive2DHealth, 'Live2D'));
  } else {
    console.log('[Smoke] Skipping Live2D health (service unavailable or legacy mode).');
  }

  const canCheckLocalLLM =
    !options.skipLegacy &&
    !options.skipLocalLLM &&
    USE_LOCAL_LLM &&
    await isEndpointHealthy(`${LOCAL_LLM_URL}/health`);

  if (canCheckLocalLLM) {
    tests.push(await runTest('Local LLM health', testLocalLLMHealth, 'LocalLLM'));
  } else if (!options.skipLegacy && !options.skipLocalLLM && USE_LOCAL_LLM) {
    console.log('[Smoke] Skipping Local LLM health (embedded local provider, no standalone /health endpoint).');
  }

  if (!options.skipChat) {
    tests.push(await runTest('Orchestrated chat', testOrchestratedChat, 'WebManager'));
  }

  console.log('Results');
  console.log('='.repeat(60));

  let passedCount = 0;
  let totalDuration = 0;
  const serviceGroups = new Map<string, TestResult[]>();

  tests.forEach(test => {
    const service = test.service || 'Other';
    if (!serviceGroups.has(service)) {
      serviceGroups.set(service, []);
    }
    serviceGroups.get(service)!.push(test);
  });

  serviceGroups.forEach((serviceTests, service) => {
    console.log(`\n[${service}]`);
    serviceTests.forEach(test => {
      const status = test.passed ? 'OK ' : 'FAIL';
      const duration = `${test.duration}ms`;
      console.log(`  ${status} ${test.name.padEnd(26)} ${duration.padStart(8)}`);
      if (test.error && options.verbose) {
        console.log(`     error: ${test.error}`);
      }
      if (test.passed) passedCount++;
      totalDuration += test.duration;
    });
  });

  const totalTests = tests.length;
  console.log('\n' + '='.repeat(60));
  console.log(`Total: ${passedCount}/${totalTests} passed, total time: ${totalDuration}ms\n`);

  process.exit(passedCount === totalTests ? 0 : 1);
}

function parseArgs(): SmokeTestOptions {
  const args = process.argv.slice(2);
  return {
    skipChat: args.includes('--skip-chat'),
    skipLegacy: args.includes('--skip-legacy'),
    skipLocalLLM: args.includes('--skip-local-llm'),
    verbose: args.includes('--verbose') || args.includes('-v')
  };
}

if (require.main === module) {
  const options = parseArgs();
  main(options).catch(error => {
    console.error('Smoke test failed:', error);
    process.exit(1);
  });
}

export { main as runSmokeTest, TestResult };
