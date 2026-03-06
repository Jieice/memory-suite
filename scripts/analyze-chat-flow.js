/**
 * 详细链路分析脚本 - 分析每个阶段的耗时
 */

const axios = require('axios');

const MU_URL = 'http://localhost:4005';
const BRAINNN_URL = 'http://localhost:4007';
const TTS_URL = 'http://localhost:4014';

async function testMemoryRetrieval() {
    console.log('\n=== 测试 Memory 检索 ===');
    const start = Date.now();
    try {
        const resp = await axios.post(`${MU_URL}/api/memory/retrieve`, {
            query: '测试',
            userId: 'test_user',
            topK: 5
        }, { timeout: 5000 });
        console.log(`Memory 检索: ${Date.now() - start}ms`);
        return Date.now() - start;
    } catch (e) {
        console.log(`Memory 检索失败: ${Date.now() - start}ms - ${e.message}`);
        return Date.now() - start;
    }
}

async function testBrainNNDirect() {
    console.log('\n=== 测试 BrainNN 直连 ===');
    const start = Date.now();
    try {
        const resp = await axios.post(`${BRAINNN_URL}/think`, {
            text: '你好',
            source: 'test'
        }, { timeout: 5000 });
        console.log(`BrainNN: ${Date.now() - start}ms`);
        return Date.now() - start;
    } catch (e) {
        console.log(`BrainNN 失败: ${Date.now() - start}ms - ${e.message}`);
        return Date.now() - start;
    }
}

async function testTTS() {
    console.log('\n=== 测试 TTS ===');
    const start = Date.now();
    try {
        const resp = await axios.post(`${TTS_URL}/synthesize`, {
            text: '你好，这是一段测试文本。',
            userId: 'test'
        }, { timeout: 30000 });
        console.log(`TTS 合成: ${Date.now() - start}ms`);
        console.log(`音频 URL: ${resp.data?.audioUrl || resp.data?.url || 'N/A'}`);
        return Date.now() - start;
    } catch (e) {
        console.log(`TTS 失败: ${Date.now() - start}ms - ${e.message}`);
        return Date.now() - start;
    }
}

async function testChatWithTiming() {
    console.log('\n=== 测试完整 Chat 链路（带详细计时）===');
    
    const overallStart = Date.now();
    
    try {
        // 使用流式请求来观察各阶段
        const response = await axios.post(`${MU_URL}/api/chat`, {
            userId: 'test_user',
            text: '你好',
            source: 'test'
        }, { 
            timeout: 30000,
            responseType: 'stream'
        });
        
        let firstChunkTime = null;
        let fullText = '';
        
        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                if (!firstChunkTime) {
                    firstChunkTime = Date.now();
                    console.log(`首个 chunk: ${firstChunkTime - overallStart}ms`);
                }
                fullText += chunk.toString();
            });
            
            response.data.on('end', () => {
                const totalMs = Date.now() - overallStart;
                console.log(`完整响应: ${totalMs}ms`);
                console.log(`TTFT (首字延迟): ${firstChunkTime ? firstChunkTime - overallStart : 'N/A'}ms`);
                console.log(`响应长度: ${fullText.length} 字符`);
                resolve(totalMs);
            });
            
            response.data.on('error', reject);
        });
        
    } catch (e) {
        console.log(`Chat 失败: ${Date.now() - overallStart}ms - ${e.message}`);
        return Date.now() - overallStart;
    }
}

async function testChatNonStream() {
    console.log('\n=== 测试非流式 Chat ===');
    const start = Date.now();
    try {
        const resp = await axios.post(`${MU_URL}/api/chat`, {
            userId: 'test_user',
            text: '你好',
            source: 'test',
            stream: false
        }, { timeout: 30000 });
        const elapsed = Date.now() - start;
        console.log(`非流式 Chat: ${elapsed}ms`);
        console.log(`响应: ${(resp.data?.text || resp.data?.reply || '').slice(0, 50)}...`);
        return elapsed;
    } catch (e) {
        console.log(`非流式 Chat 失败: ${Date.now() - start}ms - ${e.message}`);
        return Date.now() - start;
    }
}

async function checkServiceHealth() {
    console.log('\n=== 服务健康检查 ===');
    const services = [
        { name: 'Memory Universe', url: `${MU_URL}/health` },
        { name: 'BrainNN', url: `${BRAINNN_URL}/health` },
        { name: 'TTS', url: `${TTS_URL}/health` },
    ];
    
    for (const s of services) {
        const start = Date.now();
        try {
            await axios.get(s.url, { timeout: 2000 });
            console.log(`${s.name}: ${Date.now() - start}ms ✅`);
        } catch (e) {
            console.log(`${s.name}: ${Date.now() - start}ms ❌`);
        }
    }
}

async function analyzeChatFlow() {
    console.log('========================================');
    console.log('Memory Universe 链路详细分析');
    console.log('========================================');
    
    await checkServiceHealth();
    
    // 先预热 BrainNN 缓存
    console.log('\n--- 预热 BrainNN 缓存 ---');
    await testBrainNNDirect();
    
    // 测试各组件
    await testMemoryRetrieval();
    await testBrainNNDirect();
    
    // 测试完整链路
    await testChatNonStream();
    await testChatWithTiming();
    
    // 测试 TTS
    await testTTS();
    
    console.log('\n========================================');
    console.log('分析完成');
    console.log('========================================');
}

analyzeChatFlow().catch(console.error);
