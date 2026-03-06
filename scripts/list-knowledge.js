const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../data/memory_universe.db'));

const entries = db.prepare('SELECT id, title, category, summary FROM knowledge_entries ORDER BY fetched_at DESC').all();

console.log('📚 知识库全部内容 (' + entries.length + ' 条):\n');
entries.forEach((e, i) => {
  console.log((i+1) + '. [' + e.category + '] ' + e.title);
  if (e.summary) {
    console.log('   摘要: ' + e.summary.substring(0, 100) + (e.summary.length > 100 ? '...' : ''));
  }
  console.log('');
});

db.close();
