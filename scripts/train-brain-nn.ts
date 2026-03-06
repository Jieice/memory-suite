/**
 * BrainNN 训练脚本
 * 
 * 训练真正的"智能大脑"，不只是行为分类器
 * 
 * 训练目标：
 * 1. 思考方向 (direction) - 回答/提问/分享/反应/回忆/忽略
 * 2. 情绪反应 (emotion) - 8种主要情绪 + 强度
 * 3. 回复策略 (strategy) - 7种策略类型 + 语气
 * 4. 记忆联想 (memory) - 是否使用记忆、联想类型
 */

import * as fs from 'fs';
import * as path from 'path';
import { BrainNN, getBrainNN, BrainOutput } from '../memory-universe/src/core/BrainNN';

// ==================== 配置 ====================

const CONFIG = {
  // 数据路径
  TRAINING_DATA_PATH: path.join(__dirname, '..', 'data', 'training', 'brain-training-data.json'),
  WEIGHTS_DIR: path.join(__dirname, '..', 'data', 'models'),
  WEIGHTS_PATH: path.join(__dirname, '..', 'data', 'models', 'brain-nn-weights.json'),
  BACKUP_PATH: path.join(__dirname, '..', 'data', 'models', 'brain-nn-weights.backup.json'),
  REPORT_PATH: path.join(__dirname, '..', 'data', 'models', 'brain-training-report.json'),
  
  // 训练参数
  EPOCHS: parseInt(process.env.BRAIN_TRAINING_EPOCHS || '10', 10),
  BATCH_SIZE: parseInt(process.env.BRAIN_TRAINING_BATCH_SIZE || '32', 10),
  LEARNING_RATE: parseFloat(process.env.BRAIN_TRAINING_LR || '0.0005'),
  LR_DECAY: 0.95,
  MIN_LR: 0.00001,
  
  // 数据要求
  MIN_SAMPLES: parseInt(process.env.BRAIN_MIN_SAMPLES || '100', 10),
  VALIDATION_SPLIT: 0.15,
  
  // 维度
  STATE_DIM: 27,
  PERCEPTION_DIM: 8,
  EMBEDDING_DIM: 1024,
};

// ==================== 类型定义 ====================

/** 训练样本 */
interface BrainTrainingSample {
  id: string;
  // 输入
  input: {
    stateVector: number[];
    perceptionVector: number[];
    messageEmbedding: number[];
    memoryEmbedding: number[];
  };
  // 目标输出
  target: {
    // 思考方向
    direction: 'answer' | 'question' | 'share' | 'react' | 'recall' | 'ignore';
    // 主要情绪
    emotionType: 'joy' | 'curiosity' | 'empathy' | 'surprise' | 'concern' | 'playful' | 'calm' | 'annoyed';
    emotionIntensity: number;
    // 策略
    strategyType: 'direct_answer' | 'share_experience' | 'ask_back' | 'empathize' | 'joke' | 'deflect' | 'silent';
    tone: 'warm' | 'playful' | 'serious' | 'curious' | 'supportive' | 'teasing';
    // 记忆使用
    useMemory: boolean;
    askBack: boolean;
    useEmoji: boolean;
  };
  // 元数据
  metadata?: {
    source?: string;
    quality?: number;
    inputText?: string;
    outputText?: string;
  };
}

interface TrainingDataset {
  samples: BrainTrainingSample[];
  metadata?: {
    createdAt?: number;
    version?: string;
    description?: string;
  };
}


// ==================== 工具函数 ====================

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function padArray(arr: number[], len: number): number[] {
  if (!arr || arr.length === 0) return new Array(len).fill(0);
  if (arr.length >= len) return arr.slice(0, len);
  const padded = new Array(len).fill(0);
  for (let i = 0; i < arr.length; i++) padded[i] = arr[i] || 0;
  return padded;
}

// ==================== 损失计算 ====================

const DIRECTIONS = ['answer', 'question', 'share', 'react', 'recall', 'ignore'] as const;
const EMOTIONS = ['joy', 'curiosity', 'empathy', 'surprise', 'concern', 'playful', 'calm', 'annoyed'] as const;
const STRATEGIES = ['direct_answer', 'share_experience', 'ask_back', 'empathize', 'joke', 'deflect', 'silent'] as const;
const TONES = ['warm', 'playful', 'serious', 'curious', 'supportive', 'teasing'] as const;

