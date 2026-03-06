/**
 * LLM 链路诊断脚本
 * 测试各个环节的耗时，定位慢的原因
 */

const axios = require('axios');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-5d66932d39e04393a7488e18a157a3a9';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const LOCAL_LLM_URL = 'http://localhost:4005';

const TEST_PROMPT = '你好，请用一句话回复。';

async function testDeepSeekDirect() {
    console.log('\n=== 测试 1: DeepSeek API 直连 ===');
    const start = Date.now();
    
    try {
        const response = await axios.post(
            `${DEEPSEEK_BASE_URL}/chat/completions`,
            {
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: TEST_PROMPT }],
                max_tokens: 50,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );
        
        const elapsed = Date.now() - start;
        const text = response.data?.choices?.[0]?.message?.content || '';
        console.log(`✅ DeepSeek 直连成功: ${elapsed}ms`);
        console.log(`   响应长度: ${text.length} 字符`);
        console.log(`   响应预览: ${text.slice(0, 50)}...`);
        return { success: true, elapsed, text };
    } catch (error) {
        const elapsed = Date.now() - start;
        console.log(`❌ DeepSeek 直连失败: ${elapsed}ms`);
        console.log(`   错误: ${error.message}`);
        return { success: false, elapsed, error: error.message };
    }
}

async function testMemoryUniverseChat() {
    console.log('\n=== 测试 2: Memory Universe /api/chat ===');
    const start = Date.now();
    
    try {
        const response = await axios.post(
            `${LOCAL_LLM_URL}/api/chat`,
            {
                userId: 'test_user',
                text: TEST_PROMPT,
                source: 'test'
            },
            {
                timeout: 30000
            }
        );
        
        const elapsed = Date.now() - start;
        const text = response.data?.text || response.data?.reply || '';
        console.log(`✅ Memory Universe Chat 成功: ${elapsed}ms`);
        console.log(`   响应长度: ${text.length} 字符`);
        console.log(`   响应预览: ${text.slice(0, 50)}...`);
        return { success: true, elapsed, text };
    } catch (error) {
        const elapsed = Date.now() - start;
        console.log(`❌ Memory Universe Chat 失败: ${elapsed}ms`);
        console.log(`   错误: ${error.message}`);
        return { success: false, elapsed, error: error.message };
    }
}

async function testBrainNN() {
    console.log('\n=== 测试 3: BrainNN /think ===');
    const start = Date.now();
    
    try {
        const response = await axios.post(
            'http://localhost:4007/think',
            {
                text: TEST_PROMPT,
                source: 'test'
            },
            {
                timeout: 10000
            }
        );
        
        const elapsed = Date.now() - start;
        console.log(`✅ BrainNN 成功: ${elapsed}ms`);
        console.log(`   Soul State: ${JSON.stringify(response.data?.soul?.emotion || {}).slice(0, 100)}...`);
        return { success: true, elapsed };
    } catch (error) {
        const elapsed = Date.now() - start;
        console.log(`❌ BrainNN 失败: ${elapsed}ms`);
        console.log(`   错误: ${error.message}`);
        return { success: false, elapsed, error: error.message };
    }
}

async function testLocalLLMDirect() {
    console.log('\n=== 测试 4: 本地 LLM (通过 Memory Universe) ===');
    const start = Date.now();
    
    try {
        const response = await axios.post(
            `${LOCAL_LLM_URL}/api/chat`,
            {
                userId: 'test_user',
                text: TEST_PROMPT,
                source: 'test',
                forceProvider: 'local'
            },
            {
                timeout: 60000
            }
        );
        
        const elapsed = Date.now() - start;
        const text = response.data?.text || response.data?.reply || '';
        console.log(`✅ 本地 LLM 成功: ${elapsed}ms`);
        console.log(`   响应长度: ${text.length} 字符`);
        console.log(`   响应预览: ${text.slice(0, 50)}...`);
        return { success: true, elapsed, text };
    } catch (error) {
        const elapsed = Date.now() - start;
        console.log(`❌ 本地 LLM 失败: ${elapsed}ms`);
        console.log(`   错误: ${error.message}`);
        return { success: false, elapsed, error: error.message };
    }
}

