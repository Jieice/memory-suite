const axios = require('axios');

const RUNTIME_URL = 'http://localhost:8080';
const TTS_URL = 'http://localhost:8080';

async function checkRuntime() {
  console.log('\n=== Unified runtime health ===');
  const start = Date.now();
  try {
    const [health, overview] = await Promise.all([
      axios.get(`${RUNTIME_URL}/api/health`, { timeout: 2000 }),
      axios.get(`${RUNTIME_URL}/api/runtime/overview`, { timeout: 2000 }),
    ]);
    console.log(`Health: ${Date.now() - start}ms`);
    console.log(`Status: ${JSON.stringify(health.data)}`);
    console.log(`Overview: ${JSON.stringify(overview.data)}`);
  } catch (error) {
    console.log(`Runtime health failed: ${Date.now() - start}ms - ${error.message}`);
  }
}

async function testChat() {
  console.log('\n=== Unified chat path ===');
  const start = Date.now();
  try {
    const resp = await axios.post(
      `${RUNTIME_URL}/api/chat`,
      {
        session_id: 'analysis-flow',
        user_id: 'test-user',
        text: 'Run a chat timing probe for the unified runtime.',
      },
      { timeout: 15000 },
    );
    console.log(`Chat: ${Date.now() - start}ms`);
    console.log(`Reply: ${(resp.data?.assistant_text || '').slice(0, 120)}`);
  } catch (error) {
    console.log(`Chat failed: ${Date.now() - start}ms - ${error.message}`);
  }
}

async function testTts() {
  console.log('\n=== Unified TTS dispatch ===');
  const start = Date.now();
  try {
    const resp = await axios.post(
      `${TTS_URL}/api/tts/speak`,
      {
        session_id: 'analysis-flow',
        text: 'This is a unified TTS queue probe.',
        voice: 'edge-tts-en',
      },
      { timeout: 15000 },
    );
    console.log(`TTS queued: ${Date.now() - start}ms`);
    console.log(`Response: ${JSON.stringify(resp.data)}`);
  } catch (error) {
    console.log(`TTS failed: ${Date.now() - start}ms - ${error.message}`);
  }
}

async function testOverlayState() {
  console.log('\n=== Overlay state surfaces ===');
  const start = Date.now();
  try {
    const [live2d, danmaku] = await Promise.all([
      axios.get(`${RUNTIME_URL}/api/live2d/state`, { timeout: 2000 }),
      axios.get(`${RUNTIME_URL}/api/danmaku/state`, { timeout: 2000 }),
    ]);
    console.log(`Overlay reads: ${Date.now() - start}ms`);
    console.log(`Live2D: ${JSON.stringify(live2d.data)}`);
    console.log(`Danmaku: ${JSON.stringify(danmaku.data)}`);
  } catch (error) {
    console.log(`Overlay reads failed: ${Date.now() - start}ms - ${error.message}`);
  }
}

async function analyzeChatFlow() {
  console.log('========================================');
  console.log('Memory Suite unified runtime analysis');
  console.log('========================================');

  await checkRuntime();
  await testChat();
  await testTts();
  await testOverlayState();

  console.log('\n========================================');
  console.log('Analysis complete');
  console.log('========================================');
}

analyzeChatFlow().catch(console.error);
