/**
 * 处理完整 LCCC 数据集
 * 
 * 从 E 盘读取完整 LCCC 数据集（几百万条）
 * 批量生成嵌入，输出 BrainNN 训练数据到 E 盘
 * 
 * 用法：
 *   npm run process-lccc -- --max=100000  # 处理 10 万条
 *   npm run process-lccc -- --max=500000  # 处理 50 万条
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ==================== 配置 ====================

const CONFIG = {
  // 输入：E 盘的完整 LCCC
  LCCC_PATH: 'E:\\memory-suite-data\\lccc\\LCCC-base_train.json',
  
  // 输出：E 盘
  OUTPUT_DIR: 'E:\\memory-suite-data\\brain-training',
  OUTPUT_PATH: 'E:\\memory-suite-data\\brain-training\\brain-training-data.json',
  CHECKPOINT_PATH: 'E:\\memory-suite-data\\brain-training\\checkpoint.json',
  
  // 嵌入 API
  EMBEDDING_API_URL: process.env.EMBEDDING_API_URL || 'https://api.siliconflow.cn/v1/embeddings',
  EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY || '',
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',
  EMBEDDING_DIM: 1024,
  
  // 处理配置
  MAX_SAMPLES: 100000,  // 默认 10 万条
  BATCH_SIZE: 20,       // 每批 20 条
  DELAY_MS: 100,        // 批次间隔
  CHECKPOINT_INTERVAL: 1000,  // 每 1000 条保存检查点
};

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
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}


// ==================== 情感分析（复用） ====================

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

const QUESTION_PATTERNS = [/[？?]$/, /^(为什么|怎么|什么|哪|谁|几|多少)/, /吗[？?]?$/, /呢[？?]?$/];
const SHARE_PATTERNS = [/^(我|我们|咱)/, /(告诉你|跟你说|分享)/, /^(其实|说实话)/];
const EMOJI_PATTERNS = [/[😀-😿🙀-🙏🤐-🤿🥀-🥿🦀-🦿🧀-🧿]/u, /[~～]+/, /[!！]{2,}/, /哈{2,}/];

function analyzeDirection(input: string, response: string): string {
  if (QUESTION_PATTERNS.some(p => p.test(input)) && response.length > 20 && !QUESTION_PATTERNS.some(p => p.test(response))) return 'answer';
  if (QUESTION_PATTERNS.some(p => p.test(response))) return 'question';
  if (SHARE_PATTERNS.some(p => p.test(response))) return 'share';
  const emotionCount = Object.values(EMOTION_WORDS).flat().filter(w => response.includes(w)).length;
  if (emotionCount >= 2 || /[!！]{2,}|哈{3,}/.test(response)) return 'react';
  if (/(以前|之前|上次|那时|记得|想起)/.test(response)) return 'recall';
  return 'answer';
}

function analyzeEmotion(response: string): { type: string; intensity: number } {
  const scores: Record<string, number> = { joy: 0, curiosity: 0, empathy: 0, surprise: 0, concern: 0, playful: 0, calm: 0, annoyed: 0 };
  for (const [emotion, words] of Object.entries(EMOTION_WORDS)) {
    for (const word of words) if (response.includes(word)) scores[emotion] += 1;
  }
  if (/[!！]{2,}/.test(response)) { scores.joy += 0.5; scores.surprise += 0.5; }
  if (/[？?]{2,}/.test(response)) scores.curiosity += 0.5;
  if (/~+/.test(response)) scores.playful += 0.5;
  
  let maxEmotion = 'calm', maxScore = 0;
  for (const [emotion, score] of Object.entries(scores)) {
    if (score > maxScore) { maxScore = score; maxEmotion = emotion; }
  }
  return { type: maxEmotion, intensity: Math.max(0.3, Math.min(maxScore / 3, 1)) };
}

function analyzeStrategy(input: string, response: string): string {
  if (response.length <= 3) return 'silent';
  if (QUESTION_PATTERNS.some(p => p.test(response)) && response.length < 30) return 'ask_back';
  if (EMOTION_WORDS.empathy.some(w => response.includes(w))) return 'empathize';
  if (EMOTION_WORDS.playful.some(w => response.includes(w)) || /哈{3,}/.test(response)) return 'joke';
  if (SHARE_PATTERNS.some(p => p.test(response)) && response.length > 30) return 'share_experience';
  if (/(话说|对了|说起|顺便)/.test(response)) return 'deflect';
  return 'direct_answer';
}

function analyzeTone(response: string): string {
  if (/[~～]|嘿|哈哈|嘻嘻/.test(response)) return 'playful';
  if (QUESTION_PATTERNS.some(p => p.test(response))) return 'curious';
  if (EMOTION_WORDS.empathy.some(w => response.includes(w))) return 'supportive';
  if (/(哼|略略|皮)/.test(response)) return 'teasing';
  if (response.length > 50 && !/[~～!！]/.test(response)) return 'serious';
  return 'warm';
}

function generateStateVector(): number[] {
  return [
    0.6, 0.5 + Math.random() * 0.3, 0.4 + Math.random() * 0.2, 0.2 + Math.random() * 0.2, 0.5, 0.6,
    0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.3, 0.5, 0.6, 0.7,
    0.5, 0.1, 0.1, 0.2, 0.3, 0.6, 0.5, 0.1,
    1, 0.3 + Math.random() * 0.4, 0.5
  ];
}

function generatePerceptionVector(input: string): number[] {
  const positiveWords = ['好', '棒', '喜欢', '开心', '谢谢', '爱'];
  const negativeWords = ['不', '没', '烦', '讨厌', '差', '坏'];
  let sentiment = 0.5;
  for (const w of positiveWords) if (input.includes(w)) sentiment += 0.1;
  for (const w of negativeWords) if (input.includes(w)) sentiment -= 0.1;
  return [Math.max(0, Math.min(1, sentiment)), 0.1, 0.8, 0, 0, 0, 0, 0];
}


// ==================== 嵌入 API ====================

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.EMBEDDING_API_KEY || CONFIG.EMBEDDING_API_KEY;
  const apiUrl = process.env.EMBEDDING_API_URL || CONFIG.EMBEDDING_API_URL;
  const model = process.env.EMBEDDING_MODEL || CONFIG.EMBEDDING_MODEL;
  
  if (!apiKey) throw new Error('EMBEDDING_API_KEY not set');
  
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input: texts, encoding_format: 'float' })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Embedding API error: ${response.status} - ${error}`);
  }
  
  const data = await response.json() as any;
  return data.data.map((item: any) => item.embedding);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 主流程 ====================

interface BrainSample {
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
    inputText: string;
    outputText: string;
  };
}

interface Checkpoint {
  processedCount: number;
  samples: BrainSample[];
}

function loadCheckpoint(): Checkpoint | null {
  if (fs.existsSync(CONFIG.CHECKPOINT_PATH)) {
    const data = JSON.parse(fs.readFileSync(CONFIG.CHECKPOINT_PATH, 'utf-8'));
    return data;
  }
  return null;
}

function saveCheckpoint(checkpoint: Checkpoint): void {
  fs.writeFileSync(CONFIG.CHECKPOINT_PATH, JSON.stringify(checkpoint));
}

async function processFullLCCC(): Promise<void> {
  console.log('\n========================================');
  console.log('🧠 处理完整 LCCC 数据集');
  console.log('========================================\n');
  
  loadEnv();
  
  // 解析命令行参数
  const maxArg = process.argv.find(a => a.startsWith('--max='));
  const maxSamples = maxArg ? parseInt(maxArg.split('=')[1]) : CONFIG.MAX_SAMPLES;
  
  console.log(`[配置]`);
  console.log(`  输入: ${CONFIG.LCCC_PATH}`);
  console.log(`  输出: ${CONFIG.OUTPUT_PATH}`);
  console.log(`  最大样本数: ${maxSamples.toLocaleString()}`);
  console.log(`  嵌入模型: ${process.env.EMBEDDING_MODEL || CONFIG.EMBEDDING_MODEL}`);
  console.log('');
  
  // 检查 API Key
  if (!process.env.EMBEDDING_API_KEY) {
    console.error('❌ EMBEDDING_API_KEY 未设置');
    process.exit(1);
  }
  
  // 创建输出目录
  if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
    fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
  }
  
  // 加载检查点
  let checkpoint = loadCheckpoint();
  let samples: BrainSample[] = checkpoint?.samples || [];
  let startIndex = checkpoint?.processedCount || 0;
  
  if (checkpoint) {
    console.log(`📂 从检查点恢复: 已处理 ${startIndex} 条\n`);
  }
  
  // 读取 LCCC 数据
  console.log('[读取] 加载 LCCC 数据...');
  const lcccRaw = fs.readFileSync(CONFIG.LCCC_PATH, 'utf-8');
  const lcccData: string[][] = JSON.parse(lcccRaw);
  console.log(`[读取] 总对话数: ${lcccData.length.toLocaleString()}`);
  
  // 提取对话对
  const dialoguePairs: Array<{ input: string; response: string }> = [];
  for (const dialogue of lcccData) {
    if (dialogue.length >= 2) {
      for (let i = 0; i < dialogue.length - 1; i++) {
        dialoguePairs.push({
          input: dialogue[i].replace(/ /g, ''),
          response: dialogue[i + 1].replace(/ /g, '')
        });
        if (dialoguePairs.length >= maxSamples) break;
      }
    }
    if (dialoguePairs.length >= maxSamples) break;
  }
  
  console.log(`[提取] 对话对数: ${dialoguePairs.length.toLocaleString()}`);
  console.log('');
  
  // 处理
  const startTime = Date.now();
  let errorCount = 0;
  
  for (let i = startIndex; i < dialoguePairs.length; i += CONFIG.BATCH_SIZE) {
    const batchEnd = Math.min(i + CONFIG.BATCH_SIZE, dialoguePairs.length);
    const batch = dialoguePairs.slice(i, batchEnd);
    
    try {
      // 获取嵌入
      const inputTexts = batch.map(p => p.input);
      const responseTexts = batch.map(p => p.response);
      
      const inputEmbeddings = await getEmbeddings(inputTexts);
      await delay(50);
      const responseEmbeddings = await getEmbeddings(responseTexts);
      
      // 生成样本
      for (let j = 0; j < batch.length; j++) {
        const pair = batch[j];
        const sample: BrainSample = {
          id: `lccc_${i + j}`,
          input: {
            stateVector: generateStateVector(),
            perceptionVector: generatePerceptionVector(pair.input),
            messageEmbedding: inputEmbeddings[j],
            memoryEmbedding: responseEmbeddings[j]
          },
          target: {
            direction: analyzeDirection(pair.input, pair.response),
            emotionType: analyzeEmotion(pair.response).type,
            emotionIntensity: analyzeEmotion(pair.response).intensity,
            strategyType: analyzeStrategy(pair.input, pair.response),
            tone: analyzeTone(pair.response),
            useMemory: Math.random() > 0.7,
            askBack: QUESTION_PATTERNS.some(p => p.test(pair.response)),
            useEmoji: EMOJI_PATTERNS.some(p => p.test(pair.response))
          },
          metadata: {
            inputText: pair.input,
            outputText: pair.response
          }
        };
        samples.push(sample);
      }
      
      // 进度
      const progress = ((i + batch.length) / dialoguePairs.length * 100).toFixed(1);
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (i + batch.length - startIndex) / elapsed;
      const remaining = (dialoguePairs.length - i - batch.length) / rate;
      
      process.stdout.write(`\r[处理] ${progress}% (${samples.length.toLocaleString()}/${dialoguePairs.length.toLocaleString()}) | ${rate.toFixed(1)}/s | 剩余 ${Math.ceil(remaining / 60)} 分钟   `);
      
      // 保存检查点
      if (samples.length % CONFIG.CHECKPOINT_INTERVAL === 0) {
        saveCheckpoint({ processedCount: samples.length, samples });
      }
      
    } catch (error) {
      errorCount++;
      console.error(`\n❌ 批次 ${i}-${batchEnd} 失败:`, error);
      saveCheckpoint({ processedCount: samples.length, samples });
      await delay(2000);
    }
    
    await delay(CONFIG.DELAY_MS);
  }
  
  console.log('\n');
  
  // 保存最终结果
  console.log('[保存] 写入最终结果...');
  const output = {
    metadata: {
      createdAt: Date.now(),
      totalSamples: samples.length,
      source: 'LCCC-base full',
      embeddingModel: process.env.EMBEDDING_MODEL || CONFIG.EMBEDDING_MODEL
    },
    samples
  };
  
  fs.writeFileSync(CONFIG.OUTPUT_PATH, JSON.stringify(output));
  
  // 删除检查点
  if (fs.existsSync(CONFIG.CHECKPOINT_PATH)) {
    fs.unlinkSync(CONFIG.CHECKPOINT_PATH);
  }
  
  // 同时复制一份到 D 盘供训练使用
  const localPath = path.join(__dirname, '..', 'data', 'training', 'brain-training-data.json');
  fs.copyFileSync(CONFIG.OUTPUT_PATH, localPath);
  
  console.log(`\n✅ 完成！`);
  console.log(`  样本数: ${samples.length.toLocaleString()}`);
  console.log(`  输出: ${CONFIG.OUTPUT_PATH}`);
  console.log(`  本地副本: ${localPath}`);
  console.log(`  错误数: ${errorCount}`);
}

// ==================== 入口 ====================

if (require.main === module) {
  processFullLCCC().catch(err => {
    console.error('处理失败:', err);
    process.exit(1);
  });
}

export { processFullLCCC };
