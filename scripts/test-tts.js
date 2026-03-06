const axios = require('axios');

async function testTTS() {
    console.log('=== TTS 性能测试 ===\n');
    
    const testTexts = [
        '你好，这是一段测试文本。',
        '今天天气真不错呢。',
        '欢迎大家来到直播间！'
    ];
    
    for (let i = 0; i < testTexts.length; i++) {
        const text = testTexts[i];
        const start = Date.now();
        
        try {
            const resp = await axios.post('http://localhost:4014/api/tts', {
                text,
                userId: 'test'
            }, { timeout: 30000 });
            
            const elapsed = Date.now() - start;
            const audioLen = resp.data?.audioLength || resp.data?.duration || 'N/A';
            console.log(`TTS ${i+1}: ${elapsed}ms - 音频长度: ${audioLen}`);
        } catch (e) {
            console.log(`TTS ${i+1}: ${Date.now() - start}ms - 失败: ${e.message}`);
        }
        
        await new Promise(r => setTimeout(r, 100));
    }
    
    // 测试完整链路：Chat + TTS
    console.log('\n=== 完整链路测试 (Chat + TTS) ===\n');
    
    const start = Date.now();
    try {
        const chatResp = await axios.post('http://localhost:4005/api/chat', {
            userId: 'tts_test',
            text: '你好',
            source: 'test'
        }, { timeout: 10000 });
        
        const chatTime = Date.now() - start;
        const replyText = chatResp.data?.text || chatResp.data?.reply || '';
        console.log(`Chat: ${chatTime}ms - ${replyText.slice(0, 30)}...`);
        
        const ttsStart = Date.now();
        const ttsResp = await axios.post('http://localhost:4014/api/tts', {
            text: replyText,
            userId: 'tts_test'
        }, { timeout: 30000 });
        
        const ttsTime = Date.now() - ttsStart;
        const totalTime = Date.now() - start;
        console.log(`TTS: ${ttsTime}ms`);
        console.log(`总耗时: ${totalTime}ms`);
        
    } catch (e) {
        console.log(`失败: ${e.message}`);
    }
}

testTTS();
