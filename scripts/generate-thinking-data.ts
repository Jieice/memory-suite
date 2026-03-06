/**
 * 思维链训练数据生成器
 * 
 * 功能：
 * 1. 读取现有对话数据
 * 2. 用 LLM 为每条对话生成思考过程
 * 3. 保存为思维链训练数据
 * 
 * 使用方法：
 * npx ts-node scripts/generate-thinking-data.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

// 配置
const CONFIG = {
  // LLM API 配置
  llmApiUrl: process.env.LLM_API_URL || 'http://localhost:11434/api/generate',
  llmModel: process.env.LLM_MODEL || 'qwen2.5:7b',
  
  // 输入输出路径
  inputPath: path.resolve(__dirname, '../data/training/samples.json'),
  outputPath: path.resolve(__dirname, '../data/training/thinking-samples.json'),
  
  // 生成配置
  maxSamples: 100,  // 每次最多处理多少条
  batchSize: 5,     // 并发数
  delayMs: 500,     // 请求间隔
};

// 思维链数据结构
interface ThinkingSample {
  id: string;
  input: string;           // 用户输入
  thinking: string[];      // 思考步骤
  thinkingVector: number[]; // 思考向量（用于训练）
  output: string;          // 最终回复
  behaviorType: string;    // 行为类型
  metadata: {
    sentiment: number;     // 情感
    risk: number;          // 风险
    intent: string;        // 意图
    generatedAt: number;   // 生成时间
  };
}

// 思考提示词模板
const THINKING_PROMPT = `你是一个虚拟主播的内心思考模拟器。

给定用户的弹幕消息，请模拟主播在回复前的内心思考过程。

思考应该包含以下几个方面（每个方面一句话）：
1. 【意图判断】用户想表达什么？是提问/调侃/攻击/闲聊/请求？
2. 【情感分析】用户的情绪是正面/负面/中性？语气如何？
3. 【风险评估】这条消息有没有风险？需要谨慎回应吗？
4. 【策略选择】我应该用什么风格回应？友好/玩笑/认真/回避？
5. 【记忆关联】有没有相关的记忆或话题可以联系？

请用JSON格式输出，例如：
{
  "thinking": [
    "用户在调侃我，语气轻松",
    "情绪是正面的，在开玩笑",
    "没有风险，可以放松回应",
    "用自嘲的方式回应会比较有趣",
    "之前聊过类似话题，可以接梗"
  ],
  "intent": "tease",
  "sentiment": 0.6,
  "risk": 0.1,
  "suggestedBehavior": "reply_playful"
}

用户消息：{INPUT}
主播回复：{OUTPUT}

请输出思考过程：`;

/**
 * 调用 LLM 生成思考过程
 */
