/**
 * 运行30个伪直播场景测试脚本
 * 
 * 功能：
 * 1. 循环跑30个场景
 * 2. 记录Top-1行为
 * 3. 检查是否符合预期
 * 4. 输出结果供手动标注 👍😐👎
 * 
 * 使用方法：
 * npx ts-node --project memory-universe/tsconfig.json scripts/run-pseudo-scenarios.ts
 * 
 * 🧠 已迁移到 BrainNN v5.0
 */

import { BrainNNAdapter, getBrainNNAdapter } from '../memory-universe/dist/core/BrainNNAdapter';
import { CandidateGenerator } from '../memory-universe/dist/core/CandidateGenerator';
import { PSEUDO_SCENARIOS, PseudoScenario } from '../memory-universe/dist/testing/pseudo-scenarios';
import { BehaviorType } from '../memory-universe/dist/types';

interface TestResult {
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
  // 手动标注字段（需要人工填写）
  manualRating?: '👍' | '😐' | '👎';
  notes?: string;
}

/**
 * 运行单个场景测试
 */
async function runScenario(scenario: PseudoScenario): Promise<TestResult> {
  // 🧠 初始化 BrainNN v5.0 组件
  const brainNN = getBrainNNAdapter({ enableRuleFallback: true });
  const candidateGenerator = new CandidateGenerator();

  // 生成候选
  const memoryContext = {
    memoryIds: [],
    scores: [],
    allowedSnippets: [],
    summaryEmbedding: new Array(32).fill(0)
  };

  // 获取所有允许的行为类型
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

  // 构建输入向量
  const stateVector = new Array(20).fill(0);
  const perceptionVector = new Array(8).fill(0);
  const messageEmbedding = new Array(32).fill(0);
  const memoryContextEmbedding = new Array(32).fill(0);

  // 评估候选
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

  // 获取Top-1行为
  const sortedBehaviors = Object.entries(policyOutput.candidateProbabilities)
    .sort((a, b) => b[1] - a[1]);

  const top1Behavior = sortedBehaviors[0][0];
  const top1Probability = sortedBehaviors[0][1];

  // 检查是否符合预期（类型转换，因为expectedBehavior是BehaviorType）
  const matchesExpected = top1Behavior === (scenario.expectedBehavior as string);

  // 检查是否触发了禁止行为
  const hasForbidden = scenario.forbiddenBehaviors.some(
    forbidden => sortedBehaviors.slice(0, 3).some(([behavior]) => behavior === (forbidden as string))
  );

  // 构建所有行为列表（Top-5）
  const allBehaviors = sortedBehaviors.slice(0, 5).map(([behaviorType, probability]) => ({
    behaviorType,
    probability
  }));

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    category: scenario.category,
    top1Behavior,
    top1Probability,
    expectedBehavior: scenario.expectedBehavior,
    matchesExpected,
    forbiddenBehaviors: scenario.forbiddenBehaviors,
    hasForbidden,
    allBehaviors
  };
}

/**
 * 主测试函数
 */
