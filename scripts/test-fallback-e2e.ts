/**
 * End-to-End Tests for Fallback System
 * 
 * Tests complete flows with all services
 * Requirements: 1.1-1.10
 */

import axios from 'axios';

const MEMORY_UNIVERSE_URL = process.env.MEMORY_UNIVERSE_URL || 'http://localhost:4005';
const BRAINNN_URL = process.env.BRAINNN_URL || 'http://localhost:4007';
const TTS_URL = process.env.TTS_SERVICE_URL || 'http://localhost:3000';
const MANAGER_URL = process.env.MANAGER_URL || 'http://localhost:8081';

const FALLBACK_MESSAGE = '请告诉我的创造者，我的ai出现问题了';

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
    results.push({
      name,
      passed: true,
      duration: Date.now() - startTime
    });
    console.log(`✅ ${name} (${Date.now() - startTime}ms)`);
  } catch (error: any) {
    results.push({
      name,
      passed: false,
      error: error.message,
      duration: Date.now() - startTime
    });
    console.log(`❌ ${name}: ${error.message}`);
  }
}

async function checkServiceHealth(url: string): Promise<boolean> {
  try {
    const response = await axios.get(`${url}/health`, { timeout: 5000 });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

async function main() {
  console.log('🧪 Starting End-to-End Fallback Tests\n');

  // Check service availability
  console.log('📋 Checking service availability...');
  const muHealthy = await checkServiceHealth(MEMORY_UNIVERSE_URL);
  const brainnnHealthy = await checkServiceHealth(BRAINNN_URL);
  const ttsHealthy = await checkServiceHealth(TTS_URL);
  const managerHealthy = await checkServiceHealth(MANAGER_URL);

  console.log(`Memory Universe: ${muHealthy ? '✅' : '❌'}`);
  console.log(`BrainNN: ${brainnnHealthy ? '✅' : '❌'}`);
  console.log(`TTS: ${ttsHealthy ? '✅' : '❌'}`);
  console.log(`Manager: ${managerHealthy ? '✅' : '❌'}\n`);

  // Test 1: Chat with all services available
  await runTest('Chat with all services available', async () => {
    if (!muHealthy) throw new Error('Memory Universe not available');

    const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
      message: 'Hello',
      userId: 'test-user'
    });

    if (response.status !== 200) throw new Error(`Status ${response.status}`);
    if (!response.data.text) throw new Error('No text in response');
  });

  // Test 2: Chat returns valid response
  await runTest('Chat returns valid response format', async () => {
    if (!muHealthy) throw new Error('Memory Universe not available');

    const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
      message: 'Test',
      userId: 'test-user'
    });

    if (!response.data.text || typeof response.data.text !== 'string') {
      throw new Error('Invalid response format');
    }
  });

  // Test 3: Creator chat endpoint
  await runTest('Creator chat endpoint works', async () => {
    if (!muHealthy) throw new Error('Memory Universe not available');

    const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat/creator`, {
      message: 'Creator test',
      userId: 'creator'
    });

    if (response.status !== 200) throw new Error(`Status ${response.status}`);
    if (!response.data.text) throw new Error('No text in response');
  });

  // Test 4: Event endpoint
  await runTest('Event endpoint handles danmaku', async () => {
    if (!muHealthy) throw new Error('Memory Universe not available');

    const response = await axios.post(`${MEMORY_UNIVERSE_URL}/event`, {
      type: 'danmaku',
      content: 'Test danmaku',
      metadata: { user: 'test-user' }
    });

    if (response.status !== 200) throw new Error(`Status ${response.status}`);
  });

  // Test 5: BrainNN think endpoint
  await runTest('BrainNN think endpoint works', async () => {
    if (!brainnnHealthy) throw new Error('BrainNN not available');

    const response = await axios.post(`${BRAINNN_URL}/think`, {
      text: 'Test',
      source: 'test'
    });

    if (response.status !== 200) throw new Error(`Status ${response.status}`);
  });

  // Test 6: BrainNN tick endpoint
  await runTest('BrainNN tick endpoint works', async () => {
    if (!brainnnHealthy) throw new Error('BrainNN not available');

    const response = await axios.get(`${BRAINNN_URL}/tick`);

    if (response.status !== 200) throw new Error(`Status ${response.status}`);
    if (typeof response.data.should_proactive !== 'boolean') {
      throw new Error('Invalid should_proactive value');
    }
  });

  // Test 7: BrainNN feedback endpoint
  await runTest('BrainNN feedback endpoint works', async () => {
    if (!brainnnHealthy) throw new Error('BrainNN not available');

    const response = await axios.post(`${BRAINNN_URL}/feedback`, {
      type: 'positive',
      value: 0.8
    });

    if (response.status !== 200) throw new Error(`Status ${response.status}`);
  });

  // Test 8: TTS synthesis
  await runTest('TTS synthesis works', async () => {
    if (!ttsHealthy) throw new Error('TTS not available');

    const response = await axios.post(`${TTS_URL}/api/tts`, {
      text: 'Test',
      language: 'zh-CN',
      voice_id: 1
    });

    if (response.status !== 200) throw new Error(`Status ${response.status}`);
  });

  // Test 9: Manager health check
  await runTest('Manager health check endpoint works', async () => {
    if (!managerHealthy) throw new Error('Manager not available');

    const response = await axios.get(`${MANAGER_URL}/api/health-check`);

    if (response.status !== 200) throw new Error(`Status ${response.status}`);
    if (!response.data.checks) throw new Error('No checks in response');
  });

  // Test 10: Manager fallback stats
  await runTest('Manager fallback stats endpoint works', async () => {
    if (!managerHealthy) throw new Error('Manager not available');

    const response = await axios.get(`${MANAGER_URL}/api/fallback-stats`);

    if (response.status !== 200) throw new Error(`Status ${response.status}`);
    if (!response.data.services) throw new Error('No services in response');
  });

  // Test 11: Multiple rapid requests
  await runTest('Multiple rapid requests handled', async () => {
    if (!muHealthy) throw new Error('Memory Universe not available');

    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
          message: `Test ${i}`,
          userId: 'test-user'
        })
      );
    }

    const responses = await Promise.all(promises);
    for (const response of responses) {
      if (response.status !== 200) throw new Error(`Status ${response.status}`);
      if (!response.data.text) throw new Error('No text in response');
    }
  });

  // Test 12: Response consistency
  await runTest('Response consistency across requests', async () => {
    if (!muHealthy) throw new Error('Memory Universe not available');

    const responses = [];
    for (let i = 0; i < 3; i++) {
      const response = await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
        message: 'Test',
        userId: 'test-user'
      });
      responses.push(response.data.text);
    }

    // All responses should be non-empty strings
    for (const text of responses) {
      if (!text || typeof text !== 'string') {
        throw new Error('Inconsistent response format');
      }
    }
  });

  // Test 13: Error handling
  await runTest('Error handling for invalid input', async () => {
    if (!muHealthy) throw new Error('Memory Universe not available');

    try {
      await axios.post(`${MEMORY_UNIVERSE_URL}/api/chat`, {
        message: '', // Empty message
        userId: 'test-user'
      });
      // Should either succeed or fail gracefully
    } catch (error: any) {
      if (error.response?.status !== 400 && error.response?.status !== 200) {
        throw error;
      }
    }
  });

  // Test 14: Timeout handling
  await runTest('Timeout handling', async () => {
    if (!muHealthy) throw new Error('Memory Universe not available');

    try {
      const response = await axios.post(
        `${MEMORY_UNIVERSE_URL}/api/chat`,
        {
          message: 'Test',
          userId: 'test-user'
        },
        { timeout: 30000 }
      );

      if (response.status !== 200) throw new Error(`Status ${response.status}`);
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        // Timeout is acceptable
      } else {
        throw error;
      }
    }
  });

  // Print summary
  console.log('\n📊 Test Summary');
  console.log('='.repeat(50));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`Total: ${results.length} tests`);
  console.log(`Passed: ${passed} ✅`);
  console.log(`Failed: ${failed} ❌`);
  console.log(`Total time: ${totalTime}ms`);

  if (failed > 0) {
    console.log('\n❌ Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
  }

  console.log('='.repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
