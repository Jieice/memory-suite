const axios = require('axios');

async function testBrainNNMultiple() {
    console.log('=== 测试 BrainNN 连续请求（验证服务缓存效果）===\n');
    
    const results = [];
    
    for (let i = 1; i <= 5; i++) {
        const start = Date.now();
        try {
            const response = await axios.post(
                'http://localhost:4007/think',
                { text: `测试消息 ${i}`, source: 'test' },
                { timeout: 10000 }
            );
            const elapsed = Date.now() - start;
            results.push({ round: i, elapsed, success: true });
            console.log(`请求 ${i}: ${elapsed}ms ✅`);
        } catch (error) {
            const elapsed = Date.now() - start;
            results.push({ round: i, elapsed, success: false });
            console.log(`请求 ${i}: ${elapsed}ms ❌ ${error.message}`);
        }
        
        // 短暂等待
        if (i < 5) await new Promise(r => setTimeout(r, 100));
    }
    
    console.log('\n=== 结果分析 ===');
    const first = results[0];
    const later = results.slice(1);
    const avgLater = later.reduce((a, b) => a + b.elapsed, 0) / later.length;
    
    console.log(`首次请求: ${first.elapsed}ms`);
    console.log(`后续平均: ${avgLater.toFixed(0)}ms`);
    
    if (avgLater < first.elapsed * 0.5) {
        console.log('✅ 服务缓存生效！后续请求明显更快');
    } else {
        console.log('⚠️ 服务缓存可能未生效');
    }
}

testBrainNNMultiple();