async function runAllScenarios() {
  console.log('🚀 开始运行30个伪直播场景测试\n');
  console.log('='.repeat(80));
  console.log('测试目标: 验证系统在30个典型场景下的行为模式');
  console.log('='.repeat(80));
  console.log();

  const results: TestResult[] = [];

  // 按类别分组运行
  const categories = ['A', 'B', 'C', 'D', 'E'] as const;
  
  for (const category of categories) {
    const scenarios = PSEUDO_SCENARIOS.filter(s => s.category === category);
    
    console.log(`\n📋 ${category} 类场景 (${scenarios.length}个)`);
    console.log('-'.repeat(80));

    for (const scenario of scenarios) {
      const result = await runScenario(scenario);
      results.push(result);

      // 输出结果
      const status = result.matchesExpected ? '✅' : '❌';
      const forbiddenStatus = result.hasForbidden ? '⚠️' : '✓';
      
      console.log(`\n${status} ${forbiddenStatus} 场景${scenario.id}: ${scenario.name}`);
      console.log(`   期望: ${scenario.expectedBehavior.padEnd(25)} 实际: ${result.top1Behavior.padEnd(25)} (${(result.top1Probability * 100).toFixed(1)}%)`);
      
      if (!result.matchesExpected) {
        console.log(`   ⚠️  不符合预期！`);
      }
      
      if (result.hasForbidden) {
        const triggeredForbidden = result.allBehaviors
          .filter(b => scenario.forbiddenBehaviors.includes(b.behaviorType as BehaviorType))
          .map(b => `${b.behaviorType}(${(b.probability * 100).toFixed(1)}%)`)
          .join(', ');
        console.log(`   ⚠️  触发了禁止行为: ${triggeredForbidden}`);
      }

      // 显示Top-3行为
      console.log(`   Top-3: ${result.allBehaviors.slice(0, 3).map(b => `${b.behaviorType}(${(b.probability * 100).toFixed(1)}%)`).join(', ')}`);
    }
  }

  // 统计汇总
  console.log('\n\n' + '='.repeat(80));
  console.log('📊 测试结果汇总');
  console.log('='.repeat(80));

  const totalScenarios = results.length;
  const matchedExpected = results.filter(r => r.matchesExpected).length;
  const hasForbidden = results.filter(r => r.hasForbidden).length;
  const perfectScenarios = results.filter(r => r.matchesExpected && !r.hasForbidden).length;

  console.log(`总场景数: ${totalScenarios}`);
  console.log(`符合预期: ${matchedExpected} (${(matchedExpected / totalScenarios * 100).toFixed(1)}%)`);
  console.log(`触发禁止行为: ${hasForbidden} (${(hasForbidden / totalScenarios * 100).toFixed(1)}%)`);
  console.log(`完美场景: ${perfectScenarios} (${(perfectScenarios / totalScenarios * 100).toFixed(1)}%)`);

  // 按类别统计
  console.log('\n📋 按类别统计:');
  console.log('-'.repeat(80));
  console.log('类别'.padEnd(10) + '总数'.padEnd(8) + '符合预期'.padEnd(12) + '完美场景'.padEnd(12));
  console.log('-'.repeat(80));

  for (const category of categories) {
    const categoryResults = results.filter(r => r.category === category);
    const categoryMatched = categoryResults.filter(r => r.matchesExpected).length;
    const categoryPerfect = categoryResults.filter(r => r.matchesExpected && !r.hasForbidden).length;
    
    console.log(
      category.padEnd(10) +
      categoryResults.length.toString().padEnd(8) +
      `${categoryMatched} (${(categoryMatched / categoryResults.length * 100).toFixed(0)}%)`.padEnd(12) +
      `${categoryPerfect} (${(categoryPerfect / categoryResults.length * 100).toFixed(0)}%)`.padEnd(12)
    );
  }

  // 输出详细结果（用于手动标注）
  console.log('\n\n' + '='.repeat(80));
  console.log('📝 详细结果（供手动标注 👍😐👎）');
  console.log('='.repeat(80));
  console.log('格式: [场景ID] [场景名] | 期望: [期望行为] | 实际: [实际行为] | 符合预期: [是/否] | 禁止行为: [是/否]');
  console.log('-'.repeat(80));

  results.forEach(result => {
    const matchStr = result.matchesExpected ? '是' : '否';
    const forbiddenStr = result.hasForbidden ? '是' : '否';
    console.log(
      `[${result.scenarioId.toString().padStart(2)}] ${result.scenarioName.padEnd(25)} | ` +
      `期望: ${result.expectedBehavior.padEnd(25)} | ` +
      `实际: ${result.top1Behavior.padEnd(25)} (${(result.top1Probability * 100).toFixed(1)}%) | ` +
      `符合预期: ${matchStr.padEnd(2)} | ` +
      `禁止行为: ${forbiddenStr.padEnd(2)}`
    );
  });

  // 保存结果到JSON文件（用于后续分析）
  const fs = require('fs');
  const path = require('path');
  const outputPath = path.join(__dirname, '..', 'data', 'pseudo-scenarios-results.json');
  
  // 确保目录存在
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 保存结果
  fs.writeFileSync(
    outputPath,
    JSON.stringify(results, null, 2),
    'utf-8'
  );

  console.log(`\n✅ 结果已保存到: ${outputPath}`);
  console.log('\n📝 下一步:');
  console.log('   1. 查看上面的详细结果');
  console.log('   2. 对每个场景手动标注 👍😐👎');
  console.log('   3. 修改 data/pseudo-scenarios-results.json 添加 manualRating 字段');
  console.log('   4. 分析不符合预期的场景，调整规则（只允许调数值或删除规则）');

  console.log('\n' + '='.repeat(80));
}

// 运行测试
if (require.main === module) {
  runAllScenarios().catch(error => {
    console.error('❌ 测试失败:', error);
    process.exit(1);
  });
}

export { runAllScenarios, runScenario };

