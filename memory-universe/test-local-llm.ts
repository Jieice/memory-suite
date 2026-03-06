/**
 * 测试本地 LLM 服务
 */

import { getLocalLLMService } from './src/llm/LocalLLMService';
import * as path from 'path';
import * as os from 'os';

async function testLocalLLM() {
    console.log('🧪 开始测试本地 LLM 服务...\n');
    
    const modelPath = path.join(__dirname, '../models/qwen3-0.6b/Qwen3-0.6B-Q8_0.gguf');
    console.log(`📁 模型路径: ${modelPath}`);
    console.log(`💾 内存: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB\n`);
    
    const llm = getLocalLLMService({
        modelPath,
        contextSize: 2048,
        gpuLayers: 0,
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 256
    });
    
    try {
        console.log('📝 测试 1: 简单问候');
        console.log('─'.repeat(50));
        const response1 = await llm.chat('你好，请自我介绍一下');
        console.log(`回复: ${response1}\n`);
        
        console.log('📝 测试 2: 问答');
        console.log('─'.repeat(50));
        const response2 = await llm.chat('什么是人工智能？');
        console.log(`回复: ${response2}\n`);
        
        console.log('✅ 所有测试通过！');
    } catch (error: any) {
        console.error(`❌ 测试失败: ${error.message}`);
        console.error(error.stack);
    } finally {
        await llm.dispose();
    }
}

testLocalLLM();