const axios = require('axios');

const RUNTIME_URL = process.env.MEMORY_SUITE_URL || 'http://localhost:8080';
const TEST_PROMPT = '请用一句话回复这次 unified runtime latency probe。';

async function testUnifiedChat() {
  console.log('\n=== Unified runtime /api/chat ===');
  const start = Date.now();

  try {
    const response = await axios.post(
      `${RUNTIME_URL}/api/chat`,
      {
        session_id: 'latency-diagnose',
        user_id: 'test_user',
        text: TEST_PROMPT,
      },
      {
        timeout: 30000,
      },
    );

    const elapsed = Date.now() - start;
    const text = response.data?.response_text || '';
    console.log(`OK unified chat: ${elapsed}ms`);
    console.log(`   response length: ${text.length}`);
    console.log(`   preview: ${text.slice(0, 80)}...`);
    return { success: true, elapsed, text };
  } catch (error) {
    const elapsed = Date.now() - start;
    console.log(`FAIL unified chat: ${elapsed}ms`);
    console.log(`   error: ${error.message}`);
    return { success: false, elapsed, error: error.message };
  }
}

async function testRuntimeOverview() {
  console.log('\n=== Unified runtime overview ===');
  const start = Date.now();

  try {
    const response = await axios.get(`${RUNTIME_URL}/api/runtime/overview`, {
      timeout: 5000,
    });
    const elapsed = Date.now() - start;
    console.log(`OK runtime overview: ${elapsed}ms`);
    console.log(`   payload: ${JSON.stringify(response.data)}`);
    return { success: true, elapsed };
  } catch (error) {
    const elapsed = Date.now() - start;
    console.log(`FAIL runtime overview: ${elapsed}ms`);
    console.log(`   error: ${error.message}`);
    return { success: false, elapsed, error: error.message };
  }
}

async function run() {
  console.log('========================================');
  console.log('Unified runtime latency diagnosis');
  console.log('========================================');

  await testRuntimeOverview();
  await testUnifiedChat();

  console.log('\n========================================');
  console.log('Diagnosis complete');
  console.log('========================================');
}

run().catch(console.error);
