#!/usr/bin/env node

/**
 * 显示 AI 学到的完整内容
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const MEMORY_UNIVERSE_URL = process.env.MEMORY_UNIVERSE_URL || `http://localhost:${process.env.MEMORY_UNIVERSE_PORT || 4005}`;

async function showLearnedContent() {
  try {
    console.log('📚 正在获取学习任务...\n');
    
    // 获取学习任务列表
    const response = await fetch(`${MEMORY_UNIVERSE_URL}/api/knowledge/tasks?limit=50`);
    const data = await response.json();
    
    if (!data.success) {
      console.error('❌ 获取失败:', data.error);
      return;
    }
    
    const tasks = data.tasks;
    
    if (tasks.length === 0) {
      console.log('暂无学习任务');
      return;
    }
    
    console.log(`找到 ${tasks.length} 个学习任务\n`);
    
    // 显示每个已学习的任务
    let learnedCount = 0;
    for (const task of tasks) {
      if (task.status !== 'learned') {
        continue;
      }
      
      learnedCount++;
      console.log('='.repeat(80));
      console.log(`\n📖 问题 ${learnedCount}: ${task.question}`);
      console.log(`⏰ 学习时间: ${new Date(task.timestamp).toLocaleString('zh-CN')}`);
      console.log(`👤 用户: ${task.userId}`);
      console.log(`📊 置信度: ${(task.confidence * 100).toFixed(0)}%`);
      console.log(`🆔 任务ID: ${task.id}`);
      
      // 获取完整知识
      try {
        const detailResponse = await fetch(`${MEMORY_UNIVERSE_URL}/api/knowledge/tasks/${task.id}`);
        const detailData = await detailResponse.json();
        
        if (detailData.success && detailData.task.learnedKnowledge) {
          console.log(`\n💡 学到的完整知识:\n`);
          console.log(detailData.task.learnedKnowledge);
          
          if (detailData.task.searchResults && detailData.task.searchResults.length > 0) {
            console.log(`\n🔍 搜索结果数量: ${detailData.task.searchResults.length}`);
          }
        } else {
          console.log(`\n⚠️  知识内容不可用`);
        }
      } catch (error) {
        console.log(`\n❌ 获取详情失败: ${error.message}`);
      }
      
      console.log('\n' + '='.repeat(80) + '\n');
    }
    
    if (learnedCount === 0) {
      console.log('暂无已学习的任务');
    } else {
      console.log(`\n✅ 共显示 ${learnedCount} 个已学习的知识\n`);
    }
    
    // 显示统计
    const statsResponse = await fetch(`${MEMORY_UNIVERSE_URL}/api/knowledge/stats`);
    const statsData = await statsResponse.json();
    
    if (statsData.success) {
      const stats = statsData.stats;
      console.log('📊 学习统计:');
      console.log(`   检测到的问题: ${stats.totalDetected}`);
      console.log(`   已学习: ${stats.totalLearned}`);
      console.log(`   失败: ${stats.totalFailed}`);
      console.log(`   成功率: ${stats.successRate}`);
      console.log(`   正在学习: ${stats.activeTaskCount}`);
      console.log(`   学过的话题: ${stats.learnedTopicCount}`);
    }
    
  } catch (error) {
    console.error('❌ 错误:', error.message);
    console.error('\n请确保 Memory Universe 服务正在运行:');
    console.error('  cd memory-universe');
    console.error('  npm start');
  }
}

// 运行
showLearnedContent();
