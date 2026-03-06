/**
 * 规则引擎验证脚本
 * 验证规则引擎是否在冷启动期主导行为决策
 * 
 * 测试配置：
 * A: 规则开启，nnWeight = 0.1
 * B: 规则关闭（enabled = false）
 * C: 规则开启，nnWeight = 0.3
 * 
 * 🧠 已迁移到 BrainNN v5.0
 */

// 使用编译后的dist目录
import * as path from 'path';
import { RuleEngine, RuleConfig } from '../memory-universe/dist/core/RuleEngine';
import { BrainNNAdapter, getBrainNNAdapter } from '../memory-universe/dist/core/BrainNNAdapter';
import { CandidateGenerator } from '../memory-universe/dist/core/CandidateGenerator';
import { Perception, InnerState, BehaviorType, Candidate } from '../memory-universe/dist/types';

interface TestConfig {
  name: string;
  ruleConfig: Partial<RuleConfig>;
}

interface TestResult {
  config: string;
  scenario: string;
  top3Behaviors: Array<{ behaviorType: string; probability: number; ruleBias?: number; nnScore?: number }>;
  allBehaviors: Record<string, { probability: number; ruleBias?: number; nnScore?: number }>;
}

/**
 * 测试配置
 */
const TEST_CONFIGS: TestConfig[] = [
  {
    name: 'A: 规则开启，nnWeight=0.1',
    ruleConfig: { nnWeight: 0.1, enabled: true }
  },
  {
    name: 'B: 规则关闭',
    ruleConfig: { enabled: false }
  },
  {
    name: 'C: 规则开启，nnWeight=0.3',
    ruleConfig: { nnWeight: 0.3, enabled: true }
  }
];

/**
 * 测试场景定义
 */
const TEST_SCENARIOS = [
  {
    name: '场景1: 正常对话+正面情绪',
    perception: {
      intent: 'statement',
      sentiment: 0.6,
      riskHint: 0.1,
      entities: ['观众', '直播'],
      confidence: 0.8
    } as Perception,
    innerState: {
      emotion: { joy: 0.7, sadness: 0.1, anger: 0.0, curiosity: 0.6, fatigue: 0.2 },
      persona: { energy: 0.8, talkativeness: 0.7, openness: 0.6, willingness: 0.7, mood: 'cheerful' as const },
      audience: { excited: 0.6, bored: 0.2, tense: 0.1 },
      conflict: { hesitation: 0.1, turmoil: 0.0, decisionDifficulty: 0.1 },
      mode: 'normal' as const
    } as InnerState,
    riskLevel: 0.1
  },
  {
    name: '场景2: 高风险场景',
    perception: {
      intent: 'request',
      sentiment: 0.0,
      riskHint: 0.7,
      entities: ['敏感话题'],
      confidence: 0.5
    } as Perception,
    innerState: {
      emotion: { joy: 0.3, sadness: 0.2, anger: 0.1, curiosity: 0.4, fatigue: 0.3 },
      persona: { energy: 0.5, talkativeness: 0.4, openness: 0.3, willingness: 0.4, mood: 'calm' as const },
      audience: { excited: 0.3, bored: 0.4, tense: 0.6 },
      conflict: { hesitation: 0.5, turmoil: 0.3, decisionDifficulty: 0.4 },
      mode: 'normal' as const
    } as InnerState,
    riskLevel: 0.7
  },
  {
    name: '场景3: 负面情绪（需要共情）',
    perception: {
      intent: 'statement',
      sentiment: -0.5,
      riskHint: 0.2,
      entities: ['观众', '情绪'],
      confidence: 0.7
    } as Perception,
    innerState: {
      emotion: { joy: 0.2, sadness: 0.6, anger: 0.1, curiosity: 0.3, fatigue: 0.4 },
      persona: { energy: 0.4, talkativeness: 0.5, openness: 0.7, willingness: 0.6, mood: 'calm' as const },
      audience: { excited: 0.2, bored: 0.3, tense: 0.4 },
      conflict: { hesitation: 0.2, turmoil: 0.3, decisionDifficulty: 0.2 },
      mode: 'emotional' as const
    } as InnerState,
    riskLevel: 0.2
  },
  {
    name: '场景4: 提问意图',
    perception: {
      intent: 'question',
      sentiment: 0.3,
      riskHint: 0.15,
      entities: ['问题'],
      confidence: 0.8
    } as Perception,
    innerState: {
      emotion: { joy: 0.5, sadness: 0.1, anger: 0.0, curiosity: 0.8, fatigue: 0.2 },
      persona: { energy: 0.7, talkativeness: 0.6, openness: 0.8, willingness: 0.7, mood: 'focused' as const },
      audience: { excited: 0.5, bored: 0.3, tense: 0.1 },
      conflict: { hesitation: 0.1, turmoil: 0.0, decisionDifficulty: 0.1 },
      mode: 'analytical' as const
    } as InnerState,
    riskLevel: 0.15
  },
  {
    name: '场景5: 观众无聊（需要活跃气氛）',
    perception: {
      intent: 'statement',
      sentiment: 0.1,
      riskHint: 0.1,
      entities: ['观众'],
      confidence: 0.6
    } as Perception,
    innerState: {
      emotion: { joy: 0.4, sadness: 0.2, anger: 0.0, curiosity: 0.5, fatigue: 0.3 },
      persona: { energy: 0.6, talkativeness: 0.7, openness: 0.6, willingness: 0.7, mood: 'cheerful' as const },
      audience: { excited: 0.2, bored: 0.8, tense: 0.1 },
      conflict: { hesitation: 0.1, turmoil: 0.0, decisionDifficulty: 0.1 },
      mode: 'normal' as const
    } as InnerState,
    riskLevel: 0.1
  }
];

