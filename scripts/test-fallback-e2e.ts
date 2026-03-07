/**
 * Unified runtime end-to-end smoke test.
 */

import axios from 'axios';

const UNIFIED_RUNTIME_URL =
  process.env.MEMORY_SUITE_URL ||
  process.env.MEMORY_UNIVERSE_URL ||
  'http://localhost:8080';
const BRAINNN_URL = process.env.BRAINNN_URL || 'http://localhost:4007';
const TTS_URL = process.env.TTS_SERVICE_URL || 'http://localhost:3000';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

async function runTest(name: string, testFn: () => Promise<void>): Promise<void> {
  const startTime = Date.now();
  try {
    await testFn();
    results.push({ name, passed: true, duration: Date.now() - startTime });
    console.log(`PASS ${name} (${Date.now() - startTime}ms)`);
  } catch (error: any) {
    results.push({
      name,
      passed: false,
      error: error.message,
      duration: Date.now() - startTime
    });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

async function checkHealth(url: string, path = '/health'): Promise<boolean> {
  try {
    const response = await axios.get(`${url}${path}`, { timeout: 5000 });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function main() {
  console.log('Starting unified runtime end-to-end checks\n');

  const unifiedHealthy = await checkHealth(UNIFIED_RUNTIME_URL, '/api/health');
  const brainnnHealthy = await checkHealth(BRAINNN_URL);
  const ttsHealthy = await checkHealth(TTS_URL);

  console.log(`Unified runtime: ${unifiedHealthy ? 'up' : 'down'}`);
  console.log(`BrainNN sidecar: ${brainnnHealthy ? 'up' : 'optional/down'}`);
  console.log(`TTS sidecar: ${ttsHealthy ? 'up' : 'optional/down'}\n`);

  await runTest('Unified health endpoint', async () => {
    const response = await axios.get(`${UNIFIED_RUNTIME_URL}/api/health`);
    if (response.status !== 200) {
      throw new Error(`Status ${response.status}`);
    }
  });

  await runTest('Runtime overview endpoint', async () => {
    const response = await axios.get(`${UNIFIED_RUNTIME_URL}/api/runtime/overview`);
    if (response.status !== 200) {
      throw new Error(`Status ${response.status}`);
    }
  });

  await runTest('Chat endpoint returns text', async () => {
    const response = await axios.post(`${UNIFIED_RUNTIME_URL}/api/chat`, {
      session_id: 'fallback-e2e',
      user_id: 'test-user',
      text: 'Hello from unified fallback e2e'
    });

    if (response.status !== 200) {
      throw new Error(`Status ${response.status}`);
    }
    if (!response.data.response_text && !response.data.response && !response.data.text) {
      throw new Error('No response text in payload');
    }
  });

  await runTest('Live2D state endpoint', async () => {
    const response = await axios.get(`${UNIFIED_RUNTIME_URL}/api/live2d/state`);
    if (response.status !== 200) {
      throw new Error(`Status ${response.status}`);
    }
  });

  await runTest('Danmaku state endpoint', async () => {
    const response = await axios.get(`${UNIFIED_RUNTIME_URL}/api/danmaku/state`);
    if (response.status !== 200) {
      throw new Error(`Status ${response.status}`);
    }
  });

  await runTest('Chat handles rapid requests', async () => {
    const requests = Array.from({ length: 5 }, (_, index) =>
      axios.post(`${UNIFIED_RUNTIME_URL}/api/chat`, {
        session_id: 'fallback-e2e-burst',
        user_id: 'test-user',
        text: `Burst message ${index}`
      })
    );

    const responses = await Promise.all(requests);
    for (const response of responses) {
      if (response.status !== 200) {
        throw new Error(`Status ${response.status}`);
      }
    }
  });

  await runTest('TTS queue endpoint', async () => {
    const response = await axios.post(`${UNIFIED_RUNTIME_URL}/api/tts/speak`, {
      text: 'Unified TTS probe',
      voice: 'default',
      session_id: 'fallback-e2e-tts'
    });

    if (response.status !== 200 && response.status !== 202) {
      throw new Error(`Status ${response.status}`);
    }
  });

  console.log('\nUnified runtime fallback summary');
  console.log('='.repeat(50));
  const passed = results.filter(result => result.passed).length;
  const failed = results.length - passed;
  const totalTime = results.reduce((sum, result) => sum + result.duration, 0);
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total time: ${totalTime}ms`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const result of results.filter(item => !item.passed)) {
      console.log(`  - ${result.name}: ${result.error}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