async function generateThinking(input: string, output: string): Promise<{
  thinking: string[];
  intent: string;
  sentiment: number;
  risk: number;
  suggestedBehavior: string;
} | null> {
  const prompt = THINKING_PROMPT
    .replace('{INPUT}', input)
    .replace('{OUTPUT}', output);
  
  try {
    const response = await axios.post(CONFIG.llmApiUrl, {
      model: CONFIG.llmModel,
      prompt: prompt,
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 500,
      }
    }, { timeout: 30000 });
    
    const text = response.data?.response || '';
    
    // 尝试解析 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        thinking: parsed.thinking || [],
        intent: parsed.intent || 'unknown',
        sentiment: parsed.sentiment || 0,
        risk: parsed.risk || 0,
        suggestedBehavior: parsed.suggestedBehavior || 'reply_friendly'
      };
    }
    
    return null;
  } catch (error) {
    console.error('LLM 调用失败:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * 将思考步骤转换为向量
 */
function thinkingToVector(thinking: string[], intent: string, sentiment: number, risk: number): number[] {
  // 简单的向量化：
  // [0-4]: 思考步骤数量的 one-hot
  // [5-9]: 意图类型的 one-hot
  // [10]: 情感值
  // [11]: 风险值
  // [12-15]: 思考关键词特征
  
  const vector = new Array(16).fill(0);
  
  // 思考步骤数量
  const stepCount = Math.min(thinking.length, 5);
  if (stepCount > 0) vector[stepCount - 1] = 1;
  
  // 意图类型
  const intents = ['question', 'tease', 'attack', 'chat', 'request'];
  const intentIdx = intents.indexOf(intent);
  if (intentIdx >= 0) vector[5 + intentIdx] = 1;
  
  // 情感和风险
  vector[10] = sentiment;
  vector[11] = risk;
  
  // 关键词特征
  const keywords = {
    positive: ['开心', '有趣', '喜欢', '好', '棒', '哈哈'],
    negative: ['难过', '生气', '讨厌', '烦', '无聊'],
    question: ['为什么', '怎么', '什么', '吗', '？'],
    caution: ['小心', '谨慎', '风险', '敏感', '注意']
  };
  
  const thinkingText = thinking.join(' ');
  vector[12] = keywords.positive.some(k => thinkingText.includes(k)) ? 1 : 0;
  vector[13] = keywords.negative.some(k => thinkingText.includes(k)) ? 1 : 0;
  vector[14] = keywords.question.some(k => thinkingText.includes(k)) ? 1 : 0;
  vector[15] = keywords.caution.some(k => thinkingText.includes(k)) ? 1 : 0;
  
  return vector;
}

/**
 * 主函数
 */
async function main() {
  console.log('🧠 思维链训练数据生成器');
  console.log('========================\n');
  
  // 1. 读取现有训练数据
  let existingSamples: any[] = [];
  try {
    const raw = fs.readFileSync(CONFIG.inputPath, 'utf-8');
    const data = JSON.parse(raw);
    existingSamples = data.samples || [];
    console.log(`📚 读取到 ${existingSamples.length} 条现有样本`);
  } catch (error) {
    console.log('⚠️ 未找到现有训练数据，将使用示例数据');
  }
  
  // 2. 过滤出有效的对话样本
  const validSamples = existingSamples.filter(s => 
    s.metadata?.inputText && 
    s.metadata?.outputText &&
    s.metadata.inputText !== 'Mocked response' &&
    s.metadata.outputText !== 'Mocked response'
  );
  
  console.log(`✅ 有效样本: ${validSamples.length} 条`);
  
  // 3. 如果没有有效样本，使用示例数据
  const samplesToProcess = validSamples.length > 0 ? validSamples : getExampleSamples();
  
  // 4. 生成思维链数据
  const thinkingSamples: ThinkingSample[] = [];
  const toProcess = samplesToProcess.slice(0, CONFIG.maxSamples);
  
  console.log(`\n🔄 开始生成思维链数据 (${toProcess.length} 条)...\n`);
  
  for (let i = 0; i < toProcess.length; i++) {
    const sample = toProcess[i];
    const input = sample.metadata?.inputText || sample.input;
    const output = sample.metadata?.outputText || sample.output;
    
    if (!input || !output) continue;
    
    console.log(`[${i + 1}/${toProcess.length}] 处理: "${input.substring(0, 30)}..."`);
    
    const result = await generateThinking(input, output);
    
    if (result && result.thinking.length > 0) {
      thinkingSamples.push({
        id: `thinking_${Date.now()}_${i}`,
        input,
        thinking: result.thinking,
        thinkingVector: thinkingToVector(
          result.thinking, 
          result.intent, 
          result.sentiment, 
          result.risk
        ),
        output,
        behaviorType: result.suggestedBehavior,
        metadata: {
          sentiment: result.sentiment,
          risk: result.risk,
          intent: result.intent,
          generatedAt: Date.now()
        }
      });
      console.log(`  ✅ 生成 ${result.thinking.length} 条思考`);
    } else {
      console.log(`  ⚠️ 生成失败，跳过`);
    }
    
    // 延迟避免请求过快
    if (i < toProcess.length - 1) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.delayMs));
    }
  }
  
  // 5. 保存结果
  const outputData = {
    version: '1.0',
    generatedAt: Date.now(),
    totalSamples: thinkingSamples.length,
    samples: thinkingSamples
  };
  
  // 确保目录存在
  const outputDir = path.dirname(CONFIG.outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  fs.writeFileSync(CONFIG.outputPath, JSON.stringify(outputData, null, 2), 'utf-8');
  
  console.log(`\n✅ 完成！生成了 ${thinkingSamples.length} 条思维链数据`);
  console.log(`📁 保存到: ${CONFIG.outputPath}`);
}

/**
 * 示例数据（当没有真实数据时使用）
 */
function getExampleSamples() {
  return [
    { input: '主播你好', output: '你好呀~欢迎来到直播间！' },
    { input: '主播你好丑', output: '哈哈，丑萌丑萌的~' },
    { input: '今天吃什么', output: '还没想好呢，你们有什么推荐吗？' },
    { input: '主播唱首歌吧', output: '好呀，想听什么歌？' },
    { input: '你是AI吗', output: '我是你们的虚拟主播呀~' },
    { input: '无聊', output: '那我给你讲个笑话吧！' },
    { input: '主播多大了', output: '永远18岁！' },
    { input: '你好笨', output: '笨是笨了点，但我努力学习中~' },
    { input: '喜欢你', output: '谢谢喜欢！我也喜欢你们~' },
    { input: '主播在哪里', output: '我在二次元的世界里呀~' },
    { input: '能不能别说话了', output: '好吧，那我安静一会儿...' },
    { input: '主播玩什么游戏', output: '最近在玩原神，你们玩吗？' },
    { input: '你有男朋友吗', output: '我的男朋友就是直播间的你们呀~' },
    { input: '主播晚安', output: '晚安~明天见！' },
    { input: '666', output: '谢谢支持！' },
    { input: '主播你声音好好听', output: '谢谢夸奖，开心~' },
    { input: '能加个好友吗', output: '直播间就是我们交流的地方呀~' },
    { input: '主播你是不是机器人', output: '我是有感情的虚拟主播！' },
    { input: '好无聊啊', output: '那我们来玩个游戏吧？' },
    { input: '主播你喜欢什么', output: '我喜欢和你们聊天呀~' },
  ];
}

// 运行
main().catch(console.error);
