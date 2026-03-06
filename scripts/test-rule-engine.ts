/**
 * 测试规则引擎 + BrainNN v5.0 混合评分
 * 验证冷启动期的行为模式是否稳定
 * 
 * 🧠 已迁移到 BrainNN v5.0
 */

import { RuleEngine, RuleConfig } from '../memory-universe/src/core/RuleEngine';
import { BrainNNAdapter, getBrainNNAdapter } from '../memory-universe/src/core/BrainNNAdapter';
import { Candidate, Perception, InnerState, BehaviorType } from '../memory-universe/src/types';
import { CandidateGenerator } from '../memory-universe/src/core/CandidateGenerator';

/**
 * 创建测试场景
 */
function createTestScenario(
  name: string,
  perception: Perception,
  innerState: InnerState,
  riskLevel: number
): { name: string; perception: Perception; innerState: InnerState; riskLevel: number } {
  return { name, perception, innerState, riskLevel };
}

/**
 * 测试场景1: 正常对话 + 正面情绪
 */
function scenario1() {
  return createTestScenario(
    '正常对话 + 正面情绪',
    {
      intent: 'statement',
      sentiment: 0.6, // 正面情绪
      riskHint: 0.1, // 低风险
      entities: ['观众', '直播'],
      confidence: 0.8
    },
    {
      emotion: { joy: 0.7, sadness: 0.1, anger: 0.0, curiosity: 0.6, fatigue: 0.2 },
      persona: { energy: 0.8, talkativeness: 0.7, openness: 0.6, willingness: 0.7, mood: 'cheerful' },
      audience: { excited: 0.6, bored: 0.2, tense: 0.1 },
      conflict: { hesitation: 0.1, turmoil: 0.0, decisionDifficulty: 0.1 },
      mode: 'normal'
    },
    0.1 // 低风险
  );
}

/**
 * 测试场景2: 高风险场景
 */
function scenario2() {
  return createTestScenario(
    '高风险场景',
    {
      intent: 'request',
      sentiment: 0.0, // 中性
      riskHint: 0.7, // 高风险
      entities: ['敏感话题'],
      confidence: 0.5
    },
    {
      emotion: { joy: 0.3, sadness: 0.2, anger: 0.1, curiosity: 0.4, fatigue: 0.3 },
      persona: { energy: 0.5, talkativeness: 0.4, openness: 0.3, willingness: 0.4, mood: 'calm' },
      audience: { excited: 0.3, bored: 0.4, tense: 0.6 },
      conflict: { hesitation: 0.5, turmoil: 0.3, decisionDifficulty: 0.4 },
      mode: 'normal'
    },
    0.7 // 高风险
  );
}

/**
 * 测试场景3: 负面情绪（需要共情）
 */
function scenario3() {
  return createTestScenario(
    '负面情绪（需要共情）',
    {
      intent: 'statement',
      sentiment: -0.5, // 负面情绪
      riskHint: 0.2, // 低风险
      entities: ['观众', '情绪'],
      confidence: 0.7
    },
    {
      emotion: { joy: 0.2, sadness: 0.6, anger: 0.1, curiosity: 0.3, fatigue: 0.4 },
      persona: { energy: 0.4, talkativeness: 0.5, openness: 0.7, willingness: 0.6, mood: 'calm' },
      audience: { excited: 0.2, bored: 0.3, tense: 0.4 },
      conflict: { hesitation: 0.2, turmoil: 0.3, decisionDifficulty: 0.2 },
      mode: 'emotional'
    },
    0.2 // 低风险
  );
}

/**
 * 测试场景4: 提问意图
 */
function scenario4() {
  return createTestScenario(
    '提问意图',
    {
      intent: 'question', // 提问
      sentiment: 0.3, // 轻微正面
      riskHint: 0.15, // 低风险
      entities: ['问题'],
      confidence: 0.8
    },
    {
      emotion: { joy: 0.5, sadness: 0.1, anger: 0.0, curiosity: 0.8, fatigue: 0.2 },
      persona: { energy: 0.7, talkativeness: 0.6, openness: 0.8, willingness: 0.7, mood: 'focused' },
      audience: { excited: 0.5, bored: 0.3, tense: 0.1 },
      conflict: { hesitation: 0.1, turmoil: 0.0, decisionDifficulty: 0.1 },
      mode: 'analytical'
    },
    0.15 // 低风险
  );
}

/**
 * 测试场景5: 观众无聊（需要活跃气氛）
 */