function softmax(x: number[]): number[] {
  const max = Math.max(...x);
  const exp = x.map(v => Math.exp(Math.min(v - max, 50)));
  const sum = exp.reduce((a, b) => a + b, 0) + 1e-8;
  return exp.map(v => v / sum);
}

function crossEntropyLoss(probs: number[], targetIdx: number): number {
  const p = Math.max(probs[targetIdx], 1e-7);
  return -Math.log(p);
}

function binaryLoss(prob: number, target: boolean): number {
  const t = target ? 1 : 0;
  const p = Math.max(Math.min(prob, 1 - 1e-7), 1e-7);
  return -(t * Math.log(p) + (1 - t) * Math.log(1 - p));
}

function mseLoss(pred: number, target: number): number {
  return (pred - target) ** 2;
}

/** 计算单个样本的总损失 */
function computeSampleLoss(output: BrainOutput, target: BrainTrainingSample['target']): {
  total: number;
  direction: number;
  emotion: number;
  strategy: number;
  auxiliary: number;
} {
  // 1. 方向损失
  const directionIdx = DIRECTIONS.indexOf(target.direction);
  const directionProbs = Object.values(output.thinking.topics).length > 0 
    ? softmax(DIRECTIONS.map((_, i) => i === directionIdx ? 1 : 0))
    : new Array(6).fill(1/6);
  const directionLoss = directionIdx >= 0 ? crossEntropyLoss(
    softmax(DIRECTIONS.map(d => d === output.thinking.direction ? 1 : 0)),
    directionIdx
  ) : 0;
  
  // 2. 情绪损失
  const emotionIdx = EMOTIONS.indexOf(target.emotionType);
  const emotionTypeLoss = emotionIdx >= 0 ? crossEntropyLoss(
    softmax(EMOTIONS.map(e => e === output.emotion.primary.type ? 1 : 0)),
    emotionIdx
  ) : 0;
  const emotionIntensityLoss = mseLoss(output.emotion.primary.intensity, target.emotionIntensity);
  const emotionLoss = emotionTypeLoss + emotionIntensityLoss * 0.5;
  
  // 3. 策略损失
  const strategyIdx = STRATEGIES.indexOf(target.strategyType);
  const strategyTypeLoss = strategyIdx >= 0 ? crossEntropyLoss(
    softmax(STRATEGIES.map(s => s === output.strategy.type ? 1 : 0)),
    strategyIdx
  ) : 0;
  const toneIdx = TONES.indexOf(target.tone);
  const toneLoss = toneIdx >= 0 ? crossEntropyLoss(
    softmax(TONES.map(t => t === output.strategy.tone ? 1 : 0)),
    toneIdx
  ) : 0;
  const strategyLoss = strategyTypeLoss + toneLoss * 0.5;
  
  // 4. 辅助损失（布尔值）
  const useMemoryLoss = binaryLoss(output.strategy.useMemory ? 0.9 : 0.1, target.useMemory);
  const askBackLoss = binaryLoss(output.strategy.askBack ? 0.9 : 0.1, target.askBack);
  const useEmojiLoss = binaryLoss(output.strategy.useEmoji ? 0.9 : 0.1, target.useEmoji);
  const auxiliaryLoss = (useMemoryLoss + askBackLoss + useEmojiLoss) / 3;
  
  // 总损失（加权）
  const total = directionLoss * 1.0 + emotionLoss * 0.8 + strategyLoss * 1.0 + auxiliaryLoss * 0.3;
  
  return {
    total,
    direction: directionLoss,
    emotion: emotionLoss,
    strategy: strategyLoss,
    auxiliary: auxiliaryLoss
  };
}


// ==================== 准确率计算 ====================

function computeAccuracy(output: BrainOutput, target: BrainTrainingSample['target']): {
  direction: boolean;
  emotion: boolean;
  strategy: boolean;
  tone: boolean;
  overall: number;
} {
  const directionCorrect = output.thinking.direction === target.direction;
  const emotionCorrect = output.emotion.primary.type === target.emotionType;
  const strategyCorrect = output.strategy.type === target.strategyType;
  const toneCorrect = output.strategy.tone === target.tone;
  
  const correctCount = [directionCorrect, emotionCorrect, strategyCorrect, toneCorrect]
    .filter(x => x).length;
  
  return {
    direction: directionCorrect,
    emotion: emotionCorrect,
    strategy: strategyCorrect,
    tone: toneCorrect,
    overall: correctCount / 4
  };
}