/**
 * 运行单个测试
 */
async function runSingleTest(
  config: TestConfig,
  scenario: typeof TEST_SCENARIOS[0]
): Promise<TestResult> {
  // 🧠 初始化 BrainNN v5.0 组件
  const brainNN = getBrainNNAdapter({ enableRuleFallback: config.ruleConfig.enabled !== false });
  const ruleEngine = new RuleEngine(config.ruleConfig);
  const candidateGenerator = new CandidateGenerator();

  // 生成候选
  const memoryContext = {
    memoryIds: [],
    scores: [],
    allowedSnippets: [],
    summaryEmbedding: new Array(32).fill(0)
  };

    const allowedBehaviors: BehaviorType[] = [
      'reply_friendly' as BehaviorType,
      'reply_supportive' as BehaviorType,
      'reply_playful' as BehaviorType,
      'tease_light' as BehaviorType,
      'dodge' as BehaviorType,
      'silent' as BehaviorType,
      'topic_shift' as BehaviorType,
      'boundary_warning' as BehaviorType,
      'clarify_question' as BehaviorType,
      'proactive_recall_context' as BehaviorType,
      'meme_trigger' as BehaviorType,
      'analytical_answer_short' as BehaviorType,
      'emotional_resonate' as BehaviorType
    ];

  const candidates = candidateGenerator.generateCandidates(
    allowedBehaviors,
    memoryContext,
    0.5,
    { maxVerbosity: 1.0, maxSarcasm: 0.5, maxRecallStrength: 0.6 }
  );

  // 计算规则偏置（如果规则开启）
  let ruleBiases: Map<BehaviorType, { behaviorType: BehaviorType; bias: number; reasoning: string }> | null = null;
  if (config.ruleConfig.enabled !== false) {
    ruleBiases = ruleEngine.calculateRuleBiases(
      candidates,
      scenario.perception,
      scenario.innerState,
      scenario.riskLevel
    );
  }

  // 模拟NN评分（需要先获取纯NN评分）
  const stateVector = new Array(20).fill(0);
  const perceptionVector = new Array(8).fill(0);
  const messageEmbedding = new Array(32).fill(0);
  const memoryContextEmbedding = new Array(32).fill(0);

  // 获取纯NN评分（通过临时禁用规则）
  const tempBrainNN = getBrainNNAdapter({ enableRuleFallback: false });
  const nnOnlyOutput = await tempBrainNN.evaluate(
    candidates,
    stateVector,
    perceptionVector,
    messageEmbedding,
    memoryContextEmbedding
  );

  // 获取混合评分
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

  // 构建结果
  const allBehaviors: Record<string, { probability: number; ruleBias?: number; nnScore?: number }> = {};
  
  Object.entries(policyOutput.candidateProbabilities).forEach(([behaviorType, probability]) => {
    const ruleBias = ruleBiases?.get(behaviorType as BehaviorType);
    const nnScore = nnOnlyOutput.candidateProbabilities[behaviorType];
    
    allBehaviors[behaviorType] = {
      probability,
      ruleBias: ruleBias?.bias,
      nnScore
    };
  });

  // 获取Top-3
  const top3Behaviors = Object.entries(allBehaviors)
    .sort((a, b) => b[1].probability - a[1].probability)
    .slice(0, 3)
    .map(([behaviorType, data]) => ({
      behaviorType,
      ...data
    }));

  return {
    config: config.name,
    scenario: scenario.name,
    top3Behaviors,
    allBehaviors
  };
}

