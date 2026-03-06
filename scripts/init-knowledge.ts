/**
 * 知识库初始化脚本
 * 
 * 功能：预先获取一些基础知识，让 AI 有内容可以主动发言
 * 
 * 使用方法：
 *   npx ts-node scripts/init-knowledge.ts
 * 
 * 或者通过 npm：
 *   npm run init-knowledge
 */

import { resolve } from 'path';
import * as fs from 'fs';

// 手动加载环境变量
function loadEnv() {
  const envPath = resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split('\n').forEach(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          let value = valueParts.join('=').trim();
          // 移除行内注释
          const commentIndex = value.indexOf('#');
          if (commentIndex !== -1 && !value.startsWith('"') && !value.startsWith("'")) {
            value = value.substring(0, commentIndex).trim();
          }
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    });
  }
}

loadEnv();

import { SQLiteAdapter } from '../memory-universe/src/storage/SQLiteAdapter';
import { KnowledgeFetcher } from '../memory-universe/src/core/KnowledgeFetcher';

// 预定义的知识主题（精简版，快速初始化）
const KNOWLEDGE_TOPICS = {
  // 百科知识（维基百科）- 精简为 10 个核心主题
  encyclopedia: [
    '人工智能',
    '虚拟主播',
    'VTuber',
    '直播',
    '游戏',
    '动漫',
    '音乐',
    '科幻',
    '心理学',
    '哲学'
  ],
  
  // 古腾堡经典文学（用于风格训练）- 精简为 3 本
  literature: [
    { id: 1342, name: 'Pride and Prejudice (傲慢与偏见)' },
    { id: 11, name: 'Alice in Wonderland (爱丽丝梦游仙境)' },
    { id: 1661, name: 'Sherlock Holmes (福尔摩斯)' },
  ],
  
  // 热门话题关键词（用于论坛搜索）
  hotTopics: [
    'AI',
    '游戏推荐',
    '番剧推荐'
  ]
};

// 进度显示
function showProgress(current: number, total: number, label: string) {
  const percent = Math.round((current / total) * 100);
  const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
  process.stdout.write(`\r[${bar}] ${percent}% - ${label}                    `);
}

