/**
 * BrainNN v5.0 测试脚本
 */

import { BrainNNv5 } from '../memory-universe/src/core/BrainNNv5';
import * as path from 'path';

const WEIGHTS_PATH = path.join(__dirname, '../data/models/brain-nn-weights-v5.json');

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('🧠 BrainNN v5.0 测试');
  console.log('='.repeat(70));
  
  // 创建模型
  console.log('\n[加载] 创建 BrainNN v5.0...');
  const brain = new BrainNNv5();
  
  // 尝试加载权重
  try {
    brain.loadWeights(WEIGHTS_PATH);
    console.log(`[加载] 权重加载完成`);
  } catch (e) {
    console.log('[加载] 权重文件不存在，使用随机初始化');
  }
  
  console.log(`[信息] 模型版本: ${brain.getVersion()}`);
  
  // 测试用例
  const testCases = [
    { text: '你好啊', desc: '简单问候' },
    { text: '今天天气真好', desc: '闲聊' },
    { text: '我好难过，工作压力太大了', desc: '负面情绪' },
    { text: '哈哈哈哈太好笑了', desc: '开心' },
    { text: '你觉得人工智能会取代人类吗？', desc: '深度问题' },
    { text: '谢谢你陪我聊天', desc: '感谢' },
    { text: '无聊死了', desc: '无聊' },
    { text: '给我讲个笑话吧', desc: '请求' },
    { text: '你最近在忙什么？', desc: '关心' },
    { text: '我刚吃完饭，好撑啊', desc: '日常分享' },
  ];
  
  // 创建模拟输入
  function createInput(text: string) {
    return {
      stateVector: new Array(27).fill(0).map(() => Math.random() * 0.5),
      perceptionVector: new Array(8).fill(0).map(() => Math.random() * 0.5),
      messageEmbedding: new Array(1024).fill(0).map(() => Math.random() * 0.1),
      memoryEmbedding: new Array(1024).fill(0).map(() => Math.random() * 0.1),
      text
    };
  }
  
  // 情绪图标
  const emotionIcons: Record<string, string> = {
    'joy': '😊', 'curiosity': '🤔', 'empathy': '🤗', 'surprise': '😮',
    'concern': '😟', 'playful': '😜', 'calm': '😌', 'annoyed': '😤'
  };
  
  // 策略翻译
  const strategyNames: Record<string, string> = {
    'direct_answer': '直接回答', 'share_experience': '分享经历', 'ask_back': '反问',
    'empathize': '共情', 'joke': '玩笑', 'deflect': '转移', 'silent': '沉默'
  };
  
  // 运行测试
  for (const tc of testCases) {
    console.log('\n' + '-'.repeat(70));
    console.log(`💬 用户: "${tc.text}" (${tc.desc})`);
    
    const input = createInput(tc.text);
    const output = brain.thinkWithText(input);
    
    const emotionIcon = emotionIcons[output.emotion.primary.type] || '❓';
    const strategyName = strategyNames[output.strategy.type] || output.strategy.type;
    
    console.log(`\n  📍 思考方向: ${output.thinking.direction}`);
    console.log(`  💭 情绪: ${emotionIcon}${output.emotion.primary.type} (强度: ${(output.emotion.primary.intensity * 100).toFixed(0)}%)`);
    console.log(`  🎯 策略: ${strategyName}`);
    console.log(`  🎨 语气: ${output.strategy.tone}`);
    console.log(`  📝 长度建议: ${output.strategy.lengthHint} 字`);
    console.log(`  🔧 使用记忆: ${output.strategy.useMemory ? '是' : '否'} | 反问: ${output.strategy.askBack ? '是' : '否'} | 表情: ${output.strategy.useEmoji ? '是' : '否'}`);
    console.log(`  📊 置信度: ${(output.confidence * 100).toFixed(1)}%`);
    
    // v2.0 推理步骤
    if (output.reasoningSteps && output.reasoningSteps.length > 0) {
      console.log(`  🧠 推理步数: ${output.actualReasoningSteps}/${output.reasoningSteps.length}`);
      for (const step of output.reasoningSteps.slice(0, 3)) {
        console.log(`     步骤${step.step}: ${step.focus} (置信度: ${(step.confidence * 100).toFixed(0)}%)`);
      }
    }
    
    // v4.0 世界模型
    if (output.worldModel) {
      const effects = output.worldModel.responseEffects;
      const labels = output.worldModel.effectLabels;
      console.log(`  🌍 预测效果:`);
      for (let i = 0; i < Math.min(3, effects.length); i++) {
        console.log(`     ${labels[i]}: ${(effects[i] * 100).toFixed(0)}%`);
      }
    }
    
    // v5.0 元学习
    if (output.metaLearning) {
      console.log(`  🎓 任务类型: ${output.metaLearning.taskType} (置信度: ${(output.metaLearning.taskConfidence * 100).toFixed(0)}%)`);
      console.log(`  ⚡ 适应强度: ${(output.metaLearning.adaptationStrength * 100).toFixed(1)}%`);
    }
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('✅ BrainNN v5.0 测试完成');
  console.log('='.repeat(70) + '\n');
}

main().catch(console.error);