/**
 * 计算行为分布差异
 */
function calculateDistributionDifference(
  resultA: TestResult,
  resultB: TestResult
): number {
  // 计算KL散度（简化版：概率分布的差异）
  let diff = 0;
  const allBehaviors = new Set([
    ...Object.keys(resultA.allBehaviors),
    ...Object.keys(resultB.allBehaviors)
  ]);

  allBehaviors.forEach(behaviorType => {
    const probA = resultA.allBehaviors[behaviorType]?.probability || 0;
    const probB = resultB.allBehaviors[behaviorType]?.probability || 0;
    diff += Math.abs(probA - probB);
  });

  return diff / 2; // 归一化到[0, 1]
}

/**
 * 主测试函数
 */
async function runValidation() {
  console.log('🔬 开始规则引擎验证测试\n');
  console.log('='.repeat(80));
  console.log('测试目标: 验证规则引擎是否在冷启动期主导行为决策');
  console.log('='.repeat(80));
  console.log();

  const allResults: TestResult[] = [];

  // 对每个场景运行所有配置
  for (const scenario of TEST_SCENARIOS) {
    console.log(`\n📋 ${scenario.name}`);
    console.log('-'.repeat(80));

    for (const config of TEST_CONFIGS) {
      const result = await runSingleTest(config, scenario);
      allResults.push(result);

      console.log(`\n${config.name}:`);
      console.log(`  Top-3 行为:`);
      result.top3Behaviors.forEach((item, idx) => {
        const biasInfo = item.ruleBias !== undefined ? ` [规则偏置: ${item.ruleBias.toFixed(2)}]` : '';
        const nnInfo = item.nnScore !== undefined ? ` [NN评分: ${item.nnScore.toFixed(3)}]` : '';
        console.log(`    ${idx + 1}. ${item.behaviorType.padEnd(25)} 概率: ${item.probability.toFixed(3)}${biasInfo}${nnInfo}`);
      });
    }
  }

  // 分析结果
  console.log('\n\n' + '='.repeat(80));
  console.log('📊 对比分析');
  console.log('='.repeat(80));

  // 按场景分组
  const resultsByScenario = new Map<string, TestResult[]>();
  allResults.forEach(result => {
    if (!resultsByScenario.has(result.scenario)) {
      resultsByScenario.set(result.scenario, []);
    }
    resultsByScenario.get(result.scenario)!.push(result);
  });

  // 对每个场景进行对比
  const scenarioAnalyses: Array<{
    scenario: string;
    diffAB: number;
    diffAC: number;
    top3A: string[];
    top3B: string[];
    top3C: string[];
  }> = [];

  resultsByScenario.forEach((results, scenarioName) => {
    const resultA = results.find(r => r.config.includes('nnWeight=0.1') && r.config.includes('规则开启'))!;
    const resultB = results.find(r => r.config.includes('规则关闭'))!;
    const resultC = results.find(r => r.config.includes('nnWeight=0.3') && r.config.includes('规则开启'))!;

    const diffAB = calculateDistributionDifference(resultA, resultB);
    const diffAC = calculateDistributionDifference(resultA, resultC);

    scenarioAnalyses.push({
      scenario: scenarioName,
      diffAB,
      diffAC,
      top3A: resultA.top3Behaviors.map(b => b.behaviorType),
      top3B: resultB.top3Behaviors.map(b => b.behaviorType),
      top3C: resultC.top3Behaviors.map(b => b.behaviorType)
    });
  });

  // 输出对比表格
  console.log('\n📋 场景对比表格');
  console.log('-'.repeat(80));
  console.log('场景'.padEnd(30) + 'A vs B差异'.padEnd(15) + 'A vs C差异'.padEnd(15) + 'Top-3一致性');
  console.log('-'.repeat(80));

  scenarioAnalyses.forEach(analysis => {
    const consistency = analysis.top3A.filter(b => analysis.top3B.includes(b)).length;
    console.log(
      analysis.scenario.padEnd(30) +
      analysis.diffAB.toFixed(3).padEnd(15) +
      analysis.diffAC.toFixed(3).padEnd(15) +
      `${consistency}/3`
    );
  });

  // 详细对比表格
  console.log('\n📋 详细行为分布对比（场景1示例）');
  console.log('-'.repeat(80));
  const scenario1Results = resultsByScenario.get(TEST_SCENARIOS[0].name)!;
  const resultA1 = scenario1Results.find(r => r.config.includes('nnWeight=0.1') && r.config.includes('规则开启'))!;
  const resultB1 = scenario1Results.find(r => r.config.includes('规则关闭'))!;
  const resultC1 = scenario1Results.find(r => r.config.includes('nnWeight=0.3') && r.config.includes('规则开启'))!;

  const allBehaviors1 = new Set([
    ...Object.keys(resultA1.allBehaviors),
    ...Object.keys(resultB1.allBehaviors),
    ...Object.keys(resultC1.allBehaviors)
  ]);

  console.log('行为类型'.padEnd(25) + 'A(规则0.1)'.padEnd(15) + 'B(规则关闭)'.padEnd(15) + 'C(规则0.3)'.padEnd(15) + '规则偏置');
  console.log('-'.repeat(80));

  Array.from(allBehaviors1).sort().forEach(behaviorType => {
    const probA = resultA1.allBehaviors[behaviorType]?.probability || 0;
    const probB = resultB1.allBehaviors[behaviorType]?.probability || 0;
    const probC = resultC1.allBehaviors[behaviorType]?.probability || 0;
    const bias = resultA1.allBehaviors[behaviorType]?.ruleBias;

    const biasStr = bias !== undefined ? bias.toFixed(2) : 'N/A';
    console.log(
      behaviorType.padEnd(25) +
      probA.toFixed(3).padEnd(15) +
      probB.toFixed(3).padEnd(15) +
      probC.toFixed(3).padEnd(15) +
      biasStr
    );
  });

  // 计算总体统计
  const avgDiffAB = scenarioAnalyses.reduce((sum, a) => sum + a.diffAB, 0) / scenarioAnalyses.length;
  const avgDiffAC = scenarioAnalyses.reduce((sum, a) => sum + a.diffAC, 0) / scenarioAnalyses.length;

  console.log('\n\n' + '='.repeat(80));
  console.log('📈 统计摘要');
  console.log('='.repeat(80));
  console.log(`平均 A vs B 差异: ${avgDiffAB.toFixed(3)}`);
  console.log(`平均 A vs C 差异: ${avgDiffAC.toFixed(3)}`);

  // 判断标准
  console.log('\n\n' + '='.repeat(80));
  console.log('✅ 判断结论');
  console.log('='.repeat(80));

  const ruleEffective = avgDiffAB > 0.15; // A vs B差异应明显（>15%）
  const weightEffective = avgDiffAC > 0.05 && avgDiffAC < avgDiffAB; // A vs C应有差异但小于A vs B

  if (!ruleEffective) {
    console.log('❌ 规则注入失败或权重无效');
    console.log('   原因: A vs B 差异过小，规则未显著影响行为分布');
    console.log('   建议: 检查规则引擎实现，确认规则偏置是否正确应用');
  } else if (!weightEffective) {
    console.log('⚠️  规则生效，但权重调整效果不明显');
    console.log('   原因: A vs C 差异不符合预期（应小于A vs B但大于0）');
    console.log('   建议: 检查混合评分公式实现');
  } else {
    console.log('✅ 规则引擎验证通过');
    console.log(`   - A vs B 差异: ${avgDiffAB.toFixed(3)} (规则显著影响行为)`);
    console.log(`   - A vs C 差异: ${avgDiffAC.toFixed(3)} (权重调整有效)`);
    console.log('   - 规则在冷启动期成功主导了行为决策');
  }

  // 下一步建议
  console.log('\n📝 下一步建议:');
  if (ruleEffective && weightEffective) {
    console.log('   ✅ 规则引擎工作正常，可以继续：');
    console.log('      1. 扩大测试场景（30个伪场景）');
    console.log('      2. 开始数据标注（每次对话后手动标注👍 😐 👎）');
    console.log('      3. 积累到100+条标注数据后，开始训练并逐步提升nnWeight');
  } else {
    console.log('   ⚠️  需要先修复规则引擎问题：');
    console.log('      1. 检查RuleEngine.applyRuleBias()实现');
    console.log('      2. 验证规则偏置计算是否正确');
    console.log('      3. 确认混合评分公式是否正确应用');
  }

  console.log('\n' + '='.repeat(80));
}

// 运行验证
if (require.main === module) {
  runValidation().catch(error => {
    console.error('❌ 验证失败:', error);
    process.exit(1);
  });
}

export { runValidation };

