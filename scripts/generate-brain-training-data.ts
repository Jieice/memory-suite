/**
 * BrainNN 训练数据生成器
 * 
 * 从 LCCC 对话数据集生成 BrainNN 训练数据
 * 使用规则 + 启发式方法自动标注
 * 
 * 标注维度：
 * 1. direction - 思考方向（基于回复内容分析）
 * 2. emotion - 情绪类型和强度（基于情感词和标点）
 * 3. strategy - 回复策略（基于回复模式）
 * 4. tone - 语气（基于用词风格）
 * 5. useMemory/askBack/useEmoji - 辅助标签
 */

import * as fs from 'fs';
import * as path from 'path';

// ==================== 配置 ====================

const CONFIG = {
  // 输入：已有训练样本（已包含嵌入）
  INPUT_PATH: path.join(__dirname, '..', 'data', 'training', 'samples.json'),
  // 输出：BrainNN 训练数据
  OUTPUT_PATH: path.join(__dirname, '..', 'data', 'training', 'brain-training-data.json'),
  // 最大样本数
  MAX_SAMPLES: 10000,
  // 嵌入维度
  EMBEDDING_DIM: 1024,
};

// ==================== 类型定义 ====================

interface InputSample {
  id: string;
  features: {
    stateVector: number[];
    perceptionVector: number[];
    messageEmbedding: number[];
    memoryContextEmbedding: number[];
  };
  label: {
    selectedCandidate: string;
  };
  metadata?: {
    inputText?: string;
    outputText?: string;
  };
}

interface BrainTrainingSample {
  id: string;
  input: {
    stateVector: number[];
    perceptionVector: number[];
    messageEmbedding: number[];
    memoryEmbedding: number[];
  };
  target: {
    direction: string;
    emotionType: string;
    emotionIntensity: number;
    strategyType: string;
    tone: string;
    useMemory: boolean;
    askBack: boolean;
    useEmoji: boolean;
  };
  metadata: {
    source: string;
    inputText: string;
    outputText: string;
  };
}


// ==================== 情感词典 ====================

const EMOTION_WORDS = {
  joy: ['哈哈', '嘿嘿', '开心', '高兴', '太好了', '棒', '赞', '喜欢', '爱', '幸福', '快乐', '嘻嘻', '哇', '耶'],
  curiosity: ['为什么', '怎么', '什么', '哪', '谁', '吗', '呢', '好奇', '想知道', '请问', '能不能'],
  empathy: ['理解', '明白', '懂', '心疼', '辛苦', '不容易', '加油', '支持', '陪你', '抱抱'],
  surprise: ['啊', '哇', '天哪', '真的吗', '不会吧', '居然', '竟然', '没想到', '意外', '震惊'],
  concern: ['担心', '害怕', '紧张', '焦虑', '不安', '小心', '注意', '别', '不要', '危险'],
  playful: ['嘿', '哼', '略略', '嘻', '逗', '玩', '皮', '调皮', '捣蛋', '搞笑'],
  calm: ['嗯', '好的', '行', '可以', '没问题', '知道了', '了解', '明白'],
  annoyed: ['烦', '讨厌', '无聊', '够了', '算了', '懒得', '不想', '累', '困']
};

const QUESTION_PATTERNS = [
  /[？?]$/,
  /^(为什么|怎么|什么|哪|谁|几|多少)/,
  /吗[？?]?$/,
  /呢[？?]?$/,
  /(能不能|可不可以|会不会|是不是)/
];

const SHARE_PATTERNS = [
  /^(我|我们|咱)/,
  /(告诉你|跟你说|分享)/,
  /^(其实|说实话|老实说)/,
  /(经历|故事|事情)/
];

const EMOJI_PATTERNS = [
  /[😀-😿🙀-🙏🤐-🤿🥀-🥿🦀-🦿🧀-🧿]/u,
  /[~～]+/,
  /[!！]{2,}/,
  /哈{2,}/,
  /嘿{2,}/
];

// ==================== 标注函数 ====================

