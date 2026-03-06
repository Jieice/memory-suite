const axios = require('axios');

async function testMultiple() {
    console.log('=== 连续测试 5 次 ===\n');
    
    for (let i = 1; i <= 5; i++) {
        const start = Date.now();
        try {
            const resp = await axios.post('http://localhost:4005/api/chat', {
                userId: 'perf_test',
                text: `测试 ${i}`,
                source: 'test'
            }, { timeout: 10000 });
            const elapsed = Date.now() - start;
            const text = (resp.data?.text || resp.data?.reply || '').slice(0, 30);
            console.log(`请求 ${i}: ${elapsed}ms - ${text}...`);
        } catch (e) {
            console.log(`请求 ${i}: ${Date.now() - start}ms - 失败: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 200));
    }
}

testMultiple();