async function testDeepSeekWithTimeout(timeoutMs) {
    console.log(`\n=== 测试 5: DeepSeek 超时测试 (${timeoutMs}ms) ===`);
    const start = Date.now();
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await axios.post(
            `${DEEPSEEK_BASE_URL}/chat/completions`,
            {
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: TEST_PROMPT }],
                max_tokens: 50,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                signal: controller.signal
            }
        );
        
        clearTimeout(timeoutId);
        const elapsed = Date.now() - start;
        const text = response.data?.choices?.[0]?.message?.content || '';
        console.log(`✅ DeepSeek (${timeoutMs}ms 超时) 成功: ${elapsed}ms`);
        return { success: true, elapsed, text };
    } catch (error) {
        clearTimeout(timeoutId);
        const elapsed = Date.now() - start;
        if (error.name === 'AbortError' || error.code === 'ECONNABORTED') {
            console.log(`⏱️ DeepSeek 超时 (${timeoutMs}ms): ${elapsed}ms`);
            return { success: false, elapsed, timeout: true };
        }
        console.log(`❌ DeepSeek 失败: ${elapsed}ms - ${error.message}`);
        return { success: false, elapsed, error: error.message };
    }
}

async function main() {
    console.log('========================================');
    console.log('LLM 链路诊断脚本');
    console.log('========================================');
    console.log(`测试时间: ${new Date().toISOString()}`);
    console.log(`测试提示: "${TEST_PROMPT}"`);
    
    const results = {};
    
    results.deepSeekDirect = await testDeepSeekDirect();
    results.brainNN = await testBrainNN();
    results.memoryUniverseChat = await testMemoryUniverseChat();
    results.localLLM = await testLocalLLMDirect();
    
    console.log('\n=== 测试 5: DeepSeek 不同超时值 ===');
    for (const timeout of [1000, 2000, 3000, 5000]) {
        results[`deepSeek_${timeout}ms`] = await testDeepSeekWithTimeout(timeout);
    }
    
    console.log('\n========================================');
    console.log('诊断结果汇总');
    console.log('========================================');
    
    console.log('\n📊 各环节耗时:');
    console.log(`   DeepSeek 直连:     ${results.deepSeekDirect.elapsed}ms ${results.deepSeekDirect.success ? '✅' : '❌'}`);
    console.log(`   BrainNN:           ${results.brainNN.elapsed}ms ${results.brainNN.success ? '✅' : '❌'}`);
    console.log(`   Memory Universe:   ${results.memoryUniverseChat.elapsed}ms ${results.memoryUniverseChat.success ? '✅' : '❌'}`);
    console.log(`   本地 LLM:          ${results.localLLM.elapsed}ms ${results.localLLM.success ? '✅' : '❌'}`);
    
    console.log('\n📊 DeepSeek 超时测试:');
    for (const timeout of [1000, 2000, 3000, 5000]) {
        const r = results[`deepSeek_${timeout}ms`];
        console.log(`   ${timeout}ms 超时: ${r.elapsed}ms ${r.success ? '✅' : (r.timeout ? '⏱️ 超时' : '❌')}`);
    }
    
    console.log('\n🔍 分析:');
    
    if (results.deepSeekDirect.success && results.deepSeekDirect.elapsed > 2000) {
        console.log('   ⚠️ DeepSeek API 响应较慢，可能是网络问题');
    }
    
    if (results.memoryUniverseChat.success && results.memoryUniverseChat.elapsed > 5000) {
        console.log('   ⚠️ Memory Universe 整体链路较慢');
        
        if (results.brainNN.success && results.brainNN.elapsed < 1000) {
            console.log('   → BrainNN 不是瓶颈');
        }
        
        if (results.deepSeekDirect.success && results.deepSeekDirect.elapsed < results.memoryUniverseChat.elapsed) {
            console.log('   → DeepSeek 直连比 Memory Universe 快，说明有额外开销');
        }
    }
    
    if (results.localLLM.success && results.localLLM.elapsed > 5000) {
        console.log('   ⚠️ 本地 LLM 响应较慢，考虑减少 max_tokens 或使用更小的模型');
    }
    
    console.log('\n========================================');
}

main().catch(console.error);