// ==================== 训练核心 ====================

class BrainNNTrainer {
  private brainNN: BrainNN;
  private trainingStep: number = 0;
  
  constructor() {
    this.brainNN = getBrainNN();
  }
  
  /** 加载训练数据 */
  loadTrainingData(): TrainingDataset {
    if (!fs.existsSync(CONFIG.TRAINING_DATA_PATH)) {
      throw new Error(`训练数据不存在: ${CONFIG.TRAINING_DATA_PATH}`);
    }
    
    const text = fs.readFileSync(CONFIG.TRAINING_DATA_PATH, 'utf-8').replace(/^\uFEFF/, '');
    const data = JSON.parse(text) as TrainingDataset;
    
    if (!data.samples || !Array.isArray(data.samples)) {
      throw new Error('训练数据格式错误：缺少 samples 数组');
    }
    
    console.log(`[BrainNN] 加载训练数据: ${data.samples.length} 样本`);
    return data;
  }
  
  /** 加载已有权重 */
  loadExistingWeights(): boolean {
    if (!fs.existsSync(CONFIG.WEIGHTS_PATH)) {
      console.log('[BrainNN] 未找到已有权重，使用随机初始化');
      return false;
    }
    
    try {
      const text = fs.readFileSync(CONFIG.WEIGHTS_PATH, 'utf-8').replace(/^\uFEFF/, '');
      const data = JSON.parse(text);
      const weights = data.weights || data;
      this.brainNN.loadWeights(weights);
      console.log(`[BrainNN] 加载已有权重: ${CONFIG.WEIGHTS_PATH}`);
      return true;
    } catch (err) {
      console.warn('[BrainNN] 加载权重失败，使用随机初始化');
      return false;
    }
  }
  
  /** 备份权重 */
  backupWeights(): void {
    if (!fs.existsSync(CONFIG.WEIGHTS_PATH)) return;
    
    const weights = this.brainNN.exportWeights();
    writeJsonAtomic(CONFIG.BACKUP_PATH, {
      timestamp: Date.now(),
      weights,
      note: 'auto backup before training'
    });
    console.log(`[BrainNN] 权重已备份: ${CONFIG.BACKUP_PATH}`);
  }
  
  /** 保存权重 */
  saveWeights(note: string): void {
    if (!fs.existsSync(CONFIG.WEIGHTS_DIR)) {
      fs.mkdirSync(CONFIG.WEIGHTS_DIR, { recursive: true });
    }
    
    const weights = this.brainNN.exportWeights();
    writeJsonAtomic(CONFIG.WEIGHTS_PATH, {
      modelVersion: this.brainNN.getModelVersion(),
      timestamp: Date.now(),
      trainingStep: this.trainingStep,
      weights,
      metadata: { note }
    });
    console.log(`[BrainNN] 权重已保存: ${CONFIG.WEIGHTS_PATH}`);
  }
  
  /** 恢复备份 */
  restoreBackup(): void {
    if (!fs.existsSync(CONFIG.BACKUP_PATH)) {
      throw new Error('备份文件不存在');
    }
    
    const text = fs.readFileSync(CONFIG.BACKUP_PATH, 'utf-8');
    const data = JSON.parse(text);
    this.brainNN.loadWeights(data.weights);
    this.saveWeights('restored from backup');
    console.log('[BrainNN] 已从备份恢复');
  }
  