/** 分析思考方向 */
function analyzeDirection(input: string, response: string): string {
  // 检查是否是问句回复
  if (QUESTION_PATTERNS.some(p => p.test(input))) {
    if (response.length > 20 && !QUESTION_PATTERNS.some(p => p.test(response))) {
      return 'answer';
    }
  }
  
  // 检查是否是反问
  if (QUESTION_PATTERNS.some(p => p.test(response))) {
    return 'question';
  }
  
  // 检查是否是分享
  if (SHARE_PATTERNS.some(p => p.test(response))) {
    return 'share';
  }
  
  // 检查是否是情绪反应
  const emotionCount = Object.values(EMOTION_WORDS).flat()
    .filter(w => response.includes(w)).length;
  if (emotionCount >= 2 || /[!！]{2,}|哈{3,}/.test(response)) {
    return 'react';
  }
  
  // 检查是否是回忆
  if (/(以前|之前|上次|那时|记得|想起)/.test(response)) {
    return 'recall';
  }
  
  // 默认：回答
  return 'answer';
}

/** 分析情绪类型和强度 */
function analyzeEmotion(response: string): { type: string; intensity: number } {
  const scores: Record<string, number> = {
    joy: 0, curiosity: 0, empathy: 0, surprise: 0,
    concern: 0, playful: 0, calm: 0, annoyed: 0
  };
  
  // 统计情感词
  for (const [emotion, words] of Object.entries(EMOTION_WORDS)) {
    for (const word of words) {
      if (response.includes(word)) {
        scores[emotion] += 1;
      }
    }
  }
  
  // 标点符号加成
  if (/[!！]{2,}/.test(response)) {
    scores.joy += 0.5;
    scores.surprise += 0.5;
  }
  if (/[？?]{2,}/.test(response)) {
    scores.curiosity += 0.5;
  }
  if (/~+/.test(response)) {
    scores.playful += 0.5;
  }
  
  // 找最高分
  let maxEmotion = 'calm';
  let maxScore = 0;
  for (const [emotion, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxEmotion = emotion;
    }
  }
  
  // 计算强度 (0-1)
  const intensity = Math.min(maxScore / 3, 1);
  
  return { type: maxEmotion, intensity: Math.max(0.3, intensity) };
}

/** 分析回复策略 */
function analyzeStrategy(input: string, response: string): string {
  // 沉默/简短回复
  if (response.length <= 3) {
    return 'silent';
  }
  
  // 反问
  if (QUESTION_PATTERNS.some(p => p.test(response)) && response.length < 30) {
    return 'ask_back';
  }
  
  // 共情
  if (EMOTION_WORDS.empathy.some(w => response.includes(w))) {
    return 'empathize';
  }
  
  // 玩笑
  if (EMOTION_WORDS.playful.some(w => response.includes(w)) || /哈{3,}/.test(response)) {
    return 'joke';
  }
  
  // 分享经历
  if (SHARE_PATTERNS.some(p => p.test(response)) && response.length > 30) {
    return 'share_experience';
  }
  
  // 转移话题
  if (/(话说|对了|说起|顺便)/.test(response)) {
    return 'deflect';
  }
  
  // 默认：直接回答
  return 'direct_answer';
}

/** 分析语气 */
function analyzeTone(response: string): string {
  // 俏皮
  if (/[~～]|嘿|哈哈|嘻嘻/.test(response)) {
    return 'playful';
  }
  
  // 好奇
  if (QUESTION_PATTERNS.some(p => p.test(response))) {
    return 'curious';
  }
  
  // 支持
  if (EMOTION_WORDS.empathy.some(w => response.includes(w))) {
    return 'supportive';
  }
  
  // 调侃
  if (/(哼|略略|皮)/.test(response)) {
    return 'teasing';
  }
  
  // 认真
  if (response.length > 50 && !/[~～!！]/.test(response)) {
    return 'serious';
  }
  
  // 默认：温暖
  return 'warm';
}

