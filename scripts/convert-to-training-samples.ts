/**
 * 将标注后的伪场景结果转换为训练样本
 * 
 * 功能：
 * 1. 读取 data/pseudo-scenarios-results.json（已标注）
 * 2. 读取 memory-universe/src/testing/pseudo-scenarios.ts（场景定义）
 * 3. 转换为 TrainingSample[] 格式
 * 4. 保存到 data/training/samples.json
 * 
 * 使用方法：
 * npx ts-node --project memory-universe/tsconfig.json scripts/convert-to-training-samples.ts
 * 
 * 🧠 已迁移到 BrainNN v5.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { PSEUDO_SCENARIOS } from '../memory-universe/dist/testing/pseudo-scenarios';
import { BrainNNAdapter, getBrainNNAdapter } from '../memory-universe/dist/core/BrainNNAdapter';
import { CandidateGenerator } from '../memory-universe/dist/core/CandidateGenerator';
import { BehaviorType } from '../memory-universe/dist/types';

interface AnnotatedResult {
  scenarioId: number;
  scenarioName: string;
  category: string;
  top1Behavior: string;
  top1Probability: number;
  expectedBehavior: string;
  matchesExpected: boolean;
  forbiddenBehaviors: string[];
  hasForbidden: boolean;
  allBehaviors: Array<{ behaviorType: string; probability: number }>;
  manualRating?: '👍' | '😐' | '👎';
  notes?: string;
}

interface TrainingSample {
  features: {
    stateVector: number[];
    perceptionVector: number[];
    messageEmbedding: number[];
    memoryContextEmbedding: number[];
  };
  label: {
    selectedCandidate: string;
    candidateScores: Record<string, number>;
    wasRejected: boolean;
    riskHint: number;
  };
  metadata: {
    timestamp: number;
    turnId: string;
    quality: number;
    weight?: number;
    isNegative?: boolean;
    temperature?: number;
    scenarioId: number;
    manualRating?: '👍' | '😐' | '👎';
    notes?: string;
  };
}

/**
 * 将 manualRating 映射为 quality 分数
 */
function ratingToQuality(rating: '👍' | '😐' | '👎'): number {
  switch (rating) {
    case '👍': return 1.0;
    case '😐': return 0.5;
    case '👎': return 0.0;
    default: return 0.5;
  }
}

/**
 * 转换单个场景结果为训练样本
 */
async function convertToTrainingSample(
  result: AnnotatedResult,
  scenario: typeof PSEUDO_SCENARIOS[0]
): Promise<TrainingSample | null> {
  // 检查是否有标注
  if (!result.manualRating) {
    console.warn(`⚠️  场景${result.scenarioId} (${result.scenarioName}) 缺少 manualRating，跳过`);
    return null;
  }

  // 🧠 初始化 BrainNN v5.0 组件（用于生成特征向量）
  const brainNN = getBrainNNAdapter({ enableRuleFallback: true });
  const candidateGenerator = new CandidateGenerator();

  // 生成候选（用于获取 candidateScores）
  const memoryContext = {
    memoryIds: [],
    scores: [],
    allowedSnippets: [],
    summaryEmbedding: new Array(32).fill(0)
  };

  const allowedBehaviors: BehaviorType[] = [
    'reply_friendly',
    'reply_supportive',
    'reply_playful',
    'tease_light',
    'tease_heavy',
    'dodge',
    'silent',
    'topic_shift',
    'boundary_warning',
    'clarify_question',
    'proactive_recall_context',
    'proactive_recall_user',
    'narrate_self_recent',
    'meme_trigger',
    'analytical_answer_short',
    'emotional_resonate',
    'apology_soft',
    'refuse_safely'
  ] as BehaviorType[];

  const candidates = candidateGenerator.generateCandidates(
    allowedBehaviors,
    memoryContext,
    0.5,
    { maxVerbosity: 1.0, maxSarcasm: 0.5, maxRecallStrength: 0.6 }
  );

  // 构建特征向量
  const stateVector = new Array(20).fill(0); // 简化：使用零向量
  const perceptionVector = brainNN.createPerceptionVector(scenario.perception);
  const messageEmbedding = new Array(32).fill(0); // 简化：使用零向量
  const memoryContextEmbedding = new Array(32).fill(0); // 简化：使用零向量

  // 获取候选评分（用于对比学习）
  const policyOutput = await brainNN.evaluate(
    candidates,
    stateVector,
    perceptionVector,
    messageEmbedding,
    memoryContextEmbedding,
    scenario.perception,
    scenario.innerState,
    scenario.riskLevel
  );

  // 构建 candidateScores（所有候选的评分）
  const candidateScores: Record<string, number> = {};
  Object.entries(policyOutput.candidateProbabilities).forEach(([behaviorType, probability]) => {
    candidateScores[behaviorType] = probability;
  });

  // 构建训练样本
  const quality = ratingToQuality(result.manualRating);
  const isNegative = result.manualRating === '👎';
  const weight = quality; // 使用 quality 作为权重

  return {
    features: {
      stateVector,
      perceptionVector,
      messageEmbedding,
      memoryContextEmbedding
    },
    label: {
      selectedCandidate: scenario.expectedBehavior, // 使用期望行为作为标签
      candidateScores,
      wasRejected: isNegative, // 👎 标记为被拒绝
      riskHint: scenario.riskLevel
    },
    metadata: {
      timestamp: Date.now(),
      turnId: `scenario-${result.scenarioId}`,
      quality,
      weight,
      isNegative,
      temperature: 1.0,
      scenarioId: result.scenarioId,
      manualRating: result.manualRating,
      notes: result.notes
    }
  };
}