  /** 评估模型 */
  evaluate(samples: BrainTrainingSample[]): {
    avgLoss: number;
    accuracy: {
      direction: number;
      emotion: number;
      strategy: number;
      tone: number;
      overall: number;
    };
  } {
    let totalLoss = 0;
    let directionCorrect = 0;
    let emotionCorrect = 0;
    let strategyCorrect = 0;
    let toneCorrect = 0;
    
    for (const sample of samples) {
      const output = this.brainNN.think(
        padArray(sample.input.stateVector, CONFIG.STATE_DIM),
        padArray(sample.input.perceptionVector, CONFIG.PERCEPTION_DIM),
        padArray(sample.input.messageEmbedding, CONFIG.EMBEDDING_DIM),
        padArray(sample.input.memoryEmbedding, CONFIG.EMBEDDING_DIM)
      );
      
      const loss = computeSampleLoss(output, sample.target);
      totalLoss += loss.total;
      
      const acc = computeAccuracy(output, sample.target);
      if (acc.direction) directionCorrect++;
      if (acc.emotion) emotionCorrect++;
      if (acc.strategy) strategyCorrect++;
      if (acc.tone) toneCorrect++;
    }
    
    const n = samples.length;
    return {
      avgLoss: totalLoss / n,
      accuracy: {
        direction: directionCorrect / n,
        emotion: emotionCorrect / n,
        strategy: strategyCorrect / n,
        tone: toneCorrect / n,
        overall: (directionCorrect + emotionCorrect + strategyCorrect + toneCorrect) / (n * 4)
      }
    };
  }

  
  /** 训练一个 epoch */
  trainEpoch(samples: BrainTrainingSample[], lr: number): number {
    const shuffled = shuffleArray(samples);
    let totalLoss = 0;
    let batchCount = 0;
    
    for (let i = 0; i < shuffled.length; i += CONFIG.BATCH_SIZE) {
      const batch = shuffled.slice(i, i + CONFIG.BATCH_SIZE);
      let batchLoss = 0;
      
      for (const sample of batch) {
        // 前向传播
        const output = this.brainNN.think(
          padArray(sample.input.stateVector, CONFIG.STATE_DIM),
          padArray(sample.input.perceptionVector, CONFIG.PERCEPTION_DIM),
          padArray(sample.input.messageEmbedding, CONFIG.EMBEDDING_DIM),
          padArray(sample.input.memoryEmbedding, CONFIG.EMBEDDING_DIM)
        );
        
        // 计算损失
        const loss = computeSampleLoss(output, sample.target);
        batchLoss += loss.total;
        
        // 训练（使用 BrainNN 的内置训练方法）
        this.brainNN.trainOneSample(
          padArray(sample.input.stateVector, CONFIG.STATE_DIM),
          padArray(sample.input.perceptionVector, CONFIG.PERCEPTION_DIM),
          padArray(sample.input.messageEmbedding, CONFIG.EMBEDDING_DIM),
          padArray(sample.input.memoryEmbedding, CONFIG.EMBEDDING_DIM),
          {
            strategy: {
              type: sample.target.strategyType,
              tone: sample.target.tone,
              lengthHint: 100,
              useMemory: sample.target.useMemory,
              askBack: sample.target.askBack,
              useEmoji: sample.target.useEmoji,
              contentGuide: { opening: 'direct', keyPoints: [], closing: 'none' }
            },
            thinking: {
              topics: {},
              keywords: {},
              direction: sample.target.direction,
              depth: 0.5
            },
            emotion: {
              primary: { type: sample.target.emotionType, intensity: sample.target.emotionIntensity },
              trend: 'stable',
              shouldExpress: sample.target.emotionIntensity > 0.5
            }
          },
          lr
        );
        
        this.trainingStep++;
      }
      
      totalLoss += batchLoss;
      batchCount++;
    }
    
    return totalLoss / samples.length;
  }
  
