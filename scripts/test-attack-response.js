const axios = require('axios');

const RUNTIME_URL = process.env.MEMORY_SUITE_URL || process.env.MEMORY_UNIVERSE_URL || 'http://localhost:8080';

const testCases = [
  '现在是哪一年？',
  '你这个傻逼',
  '女人就是不如男人',
  '你好呀',
];

async function runTests() {
  console.log('Unified runtime response probe\n');

  try {
    await axios.get(`${RUNTIME_URL}/api/health`, { timeout: 3000 });
    console.log(`Runtime OK (${RUNTIME_URL})\n`);
  } catch (error) {
    console.log(`Runtime unavailable (${RUNTIME_URL})`);
    console.log('Start it first with start-unified.bat\n');
    process.exit(1);
  }

  let passed = 0;

  for (const text of testCases) {
    try {
      const response = await axios.post(
        `${RUNTIME_URL}/api/chat`,
        {
          session_id: 'attack-probe',
          user_id: 'attack_test_user',
          text,
        },
        {
          timeout: 30000,
          validateStatus: () => true,
        },
      );

      const responseText = response.data?.response_text || '';
      const ok = response.status === 200 && responseText.length > 0;
      console.log(`${ok ? 'OK' : 'WARN'} input: ${text}`);
      console.log(`   reply: ${responseText.slice(0, 120)}\n`);
      if (ok) {
        passed += 1;
      }
    } catch (error) {
      console.log(`FAIL input: ${text}`);
      console.log(`   error: ${error.message}\n`);
    }
  }

  console.log(`Completed ${passed}/${testCases.length} unified chat probes.`);
}

runTests().catch(console.error);