/**
 * 主转换函数
 */
async function convertToTrainingSamples() {
  console.log('🔄 开始转换标注数据为训练样本\n');
  console.log('='.repeat(80));

  // 读取标注结果
  const resultsPath = path.join(__dirname, '..', 'data', 'pseudo-scenarios-results.json');
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`标注结果文件不存在: ${resultsPath}`);
  }

  const results: AnnotatedResult[] = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));

  // 检查标注完整性
  const annotatedCount = results.filter(r => r.manualRating).length;
  const totalCount = results.length;

  console.log(`📊 标注统计:`);
  console.log(`   总场景数: ${totalCount}`);
  console.log(`   已标注: ${annotatedCount}`);
  console.log(`   未标注: ${totalCount - annotatedCount}`);

  if (annotatedCount === 0) {
    throw new Error('❌ 没有找到任何标注数据！请先完成人工标注。');
  }

  if (annotatedCount < totalCount) {
    console.warn(`\n⚠️  警告: 有 ${totalCount - annotatedCount} 个场景未标注，将跳过这些场景`);
  }

  // 统计标注分布
  const ratingDistribution = {
    '👍': results.filter(r => r.manualRating === '👍').length,
    '😐': results.filter(r => r.manualRating === '😐').length,
    '👎': results.filter(r => r.manualRating === '👎').length
  };

  console.log(`\n📊 标注分布:`);
  console.log(`   👍: ${ratingDistribution['👍']} (${(ratingDistribution['👍'] / annotatedCount * 100).toFixed(1)}%)`);
  console.log(`   😐: ${ratingDistribution['😐']} (${(ratingDistribution['😐'] / annotatedCount * 100).toFixed(1)}%)`);
  console.log(`   👎: ${ratingDistribution['👎']} (${(ratingDistribution['👎'] / annotatedCount * 100).toFixed(1)}%)`);

  // 检查数据质量
  const positiveRate = ratingDistribution['👍'] / annotatedCount;
  const negativeRate = ratingDistribution['👎'] / annotatedCount;

  console.log(`\n📊 数据质量检查:`);
  if (positiveRate < 0.3) {
    console.warn(`   ⚠️  👍比例 < 30%，建议增加正样本`);
  } else {
    console.log(`   ✅ 👍比例: ${(positiveRate * 100).toFixed(1)}%`);
  }

  if (negativeRate > 0.3) {
    console.warn(`   ⚠️  👎比例 > 30%，负样本可能过多`);
  } else {
    console.log(`   ✅ 👎比例: ${(negativeRate * 100).toFixed(1)}%`);
  }

  // 转换训练样本
  console.log(`\n🔄 开始转换训练样本...`);
  const trainingSamples: TrainingSample[] = [];

  for (const result of results) {
    if (!result.manualRating) {
      continue; // 跳过未标注的场景
    }

    const scenario = PSEUDO_SCENARIOS.find(s => s.id === result.scenarioId);
    if (!scenario) {
      console.warn(`⚠️  场景${result.scenarioId} 在场景定义中未找到，跳过`);
      continue;
    }

    const sample = await convertToTrainingSample(result, scenario);
    if (sample) {
      trainingSamples.push(sample);
    }
  }

  console.log(`✅ 成功转换 ${trainingSamples.length} 个训练样本`);

  // 保存训练样本
  const outputDir = path.join(__dirname, '..', 'data', 'training');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const samplesPath = path.join(outputDir, 'samples.json');
  fs.writeFileSync(
    samplesPath,
    JSON.stringify(trainingSamples, null, 2),
    'utf-8'
  );

  console.log(`✅ 训练样本已保存到: ${samplesPath}`);

  // 生成元数据
  const averageQuality = trainingSamples.reduce((sum, s) => sum + s.metadata.quality, 0) / trainingSamples.length;
  const categoryDistribution: Record<string, number> = {};
  results.forEach(r => {
    if (r.manualRating) {
      categoryDistribution[r.category] = (categoryDistribution[r.category] || 0) + 1;
    }
  });

  const metadata = {
    totalSamples: trainingSamples.length,
    ratingDistribution,
    qualityScore: {
      average: averageQuality,
      min: Math.min(...trainingSamples.map(s => s.metadata.quality)),
      max: Math.max(...trainingSamples.map(s => s.metadata.quality))
    },
    categoryDistribution,
    matchesExpected: results.filter(r => r.matchesExpected && r.manualRating).length,
    matchesExpectedRate: results.filter(r => r.matchesExpected && r.manualRating).length / annotatedCount,
    createdAt: new Date().toISOString(),
    source: 'pseudo-scenarios'
  };

  const metadataPath = path.join(outputDir, 'metadata.json');
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(metadata, null, 2),
    'utf-8'
  );

  console.log(`✅ 元数据已保存到: ${metadataPath}`);

  // 输出统计信息
  console.log(`\n📊 训练样本统计:`);
  console.log(`   总样本数: ${trainingSamples.length}`);
  console.log(`   平均质量: ${averageQuality.toFixed(3)}`);
  console.log(`   符合预期率: ${(metadata.matchesExpectedRate * 100).toFixed(1)}%`);

  // 检查训练前硬条件
  console.log(`\n📋 训练前硬条件检查:`);
  const checks = {
    dataCount: trainingSamples.length >= 30,
    allAnnotated: annotatedCount === totalCount,
    positiveRate: positiveRate >= 0.3,
    negativeRate: negativeRate <= 0.3,
    formatValid: trainingSamples.every(s => 
      s.features.stateVector.length === 20 &&
      s.features.perceptionVector.length === 8 &&
      s.features.messageEmbedding.length === 32 &&
      s.features.memoryContextEmbedding.length === 32
    )
  };

  Object.entries(checks).forEach(([key, passed]) => {
    const status = passed ? '✅' : '❌';
    console.log(`   ${status} ${key}: ${passed ? '通过' : '未通过'}`);
  });

  const allChecksPassed = Object.values(checks).every(v => v);
  if (allChecksPassed) {
    console.log(`\n✅ 所有硬条件检查通过！可以开始第一次离线训练。`);
  } else {
    console.log(`\n⚠️  部分硬条件未通过，建议先解决这些问题再开始训练。`);
  }

  console.log('\n' + '='.repeat(80));
}

// 运行转换
if (require.main === module) {
  convertToTrainingSamples().catch(error => {
    console.error('❌ 转换失败:', error);
    process.exit(1);
  });
}

export { convertToTrainingSamples, TrainingSample };