  /** 完整训练流程 */
  async train(): Promise<void> {
    console.log('\n========================================');
    console.log('🧠 BrainNN 训练开始');
    console.log('========================================\n');
    
    // 1. 加载数据
    const dataset = this.loadTrainingData();
    
    if (dataset.samples.length < CONFIG.MIN_SAMPLES) {
      throw new Error(`样本数量不足: ${dataset.samples.length} < ${CONFIG.MIN_SAMPLES}`);
    }
    
    // 2. 划分训练集/验证集
    const shuffled = shuffleArray(dataset.samples);
    const valSize = Math.floor(shuffled.length * CONFIG.VALIDATION_SPLIT);
    const valSet = shuffled.slice(0, valSize);
    const trainSet = shuffled.slice(valSize);
    
    console.log(`[BrainNN] 训练集: ${trainSet.length} 样本`);
    console.log(`[BrainNN] 验证集: ${valSet.length} 样本`);
    
    // 3. 加载已有权重
    this.loadExistingWeights();
    
    // 4. 备份
    this.backupWeights();
    
    // 5. 训练前评估
    console.log('\n[BrainNN] 训练前评估...');
    const beforeMetrics = this.evaluate(valSet);
    console.log(`  损失: ${beforeMetrics.avgLoss.toFixed(4)}`);
    console.log(`  准确率: 方向=${(beforeMetrics.accuracy.direction * 100).toFixed(1)}% 情绪=${(beforeMetrics.accuracy.emotion * 100).toFixed(1)}% 策略=${(beforeMetrics.accuracy.strategy * 100).toFixed(1)}% 语气=${(beforeMetrics.accuracy.tone * 100).toFixed(1)}%`);
    console.log(`  总体准确率: ${(beforeMetrics.accuracy.overall * 100).toFixed(1)}%`);
    
    // 6. 训练
    console.log(`\n[BrainNN] 开始训练 epochs=${CONFIG.EPOCHS} lr=${CONFIG.LEARNING_RATE} batch=${CONFIG.BATCH_SIZE}`);
    
    let lr = CONFIG.LEARNING_RATE;
    let bestLoss = beforeMetrics.avgLoss;
    let bestEpoch = 0;
    
    for (let epoch = 1; epoch <= CONFIG.EPOCHS; epoch++) {
      const epochLoss = this.trainEpoch(trainSet, lr);
      
      // 验证
      const valMetrics = this.evaluate(valSet);
      
      console.log(`[Epoch ${epoch}/${CONFIG.EPOCHS}] train_loss=${epochLoss.toFixed(4)} val_loss=${valMetrics.avgLoss.toFixed(4)} val_acc=${(valMetrics.accuracy.overall * 100).toFixed(1)}% lr=${lr.toFixed(6)}`);
      
      // 保存最佳模型
      if (valMetrics.avgLoss < bestLoss) {
        bestLoss = valMetrics.avgLoss;
        bestEpoch = epoch;
        this.saveWeights(`best model at epoch ${epoch}`);
      }
      
      // 学习率衰减
      lr = Math.max(lr * CONFIG.LR_DECAY, CONFIG.MIN_LR);
    }
    
    // 7. 训练后评估
    console.log('\n[BrainNN] 训练后评估...');
    const afterMetrics = this.evaluate(valSet);
    console.log(`  损失: ${afterMetrics.avgLoss.toFixed(4)} (${beforeMetrics.avgLoss > afterMetrics.avgLoss ? '↓' : '↑'}${Math.abs(beforeMetrics.avgLoss - afterMetrics.avgLoss).toFixed(4)})`);
    console.log(`  准确率: 方向=${(afterMetrics.accuracy.direction * 100).toFixed(1)}% 情绪=${(afterMetrics.accuracy.emotion * 100).toFixed(1)}% 策略=${(afterMetrics.accuracy.strategy * 100).toFixed(1)}% 语气=${(afterMetrics.accuracy.tone * 100).toFixed(1)}%`);
    console.log(`  总体准确率: ${(afterMetrics.accuracy.overall * 100).toFixed(1)}% (${beforeMetrics.accuracy.overall < afterMetrics.accuracy.overall ? '↑' : '↓'}${Math.abs(afterMetrics.accuracy.overall - beforeMetrics.accuracy.overall) * 100}%)`);
    
    // 8. 保存报告
    const report = {
      timestamp: Date.now(),
      config: CONFIG,
      dataset: {
        total: dataset.samples.length,
        train: trainSet.length,
        val: valSet.length
      },
      before: beforeMetrics,
      after: afterMetrics,
      bestEpoch,
      bestLoss,
      improvement: {
        loss: beforeMetrics.avgLoss - afterMetrics.avgLoss,
        accuracy: afterMetrics.accuracy.overall - beforeMetrics.accuracy.overall
      },
      success: afterMetrics.avgLoss < beforeMetrics.avgLoss
    };
    
    writeJsonAtomic(CONFIG.REPORT_PATH, report);
    console.log(`\n[BrainNN] 训练报告已保存: ${CONFIG.REPORT_PATH}`);
    
    // 9. 判断是否成功
    if (report.success) {
      console.log('\n✅ 训练成功！模型已改进。');
    } else {
      console.log('\n⚠️ 训练未能改进模型，已保留最佳权重。');
    }
    
    console.log('\n========================================');
    console.log('🧠 BrainNN 训练完成');
    console.log('========================================\n');
  }
}

// ==================== 主入口 ====================

async function main() {
  const trainer = new BrainNNTrainer();
  
  try {
    await trainer.train();
  } catch (error) {
    console.error('[BrainNN] 训练失败:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { BrainNNTrainer, BrainTrainingSample, TrainingDataset };