async function initKnowledge() {
  console.log('🚀 知识库初始化脚本启动\n');
  console.log('=' .repeat(60));
  
  // 初始化数据库
  const projectRoot = resolve(__dirname, '..');
  const dbPath = process.env.SQLITE_DB_PATH || resolve(projectRoot, 'data', 'memory_universe.db');
  
  console.log(`📂 数据库路径: ${dbPath}`);
  
  const sqliteAdapter = new SQLiteAdapter(dbPath);
  await sqliteAdapter.initialize();
  
  const fetcher = new KnowledgeFetcher(sqliteAdapter.knowledgeStore);
  
  // 统计
  let successCount = 0;
  let failCount = 0;
  const startTime = Date.now();
  
  // 1. 获取百科知识
  console.log('\n\n📚 第一阶段：获取百科知识（维基百科）\n');
  const encyclopediaTopics = KNOWLEDGE_TOPICS.encyclopedia;
  
  for (let i = 0; i < encyclopediaTopics.length; i++) {
    const topic = encyclopediaTopics[i];
    showProgress(i + 1, encyclopediaTopics.length, `维基百科: ${topic}`);
    
    try {
      // 设置较短的超时
      const result = await Promise.race([
        fetcher.fetchWikipedia(topic, 'zh'),
        sleep(8000).then(() => ({ success: false, error: 'timeout' }))
      ]);
      
      if (result.success) {
        successCount++;
      } else {
        // 尝试英文版
        const enResult = await Promise.race([
          fetcher.fetchWikipedia(topic, 'en'),
          sleep(8000).then(() => ({ success: false, error: 'timeout' }))
        ]);
        if (enResult.success) {
          successCount++;
        } else {
          failCount++;
          console.log(`\n   ⚠️ ${topic} 获取失败: ${result.error || 'unknown'}`);
        }
      }
    } catch (error: any) {
      failCount++;
      console.log(`\n   ⚠️ ${topic} 异常: ${error.message}`);
    }
    
    // 避免请求过快
    await sleep(300);
  }
  
  console.log(`\n✅ 百科知识获取完成: 成功 ${successCount}, 失败 ${failCount}`);
  
  // 2. 获取经典文学（用于风格训练）
  console.log('\n\n📖 第二阶段：获取经典文学（古腾堡计划）\n');
  const literatureBooks = KNOWLEDGE_TOPICS.literature;
  let litSuccess = 0;
  let litFail = 0;
  
  for (let i = 0; i < literatureBooks.length; i++) {
    const book = literatureBooks[i];
    showProgress(i + 1, literatureBooks.length, `古腾堡: ${book.name}`);
    
    try {
      // 文学作品较大，设置较长超时
      const result = await Promise.race([
        fetcher.fetchGutenberg(book.id),
        sleep(30000).then(() => ({ success: false, error: 'timeout' }))
      ]);
      
      if (result.success) {
        litSuccess++;
        successCount++;
      } else {
        litFail++;
        failCount++;
        console.log(`\n   ⚠️ ${book.name} 获取失败`);
      }
    } catch (error: any) {
      litFail++;
      failCount++;
      console.log(`\n   ⚠️ ${book.name} 异常: ${error.message}`);
    }
    
    // 文学作品较大，间隔长一点
    await sleep(500);
  }
  
  console.log(`\n✅ 经典文学获取完成: 成功 ${litSuccess}, 失败 ${litFail}`);
  
  // 3. 尝试获取百度百科（作为维基百科的补充）- 精简
  console.log('\n\n🔍 第三阶段：获取百度百科（补充）\n');
  const baiduTopics = ['虚拟主播', 'B站', '弹幕'];
  let baiduSuccess = 0;
  
  for (let i = 0; i < baiduTopics.length; i++) {
    const topic = baiduTopics[i];
    showProgress(i + 1, baiduTopics.length, `百度百科: ${topic}`);
    
    try {
      const result = await Promise.race([
        fetcher.fetchBaiduBaike(topic),
        sleep(8000).then(() => ({ success: false, error: 'timeout' }))
      ]);
      
      if (result.success) {
        baiduSuccess++;
        successCount++;
      } else {
        failCount++;
      }
    } catch (error) {
      failCount++;
    }
    
    await sleep(300);
  }
  
  console.log(`\n✅ 百度百科获取完成: 成功 ${baiduSuccess}`);
  
  // 4. 尝试获取 arXiv 论文摘要（AI 相关）- 精简
  console.log('\n\n🎓 第四阶段：获取学术论文摘要（arXiv）\n');
  const arxivQueries = ['large language model'];
  let arxivSuccess = 0;
  
  for (let i = 0; i < arxivQueries.length; i++) {
    const query = arxivQueries[i];
    showProgress(i + 1, arxivQueries.length, `arXiv: ${query}`);
    
    try {
      const results = await Promise.race([
        fetcher.fetchArxiv(query, 3),
        sleep(15000).then(() => [{ success: false, error: 'timeout' }])
      ]);
      
      const successResults = results.filter(r => r.success);
      arxivSuccess += successResults.length;
      successCount += successResults.length;
      failCount += results.length - successResults.length;
    } catch (error) {
      failCount++;
    }
    
    await sleep(500);
  }
  
  console.log(`\n✅ 学术论文获取完成: 成功 ${arxivSuccess}`);
  
  // 5. 获取知识库统计
  console.log('\n\n📊 获取知识库统计...\n');
  const stats = await sqliteAdapter.knowledgeStore.getStats();
  
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  
  console.log('=' .repeat(60));
  console.log('\n🎉 知识库初始化完成！\n');
  console.log(`📈 统计信息:`);
  console.log(`   - 总条目数: ${stats.totalCount}`);
  console.log(`   - 百科类: ${stats.byCategory?.encyclopedia || 0}`);
  console.log(`   - 文学类: ${stats.byCategory?.literature || 0}`);
  console.log(`   - 论坛类: ${stats.byCategory?.forum || 0}`);
  console.log(`   - 学术类: ${stats.byCategory?.academic || 0}`);
  console.log(`   - 本次成功: ${successCount}`);
  console.log(`   - 本次失败: ${failCount}`);
  console.log(`   - 耗时: ${elapsed} 秒`);
  console.log('\n' + '=' .repeat(60));
  
  // 关闭数据库
  await sqliteAdapter.close();
  
  console.log('\n✅ 数据库已关闭，初始化完成！');
  console.log('\n💡 提示: 现在可以启动服务，AI 将能够使用这些知识进行主动发言。');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 运行
initKnowledge().catch(error => {
  console.error('\n❌ 初始化失败:', error);
  process.exit(1);
});
