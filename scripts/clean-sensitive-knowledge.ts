/**
 * 清理知识库中的敏感内容
 * 
 * 使用 ContentFilter.checkProactiveTopic() 检查并删除不适合主动话题的条目
 */

import { SQLiteAdapter } from '../memory-universe/src/storage/SQLiteAdapter';
import { getContentFilter } from '../memory-universe/src/core/ContentFilter';
import * as path from 'path';

async function main() {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'memory_universe.db');
  console.log(`📂 数据库路径: ${dbPath}`);
  
  const adapter = new SQLiteAdapter(dbPath);
  await adapter.initialize();
  
  const knowledgeStore = adapter.knowledgeStore;
  if (!knowledgeStore) {
    console.error('❌ 知识库未初始化');
    process.exit(1);
  }
  
  const contentFilter = getContentFilter();
  
  // 获取所有知识条目
  console.log('\n🔍 扫描知识库...');
  const entries = await knowledgeStore.query({ limit: 10000 });
  console.log(`📊 共 ${entries.length} 条知识`);
  
  const toDelete: Array<{ id: string; title: string; reason: string }> = [];
  
  for (const entry of entries) {
    // 使用统一的 ContentFilter.checkProactiveTopic 检查
    const titleCheck = contentFilter.checkProactiveTopic(entry.title);
    if (!titleCheck.passed) {
      toDelete.push({ id: entry.id, title: entry.title, reason: `标题: ${titleCheck.reason} (${titleCheck.matchedPattern})` });
      continue;
    }
    
    const contentCheck = contentFilter.checkProactiveTopic(entry.summary || entry.content.substring(0, 500));
    if (!contentCheck.passed) {
      toDelete.push({ id: entry.id, title: entry.title, reason: `内容: ${contentCheck.reason} (${contentCheck.matchedPattern})` });
      continue;
    }
  }
  
  console.log(`\n⚠️ 发现 ${toDelete.length} 条需要清理的内容:\n`);
  
  for (const item of toDelete) {
    console.log(`  - [${item.id}] ${item.title}`);
    console.log(`    原因: ${item.reason}\n`);
  }
  
  if (toDelete.length === 0) {
    console.log('✅ 知识库内容安全，无需清理');
    await adapter.close();
    return;
  }
  
  // 确认删除
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const answer = await new Promise<string>(resolve => {
    rl.question(`\n是否删除这 ${toDelete.length} 条内容？(y/N) `, resolve);
  });
  rl.close();
  
  if (answer.toLowerCase() === 'y') {
    console.log('\n🗑️ 开始删除...');
    let deleted = 0;
    for (const item of toDelete) {
      try {
        await knowledgeStore.delete(item.id);
        deleted++;
        console.log(`  ✓ 已删除: ${item.title}`);
      } catch (error) {
        console.error(`  ✗ 删除失败: ${item.title}`, error);
      }
    }
    console.log(`\n✅ 完成，共删除 ${deleted} 条`);
  } else {
    console.log('\n❌ 已取消');
  }
  
  await adapter.close();
}

main().catch(console.error);
