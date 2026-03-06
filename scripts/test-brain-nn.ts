/**
 * BrainNN 测试脚本
 * 
 * 测试训练好的 BrainNN 在实际对话中的表现
 */

import * as fs from 'fs';
import * as path from 'path';
import { BrainNN, getBrainNN, BrainOutput } from '../memory-universe/src/core/BrainNN';

// 加载 .env
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (!process.env[key]) process.env[key] = value;
      }
    }
  }
}

// 调用嵌入 API
async function getEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.EMBEDDING_API_KEY;
  const apiUrl = process.env.EMBEDDING_API_URL || 'https://api.siliconflow.cn/v1/embeddings';
  const model = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3';
  
  if (!apiKey) {
    console.warn('⚠️ EMBEDDING_API_KEY 未设置，使用随机向量');
    return new Array(1024).fill(0).map(() => Math.random() * 0.1 - 0.05);
  }
  
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input: [text], encoding_format: 'float' })
  });
  
  if (!response.ok) throw new Error(`Embedding API error: ${response.status}`);
  const data = await response.json() as any;
  return data.data[0].embedding;
}

// 生成状态向量
function generateStateVector(): number[] {
  return [
    0.6, 0.7, 0.5, 0.3, 0.5, 0.6,  // PersonaState
    0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.3, 0.5, 0.6, 0.7,  // Traits
    0.5, 0.1, 0.1, 0.2, 0.3, 0.6, 0.5, 0.1,  // Mood
    1, 0.5, 0.5  // LiveState
  ];
}

// 生成感知向量
function generatePerceptionVector(text: string): number[] {
  const positive = ['好', '棒', '喜欢', '开心', '谢谢'].some(w => text.includes(w));
  const negative = ['不', '烦', '讨厌', '差'].some(w => text.includes(w));
  const sentiment = positive ? 0.7 : negative ? 0.3 : 0.5;
  return [sentiment, 0.1, 0.8, 0, 0, 0, 0, 0];
}

// 格式化输出
function formatOutput(output: BrainOutput): string {
  const directionMap: Record<string, string> = {
    'answer': '回答', 'question': '提问', 'share': '分享',
    'react': '反应', 'recall': '回忆', 'ignore': '忽略'
  };
  const emotionMap: Record<string, string> = {
    'joy': '😊开心', 'curiosity': '🤔好奇', 'empathy': '🤗共情',
    'surprise': '😮惊讶', 'concern': '😟担心', 'playful': '😜俏皮',
    'calm': '😌平静', 'annoyed': '😤烦躁'
  };
  const strategyMap: Record<string, string> = {
    'direct_answer': '直接回答', 'share_experience': '分享经历',
    'ask_back': '反问', 'empathize': '共情', 'joke': '玩笑',
    'deflect': '转移', 'silent': '沉默'
  };
  const toneMap: Record<string, string> = {
    'warm': '温暖', 'playful': '俏皮', 'serious': '认真',
    'curious': '好奇', 'supportive': '支持', 'teasing': '调侃'
  };
  
  return `
  📍 思考方向: ${directionMap[output.thinking.direction] || output.thinking.direction}
  💭 情绪: ${emotionMap[output.emotion.primary.type] || output.emotion.primary.type} (强度: ${(output.emotion.primary.intensity * 100).toFixed(0)}%)
  🎯 策略: ${strategyMap[output.strategy.type] || output.strategy.type}
  🎨 语气: ${toneMap[output.strategy.tone] || output.strategy.tone}
  📝 长度建议: ${output.strategy.lengthHint} 字
  🔧 使用记忆: ${output.strategy.useMemory ? '是' : '否'} | 反问: ${output.strategy.askBack ? '是' : '否'} | 表情: ${output.strategy.useEmoji ? '是' : '否'}
  📊 置信度: ${(output.confidence * 100).toFixed(1)}%`;
}

// 测试用例
const TEST_CASES = [
  '你好啊',
  '今天天气真好',
  '我好难过，工作压力太大了',
  '哈哈哈哈太好笑了',
  '你觉得人工智能会取代人类吗？',
  '谢谢你陪我聊天',
  '无聊死了',
  '给我讲个笑话吧',
  '你最近在忙什么？',
  '我刚吃完饭，好撑啊',
];

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('🧠 BrainNN 测试');
  console.log('='.repeat(60) + '\n');
  
  loadEnv();
  
  // 加载权重
  const weightsPath = path.join(__dirname, '..', 'data', 'models', 'brain-nn-weights.json');
  if (!fs.existsSync(weightsPath)) {
    console.error('❌ 权重文件不存在:', weightsPath);
    process.exit(1);
  }
  
  console.log('[加载] 读取权重...');
  const weightsRaw = fs.readFileSync(weightsPath, 'utf-8');
  const weightsData = JSON.parse(weightsRaw);
  
  const brainNN = getBrainNN();
  
  // 加载 PyTorch 导出的权重
  if (weightsData.weights) {
    console.log('[加载] 检测到 PyTorch 导出的权重，正在加载...');
    brainNN.loadWeights(weightsData.weights);
    console.log('[加载] 权重加载完成');
  }
  
  console.log(`[信息] 模型版本: ${brainNN.getModelVersion()}`);
  console.log('');
  
  // 测试每个用例
  for (const testInput of TEST_CASES) {
    console.log('-'.repeat(60));
    console.log(`💬 用户: "${testInput}"`);
    
    try {
      // 获取嵌入
      const msgEmbedding = await getEmbedding(testInput);
      const memEmbedding = new Array(1024).fill(0);  // 空记忆上下文
      
      // 生成状态
      const stateVector = generateStateVector();
      const percVector = generatePerceptionVector(testInput);
      
      // 调用 BrainNN（带原文修正）
      const output = (brainNN as any).thinkWithText 
        ? (brainNN as any).thinkWithText(stateVector, percVector, msgEmbedding, memEmbedding, testInput)
        : brainNN.think(stateVector, percVector, msgEmbedding, memEmbedding);
      
      console.log(formatOutput(output));
    } catch (error) {
      console.error('❌ 错误:', error);
    }
    
    console.log('');
  }
  
  console.log('='.repeat(60));
  console.log('✅ 测试完成');
  console.log('='.repeat(60) + '\n');
}

main().catch(console.error);
