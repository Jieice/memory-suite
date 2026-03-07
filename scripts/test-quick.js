const axios = require('axios');

async function testMultiple() {
  console.log('=== Unified chat quick probe (5 requests) ===\n');

  for (let i = 1; i <= 5; i += 1) {
    const start = Date.now();
    try {
      const resp = await axios.post(
        'http://localhost:8080/api/chat',
        {
          session_id: 'perf-test',
          user_id: 'perf_test',
          text: `测试 ${i}`,
        },
        { timeout: 10000 },
      );
      const elapsed = Date.now() - start;
      const text = (resp.data?.response_text || '').slice(0, 30);
      console.log(`Request ${i}: ${elapsed}ms - ${text}...`);
    } catch (error) {
      console.log(`Request ${i}: ${Date.now() - start}ms - failed: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

testMultiple();
