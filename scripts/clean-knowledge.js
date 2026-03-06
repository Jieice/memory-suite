/**
 * 知识库数据清洗脚本
 * 删除不适合直播的内容
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/memory_universe.db');

// 需要删除的标题关键词（敏感/不适合直播）
const FORBIDDEN_TITLE_KEYWORDS = [
  // 政治敏感
  '习近平', '国台办', '东部战区', '演习', '王毅', '中使馆', '中方', '国补政策',
  '民生政策', '新规将施行', '战区', '围台', '开火', '命中',
  // 法律相关
  '法律', '法规', '律师', '诉讼', '法院', '判决', '刑法', '民法', '免罪',
  // 负面新闻
  '火灾致', '死', '强拆', '震惊', '绝不姑息', '踩烈士',
  // 成人/敏感
  '18禁', '限制级', '色情', '成人',
  // 无意义内容
  'Gutenberg', 'PROJECT GUTENBERG',
  // 股市/金融（不适合娱乐直播）
  '今日股市', '股市',
  // 纯日期帖子（无实际内容）
  '2025-12-30【', '2025-12-30 17',
  // 盗版相关
  '盗版',
];

// 需要删除的分类
const FORBIDDEN_CATEGORIES = [
  'literature', // 英文文学不适合中文直播
];

function main() {
  console.log('🔍 连接数据库...');
  const db = new Database(DB_PATH);
  
  // 1. 查看当前统计
  console.log('\n📊 当前知识库分类统计:');
  const categories = db.prepare(`
    SELECT category, COUNT(*) as count 
    FROM knowledge_entries 
    GROUP BY category 
    ORDER BY count DESC
  `).all();
  
  categories.forEach(c => {
    console.log(`  - ${c.category || '(无分类)'}: ${c.count} 条`);
  });
  
  // 2. 查找需要删除的条目
  console.log('\n🔍 查找需要清洗的数据...');
  
  const toDelete = [];
  
  // 按标题关键词查找
  const allEntries = db.prepare('SELECT id, title, category FROM knowledge_entries').all();
  
  for (const entry of allEntries) {
    // 检查分类
    if (FORBIDDEN_CATEGORIES.includes(entry.category)) {
      toDelete.push({ ...entry, reason: `分类: ${entry.category}` });
      continue;
    }
    
    // 检查标题关键词
    for (const keyword of FORBIDDEN_TITLE_KEYWORDS) {
      if (entry.title && entry.title.includes(keyword)) {
        toDelete.push({ ...entry, reason: `关键词: ${keyword}` });
        break;
      }
    }
  }
  
  console.log(`\n🗑️ 找到 ${toDelete.length} 条需要删除的数据:`);
  toDelete.forEach((e, i) => {
    console.log(`  ${i+1}. [${e.category}] ${e.title.substring(0, 50)}...`);
    console.log(`     原因: ${e.reason}`);
  });
  
  // 3. 执行删除
  if (toDelete.length > 0) {
    console.log('\n⚠️ 开始删除...');
    
    const deleteStmt = db.prepare('DELETE FROM knowledge_entries WHERE id = ?');
    let deleted = 0;
    
    for (const entry of toDelete) {
      deleteStmt.run(entry.id);
      deleted++;
    }
    
    console.log(`✅ 已删除 ${deleted} 条数据`);
    
    // 4. 显示清洗后的统计
    console.log('\n📊 清洗后知识库分类统计:');
    const newCategories = db.prepare(`
      SELECT category, COUNT(*) as count 
      FROM knowledge_entries 
      GROUP BY category 
      ORDER BY count DESC
    `).all();
    
    newCategories.forEach(c => {
      console.log(`  - ${c.category || '(无分类)'}: ${c.count} 条`);
    });
    
    const total = db.prepare('SELECT COUNT(*) as count FROM knowledge_entries').get();
    console.log(`\n📈 知识库总条目: ${total.count}`);
  } else {
    console.log('\n✅ 没有需要清洗的数据');
  }
  
  db.close();
  console.log('\n✅ 完成!');
}

main();