/** 检查是否使用表情 */
function hasEmoji(text: string): boolean {
  return EMOJI_PATTERNS.some(p => p.test(text));
}

/** 检查是否反问 */
function hasQuestion(text: string): boolean {
  return QUESTION_PATTERNS.some(p => p.test(text));
}


// ==================== 状态向量生成 ====================

/** 生成模拟的状态向量 (27维) */
function generateStateVector(input: string, response: string): number[] {
  const state: number[] = [];
  
  // PersonaState (6维)
  state.push(0.6);  // emotionBaseline
  state.push(0.5 + Math.random() * 0.3);  // energyLevel
  state.push(0.4 + Math.random() * 0.2);  // playful
  state.push(0.2 + Math.random() * 0.2);  // serious
  state.push(0.5);  // creatorIntimacy
  state.push(0.6);  // viewerWarmth
  
  // MindState Traits (10维)
  state.push(0.7);  // warmth
  state.push(0.6);  // playfulness
  state.push(0.5);  // cuteness
  state.push(0.4);  // innocence
  state.push(0.3);  // cunning
  state.push(0.2);  // cynicism
  state.push(0.3);  // teasing
  state.push(0.5);  // directness
  state.push(0.6);  // curiosity
  state.push(0.7);  // empathy
  
  // MindState Mood (8维) - 基于回复内容调整
  const emotion = analyzeEmotion(response);
  state.push(emotion.type === 'joy' ? emotion.intensity : 0.3);  // joy
  state.push(emotion.type === 'concern' ? emotion.intensity * 0.5 : 0.1);  // sadness
  state.push(emotion.type === 'annoyed' ? emotion.intensity * 0.5 : 0.1);  // anger
  state.push(emotion.type === 'concern' ? emotion.intensity : 0.2);  // anxiety
  state.push(0.3);  // fatigue
  state.push(0.6);  // confidence
  state.push(0.5);  // affection
  state.push(0.1);  // embarrassment
  
  // LiveState (3维)
  state.push(1);  // isLive
  state.push(0.3 + Math.random() * 0.4);  // viewerCount normalized
  state.push(0.5);  // interactionDensity
  
  return state;
}

/** 生成感知向量 (8维) */
function generatePerceptionVector(input: string): number[] {
  const perc: number[] = [];
  
  // sentiment (-1 to 1, normalized to 0-1)
  const positiveWords = ['好', '棒', '喜欢', '开心', '谢谢', '爱'];
  const negativeWords = ['不', '没', '烦', '讨厌', '差', '坏'];
  let sentiment = 0.5;
  for (const w of positiveWords) if (input.includes(w)) sentiment += 0.1;
  for (const w of negativeWords) if (input.includes(w)) sentiment -= 0.1;
  perc.push(Math.max(0, Math.min(1, sentiment)));
  
  // riskHint
  const riskWords = ['政治', '敏感', '色情', '暴力', '违法'];
  const risk = riskWords.some(w => input.includes(w)) ? 0.8 : 0.1;
  perc.push(risk);
  
  // confidence
  perc.push(0.8);
  
  // entity count (normalized)
  const entityCount = (input.match(/[\u4e00-\u9fa5]{2,4}/g) || []).length;
  perc.push(Math.min(entityCount / 10, 1));
  
  // 预留维度
  perc.push(0, 0, 0, 0);
  
  return perc;
}

// ==================== 主流程 ====================

