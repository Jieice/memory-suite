/**
 * 交互式标注工具（辅助脚本）
 * 使用数字键进行标注：
 * 1 = 好 👍
 * 2 = 一般 😐
 * 3 = 不行 👎
 * s = 跳过
 * q = 退出
 *
 * 使用方法：
 * npx ts-node --project memory-universe/tsconfig.json scripts/annotate-scenarios.ts
 */

import * as fs from 'fs';
import * as path from 'path';

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

/**
 * 读取标注结果
 */
function loadResults(): AnnotatedResult[] {
  const resultsPath = path.join(__dirname, '..', 'data', 'pseudo-scenarios-results.json');
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`标注结果文件不存在: ${resultsPath}`);
  }
  return JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
}

/**
 * 保存标注结果
 */
function saveResults(results: AnnotatedResult[]): void {
  const resultsPath = path.join(__dirname, '..', 'data', 'pseudo-scenarios-results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf-8');
}

/**
 * 显示标注指南
 */
function showAnnotationGuide(): void {
  console.log('\n📋 标注指南（只需按数字）');
  console.log('='.repeat(80));
  console.log('1 = 👍 好：完全符合预期，或虽然不符合但非常合理');
  console.log('2 = 😐 一般：行为基本合理，但可以更好');
  console.log('3 = 👎 不行：行为不合理，需要调整');
  console.log('s = 跳过当前场景');
  console.log('q = 保存并退出');
  console.log('='.repeat(80));
}

/**
 * 显示场景信息
 */
function showScenario(result: AnnotatedResult): void {
  console.log(`\n📋 场景 ${result.scenarioId}: ${result.scenarioName}`);
  console.log('-'.repeat(80));
  console.log(`类别: ${result.category}`);
  console.log(`期望行为: ${result.expectedBehavior}`);
  console.log(`实际行为: ${result.top1Behavior} (${(result.top1Probability * 100).toFixed(1)}%)`);
  console.log(`符合预期: ${result.matchesExpected ? '是' : '否'}`);

  if (result.hasForbidden) {
    console.log(`⚠️  触发了禁止行为: ${result.forbiddenBehaviors.join(', ')}`);
  }

  console.log(`\nTop-3 行为:`);
  result.allBehaviors.slice(0, 3).forEach((b, idx) => {
    console.log(`  ${idx + 1}. ${b.behaviorType.padEnd(25)} ${(b.probability * 100).toFixed(1)}%`);
  });

  if (result.manualRating) {
    console.log(`\n当前标注: ${result.manualRating}`);
    if (result.notes) {
      console.log(`备注: ${result.notes}`);
    }
  }
}

/**
 * 交互式标注
 */
function interactiveAnnotation() {
  console.log('🎯 开始交互式标注（数字键模式）\n');
  console.log('='.repeat(80));
  console.log('输入说明：1=好 👍  2=一般 😐  3=不行 👎  s=跳过  q=退出');
  console.log('='.repeat(80));

  const results = loadResults();
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let currentIndex = 0;

  // 找到第一个未标注的场景
  while (currentIndex < results.length && results[currentIndex].manualRating) {
    currentIndex++;
  }

  if (currentIndex >= results.length) {
    console.log('\n✅ 所有场景都已标注完成！');
    rl.close();
    return;
  }

  const annotateNext = () => {
    if (currentIndex >= results.length) {
      console.log('\n✅ 所有场景都已标注完成！');

      const ratingDistribution = {
        '👍': results.filter(r => r.manualRating === '👍').length,
        '😐': results.filter(r => r.manualRating === '😐').length,
        '👎': results.filter(r => r.manualRating === '👎').length
      };

      console.log('\n📊 标注统计:');
      console.log(`   👍 好: ${ratingDistribution['👍']}`);
      console.log(`   😐 一般: ${ratingDistribution['😐']}`);
      console.log(`   👎 不行: ${ratingDistribution['👎']}`);

      saveResults(results);
      rl.close();
      return;
    }

    const result = results[currentIndex];
    showScenario(result);

    rl.question('\n请输入标注 (1/2/3/s/q): ', (answer: string) => {
      const input = answer.trim().toLowerCase();

      if (input === 'q') {
        console.log('\n💾 保存并退出...');
        saveResults(results);
        rl.close();
        return;
      }

      if (input === 's') {
        currentIndex++;
        annotateNext();
        return;
      }

      if (input === '1' || input === '2' || input === '3') {
        const ratingMap: Record<string, '👍' | '😐' | '👎'> = {
          '1': '👍',
          '2': '😐',
          '3': '👎'
        };

        result.manualRating = ratingMap[input];

        rl.question('添加备注（可选，直接回车跳过）: ', (notes: string) => {
          if (notes.trim()) {
            result.notes = notes.trim();
          }

          currentIndex++;
          saveResults(results);
          annotateNext();
        });
        return;
      }

      console.log('❌ 无效输入，请使用 1 / 2 / 3 / s / q');
      annotateNext();
    });
  };

  annotateNext();
}

// 运行交互式标注
if (require.main === module) {
  showAnnotationGuide();
  interactiveAnnotation();
}

export { interactiveAnnotation };