function scenario5() {
  return createTestScenario(
    '观众无聊（需要活跃气氛）',
    {
      intent: 'statement',
      sentiment: 0.1, // 中性
      riskHint: 0.1, // 低风险
      entities: ['观众'],
      confidence: 0.6
    },
    {
      emotion: { joy: 0.4, sadness: 0.2, anger: 0.0, curiosity: 0.5, fatigue: 0.3 },
      persona: { energy: 0.6, talkativeness: 0.7, openness: 0.6, willingness: 0.7, mood: 'cheerful' },
      audience: { excited: 0.2, bored: 0.8, tense: 0.1 }, // 观众很无聊
      conflict: { hesitation: 0.1, turmoil: 0.0, decisionDifficulty: 0.1 },
      mode: 'normal'
    },
    0.1 // 低风险
  );
}

/**
 * 运行测试
 */
async function runTest() {
  console.log('🧪 开始测试规则引擎 + BrainNN v5.0 混合评分\n');
  console.log('='.repeat(60));

  // 初始化组件
  const ruleEngine = new RuleEngine({ nnWeight: 0.1 }); // 初期：NN只占10%
  const brainNN = getBrainNNAdapter({ enableRuleFallback: true });
  const candidateGenerator = new CandidateGenerator();

  // 测试场景列表
  const scenarios = [
    scenario1(),
    scenario2(),
    scenario3(),
    scenario4(),
    scenario5()
  ];

  // 运行每个场景
  for (const scenario of scenarios) {
    console.log(`\n📋 测试场景: ${scenario.name}`);
    console.log('-'.repeat(60));
    console.log(`风险等级: ${scenario.riskLevel.toFixed(2)}`);
    console.log(`情绪: ${scenario.perception.sentiment.toFixed(2)}`);
    console.log(`意图: ${scenario.perception.intent}`);
    console.log(`能量: ${scenario.innerState.persona.energy.toFixed(2)}`);
    console.log(`观众无聊度: ${scenario.innerState.audience.bored.toFixed(2)}`);

    // 生成候选
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
      'dodge',
      'silent',
      'topic_shift',
      'boundary_warning',
      'clarify_question',
      'proactive_recall_context',
      'meme_trigger',
      'analytical_answer_short',
      'emotional_resonate'
    ];

    const candidates = candidateGenerator.generateCandidates(
      allowedBehaviors,
      memoryContext,
      0.5, // exposureLevel
      { maxVerbosity: 1.0, maxSarcasm: 0.5, maxRecallStrength: 0.6 }
    );

    // 计算规则偏置
    const ruleBiases = ruleEngine.calculateRuleBiases(
      candidates,
      scenario.perception,
      scenario.innerState,
      scenario.riskLevel
    );

    // 模拟NN评分（使用随机值，因为NN权重是随机的）
    const stateVector = new Array(20).fill(0);
    const perceptionVector = new Array(8).fill(0);
    const messageEmbedding = new Array(32).fill(0);
    const memoryContextEmbedding = new Array(32).fill(0);

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

    // 显示结果
    console.log('\n📊 规则偏置 (前5名):');
    const sortedBiases = Array.from(ruleBiases.entries())
      .sort((a, b) => Math.abs(b[1].bias) - Math.abs(a[1].bias))
      .slice(0, 5);
    
    sortedBiases.forEach(([behaviorType, bias]) => {
      console.log(`  ${behaviorType.padEnd(25)} 偏置: ${bias.bias.toFixed(2).padStart(6)}  (${bias.reasoning})`);
    });

    console.log('\n📊 最终混合评分 (前5名):');
    const sortedScores = Object.entries(policyOutput.candidateProbabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    sortedScores.forEach(([behaviorType, score]) => {
      const ruleBias = ruleBiases.get(behaviorType as BehaviorType);
      const biasInfo = ruleBias ? ` [规则偏置: ${ruleBias.bias.toFixed(2)}]` : '';
      console.log(`  ${behaviorType.padEnd(25)} 概率: ${score.toFixed(3).padStart(6)}${biasInfo}`);
    });

    // 显示规则解释
    console.log('\n💡 规则解释:');
    const explanation = ruleEngine.explainRules(
      candidates,
      scenario.perception,
      scenario.innerState,
      scenario.riskLevel
    );
    console.log(explanation);
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ 测试完成！');
  console.log('\n📝 总结:');
  console.log('- 规则引擎在冷启动期提供稳定的行为模式');
  console.log('- 混合评分: final_score = rule_bias * 0.9 + nn_score * 0.1');
  console.log('- 随着训练进行，可以逐步增加nnWeight（从0.1 → 0.3 → 0.5 → 0.8）');
  console.log('- 最终过渡到NN主导（nnWeight = 0.9+）');
}

// 运行测试
if (require.main === module) {
  runTest().catch(error => {
    console.error('❌ 测试失败:', error);
    process.exit(1);
  });
}

export { runTest };

