/**
 * 知识库数据清洗脚本
 * 删除不适合直播的内容（如法律、政治等敏感话题）
 */

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, '../data/memory_universe.db');

// 需要删除的分类关键词
const FORBIDDEN_CATEGORIES = [
  '法律', '法规', '律师', '诉讼', '法院',
  '政治', '政府', '政策',
  '宗教', '信仰',
  '军事', '战争',
  '色情', '成人',
  '赌博', '博彩'
];

// 需要删除的标题关键词
const FORBIDDEN_TITLE_KEYWORDS = [
  '法律', '法规', '律师', '诉讼', '法院', '判决', '刑法', '民法',
  '政治', '政府', '政策', '选举', '党',
  '宗教', '佛教', '基督', '伊斯兰',
  '军事', '战争', '武器',
  '色情', '成人', '18禁',
  '赌博', '博彩', '彩票'
];

async function main() {
  console.log('🔍 连接数据库...');
  const db = new Database(DB_PATH);
  
  // 1. 查看所有分类
  console.log('\n📊 当前知识库分类统计:');
  const categories = db.prepare(`
    SELECT category, COUNT(*) as count 
    FROM knowledge_entries 
    GROUP BY category 
    ORDER BY count DESC
  `).all() as { category: string; count: number }[];
  
  categories.forEach(c => {
    console.log(`  - ${c.category || '(无分类)'}: ${c.count} 条`);
  });
  
  // 2. 查找需要删除的条目
  console.log('\n🔍 查找需要清洗的数据...');
  
  // 按分类查找
  const categoryConditions = FORBIDDEN_CATEGORIES.map(c => `category LIKE '%${c}%'`).join(' OR ');
  const byCategory = db.prepare(`
    SELECT id, title, category FROM knowledge_entries 
    WHERE ${categoryConditions}
  `).all() as { id: string; title: string; category: string }[];
  
  console.log(`\n📁 按分类匹配到 ${byCategory.length} 条:`);
  byCategory.slice(0, 10).forEach(e => {
    console.log(`  - [${e.category}] ${e.title}`);
  });
  if (byCategory.length > 10) {
    console.log(`  ... 还有 ${byCategory.length - 10} 条`);
  }
  
  // 按标题关键词查找
  const titleConditions = FORBIDDEN_TITLE_KEYWORDS.map(k => `title LIKE '%${k}%'`).join(' OR ');
  const byTitle = db.prepare(`
    SELECT id, title, category FROM knowledge_entries 
    WHERE ${titleConditions}
  `).all() as { id: string; title: string; category: string }[];
  
  console.log(`\n📝 按标题关键词匹配到 ${byTitle.length} 条:`);
  byTitle.slice(0, 10).forEach(e => {
    console.log(`  - [${e.category}] ${e.title}`);
  });
  if (byTitle.length > 10) {
    console.log(`  ... 还有 ${byTitle.length - 10} 条`);
  }
  
  // 合并去重
  const toDeleteIds = new Set<string>();
  byCategory.forEach(e => toDeleteIds.add(e.id));
  byTitle.forEach(e => toDeleteIds.add(e.id));
  
  console.log(`\n🗑️ 总共需要删除 ${toDeleteIds.size} 条数据`);
  
  // 3. 确认删除
  if (toDeleteIds.size > 0) {
    console.log('\n⚠️ 开始删除...');
    
    const deleteStmt = db.prepare('DELETE FROM knowledge_entries WHERE id = ?');
    let deleted = 0;
    
    for (const id of toDeleteIds) {
      deleteStmt.run(id);
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
    `).all() as { category: string; count: number }[];
    
    newCategories.forEach(c => {
      console.log(`  - ${c.category || '(无分类)'}: ${c.count} 条`);
    });
    
    const total = db.prepare('SELECT COUNT(*) as count FROM knowledge_entries').get() as { count: number };
    console.log(`\n📈 知识库总条目: ${total.count}`);
  }
  
  db.close();
  console.log('\n✅ 完成!');
}

main().catch(console.error);