async function generateTrainingData(): Promise<void> {
  console.log('\n========================================');
  console.log('🧠 BrainNN 训练数据生成');
  console.log('========================================\n');
  
  // 1. 加载带嵌入的样本
  if (!fs.existsSync(CONFIG.INPUT_PATH)) {
    throw new Error(`输入文件不存在: ${CONFIG.INPUT_PATH}`);
  }
  
  const inputText = fs.readFileSync(CONFIG.INPUT_PATH, 'utf-8');
  const parsed = JSON.parse(inputText);
  
  // 支持两种格式：数组或 { samples: [] }
  let inputSamples: InputSample[];
  if (Array.isArray(parsed)) {
    inputSamples = parsed;
  } else if (parsed.samples && Array.isArray(parsed.samples)) {
    inputSamples = parsed.samples;
  } else {
    throw new Error('无法解析样本文件格式');
  }
  
  console.log(`[生成] 加载样本: ${inputSamples.length}`);
  
  // 2. 转换为 BrainNN 训练数据
  const brainSamples: BrainTrainingSample[] = [];
  let skipped = 0;
  
  for (const sample of inputSamples) {
    // 跳过无效样本
    if (!sample.features?.messageEmbedding || !sample.features?.memoryContextEmbedding) {
      skipped++;
      continue;
    }
    if (sample.features.messageEmbedding.length !== CONFIG.EMBEDDING_DIM) {
      skipped++;
      continue;
    }
    if (!sample.metadata?.inputText || !sample.metadata?.outputText) {
      skipped++;
      continue;
    }
    
    const input = sample.metadata.inputText;
    const response = sample.metadata.outputText;
    
    // 分析标签
    const direction = analyzeDirection(input, response);
    const emotion = analyzeEmotion(response);
    const strategy = analyzeStrategy(input, response);
    const tone = analyzeTone(response);
    
    // 生成状态向量
    const stateVector = generateStateVector(input, response);
    const perceptionVector = generatePerceptionVector(input);
    
    // 构建训练样本
    const brainSample: BrainTrainingSample = {
      id: sample.id,
      input: {
        stateVector,
        perceptionVector,
        messageEmbedding: sample.features.messageEmbedding,
        memoryEmbedding: sample.features.memoryContextEmbedding
      },
      target: {
        direction,
        emotionType: emotion.type,
        emotionIntensity: emotion.intensity,
        strategyType: strategy,
        tone,
        useMemory: Math.random() > 0.7,  // 30% 使用记忆
        askBack: hasQuestion(response),
        useEmoji: hasEmoji(response)
      },
      metadata: {
        source: 'lccc',
        inputText: input,
        outputText: response
      }
    };
    
    brainSamples.push(brainSample);
    
    if (brainSamples.length >= CONFIG.MAX_SAMPLES) break;
  }
  
  console.log(`[生成] 有效样本: ${brainSamples.length}`);
  console.log(`[生成] 跳过样本: ${skipped}`);
  
  // 3. 统计标签分布
  const stats = {
    direction: {} as Record<string, number>,
    emotion: {} as Record<string, number>,
    strategy: {} as Record<string, number>,
    tone: {} as Record<string, number>
  };
  
  for (const s of brainSamples) {
    stats.direction[s.target.direction] = (stats.direction[s.target.direction] || 0) + 1;
    stats.emotion[s.target.emotionType] = (stats.emotion[s.target.emotionType] || 0) + 1;
    stats.strategy[s.target.strategyType] = (stats.strategy[s.target.strategyType] || 0) + 1;
    stats.tone[s.target.tone] = (stats.tone[s.target.tone] || 0) + 1;
  }
  
  console.log('\n[标签分布]');
  console.log('  方向:', stats.direction);
  console.log('  情绪:', stats.emotion);
  console.log('  策略:', stats.strategy);
  console.log('  语气:', stats.tone);
  
  // 4. 保存
  const output = {
    samples: brainSamples,
    metadata: {
      createdAt: Date.now(),
      version: '1.0',
      description: 'BrainNN training data generated from LCCC with embeddings',
      stats
    }
  };
  
  const outputDir = path.dirname(CONFIG.OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  fs.writeFileSync(CONFIG.OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n[生成] 已保存: ${CONFIG.OUTPUT_PATH}`);
  
  console.log('\n========================================');
  console.log('✅ 训练数据生成完成');
  console.log('========================================\n');
}

// ==================== 入口 ====================

if (require.main === module) {
  generateTrainingData().catch(err => {
    console.error('生成失败:', err);
    process.exit(1);
  });
}

export { generateTrainingData };
