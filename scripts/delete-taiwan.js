const Database = require('better-sqlite3');
const db = new Database('data/memory_universe.db');
const result = db.prepare("DELETE FROM knowledge_entries WHERE title LIKE '%海警%' OR title LIKE '%台湾%'").run();
console.log('已删除', result.changes, '条台湾相关内容');
db.close();
