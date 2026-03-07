const axios = require('axios');

async function testTts() {
  console.log('=== Unified TTS performance probe ===\n');

  const testTexts = [
    '你好，这是一次统一运行时语音测试。',
    '今天的系统状态看起来稳定。',
    '欢迎来到 Memory Suite unified runtime.',
  ];

  for (let i = 0; i < testTexts.length; i += 1) {
    const text = testTexts[i];
    const start = Date.now();

    try {
      const resp = await axios.post(
        'http://localhost:8080/api/tts/speak',
        {
          session_id: 'tts-test',
          text,
          voice: 'edge-tts-zh',
        },
        { timeout: 15000 },
      );

      const elapsed = Date.now() - start;
      console.log(`TTS ${i + 1}: ${elapsed}ms - status: ${resp.data?.status}`);
    } catch (error) {
      console.log(`TTS ${i + 1}: ${Date.now() - start}ms - failed: ${error.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log('\n=== End-to-end chat + TTS queue probe ===\n');

  const start = Date.now();
  try {
    const chatResp = await axios.post(
      'http://localhost:8080/api/chat',
      {
        session_id: 'tts-test',
        user_id: 'tts_test',
        text: '你好',
      },
      { timeout: 10000 },
    );

    const chatTime = Date.now() - start;
    const replyText = chatResp.data?.response_text || '';
    console.log(`Chat: ${chatTime}ms - ${replyText.slice(0, 30)}...`);

    const ttsStart = Date.now();
    const ttsResp = await axios.post(
      'http://localhost:8080/api/tts/speak',
      {
        session_id: 'tts-test',
        text: replyText,
        voice: 'edge-tts-zh',
      },
      { timeout: 15000 },
    );

    const ttsTime = Date.now() - ttsStart;
    const totalTime = Date.now() - start;
    console.log(`TTS queue: ${ttsTime}ms - status: ${ttsResp.data?.status}`);
    console.log(`Total elapsed: ${totalTime}ms`);
  } catch (error) {
    console.log(`Failed: ${error.message}`);
  }
}

testTts();
