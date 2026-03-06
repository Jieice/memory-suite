# -*- coding: utf-8 -*-
"""
Memory System V2 - 记忆系统
负责：短期记忆、长期记忆、情景记忆、语义记忆
"""

import os
import json
import time
import sqlite3
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, asdict
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

app.config['JSON_AS_ASCII'] = False
app.config['JSONIFY_MIMETYPE'] = 'application/json; charset=utf-8'

# ==================== 数据库初始化 ====================

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'memory_v2.db')
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

def init_db():
    """初始化数据库"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # 短期记忆表（工作记忆，容量有限）
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS short_term_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            timestamp REAL NOT NULL,
            importance REAL DEFAULT 0.5,
            access_count INTEGER DEFAULT 0,
            last_access REAL
        )
    ''')
    
    # 长期记忆表（重要信息，永久存储）
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS long_term_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            category TEXT,
            timestamp REAL NOT NULL,
            importance REAL DEFAULT 0.5,
            access_count INTEGER DEFAULT 0,
            last_access REAL,
            tags TEXT
        )
    ''')
    
    # 情景记忆表（事件、对话）
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS episodic_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            user_text TEXT,
            ai_response TEXT,
            emotion_state TEXT,
            timestamp REAL NOT NULL,
            importance REAL DEFAULT 0.5
        )
    ''')
    
    # 语义记忆表（知识、概念）
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS semantic_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            concept TEXT NOT NULL,
            definition TEXT,
            related_concepts TEXT,
            timestamp REAL NOT NULL,
            confidence REAL DEFAULT 0.5
        )
    ''')
    
    conn.commit()
    conn.close()

init_db()

# ==================== 记忆管理 ====================

class MemoryManager:
    """记忆管理器"""
    
    def __init__(self):
        self.short_term_capacity = 20  # 短期记忆容量
        self.consolidation_threshold = 0.7  # 巩固阈值
    
    def add_short_term(self, content: str, importance: float = 0.5) -> int:
        """添加短期记忆"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        timestamp = time.time()
        cursor.execute('''
            INSERT INTO short_term_memory (content, timestamp, importance, last_access)
            VALUES (?, ?, ?, ?)
        ''', (content, timestamp, importance, timestamp))
        
        memory_id = cursor.lastrowid
        conn.commit()
        
        # 检查容量，清理旧记忆
        self._cleanup_short_term(cursor)
        
        conn.commit()
        conn.close()
        
        return memory_id
    
    def _cleanup_short_term(self, cursor):
        """清理短期记忆（保留最重要的）"""
        cursor.execute('SELECT COUNT(*) FROM short_term_memory')
        count = cursor.fetchone()[0]
        
        if count > self.short_term_capacity:
            # 删除最不重要且最久未访问的记忆
            cursor.execute('''
                DELETE FROM short_term_memory
                WHERE id IN (
                    SELECT id FROM short_term_memory
                    ORDER BY importance ASC, last_access ASC
                    LIMIT ?
                )
            ''', (count - self.short_term_capacity,))
    
    def consolidate_memory(self, memory_id: int):
        """巩固记忆（短期 → 长期）"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # 获取短期记忆
        cursor.execute('''
            SELECT content, importance, timestamp
            FROM short_term_memory
            WHERE id = ?
        ''', (memory_id,))
        
        row = cursor.fetchone()
        if row:
            content, importance, timestamp = row
            
            # 移动到长期记忆
            cursor.execute('''
                INSERT INTO long_term_memory (content, timestamp, importance, last_access)
                VALUES (?, ?, ?, ?)
            ''', (content, timestamp, importance, time.time()))
            
            # 删除短期记忆
            cursor.execute('DELETE FROM short_term_memory WHERE id = ?', (memory_id,))
        
        conn.commit()
        conn.close()
    
    def add_episodic(self, user_id: str, user_text: str, ai_response: str, 
                     emotion_state: Dict[str, Any], importance: float = 0.5) -> int:
        """添加情景记忆（对话）"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        timestamp = time.time()
        emotion_json = json.dumps(emotion_state, ensure_ascii=False)
        
        cursor.execute('''
            INSERT INTO episodic_memory 
            (user_id, user_text, ai_response, emotion_state, timestamp, importance)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (user_id, user_text, ai_response, emotion_json, timestamp, importance))
        
        memory_id = cursor.lastrowid
        conn.commit()
        conn.close()
        
        return memory_id
    
    def add_semantic(self, concept: str, definition: str, 
                     related_concepts: List[str] = None, confidence: float = 0.5) -> int:
        """添加语义记忆（知识）"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        timestamp = time.time()
        related_json = json.dumps(related_concepts or [], ensure_ascii=False)
        
        cursor.execute('''
            INSERT INTO semantic_memory 
            (concept, definition, related_concepts, timestamp, confidence)
            VALUES (?, ?, ?, ?, ?)
        ''', (concept, definition, related_json, timestamp, confidence))
        
        memory_id = cursor.lastrowid
        conn.commit()
        conn.close()
        
        return memory_id
    
    def recall_short_term(self, limit: int = 10) -> List[Dict[str, Any]]:
        """回忆短期记忆"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT id, content, timestamp, importance, access_count
            FROM short_term_memory
            ORDER BY importance DESC, timestamp DESC
            LIMIT ?
        ''', (limit,))
        
        memories = []
        for row in cursor.fetchall():
            memories.append({
                'id': row[0],
                'content': row[1],
                'timestamp': row[2],
                'importance': row[3],
                'access_count': row[4]
            })
        
        conn.close()
        return memories
    
    def recall_episodic(self, user_id: Optional[str] = None, limit: int = 10) -> List[Dict[str, Any]]:
        """回忆情景记忆"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        if user_id:
            cursor.execute('''
                SELECT id, user_id, user_text, ai_response, emotion_state, timestamp, importance
                FROM episodic_memory
                WHERE user_id = ?
                ORDER BY timestamp DESC
                LIMIT ?
            ''', (user_id, limit))
        else:
            cursor.execute('''
                SELECT id, user_id, user_text, ai_response, emotion_state, timestamp, importance
                FROM episodic_memory
                ORDER BY timestamp DESC
                LIMIT ?
            ''', (limit,))
        
        memories = []
        for row in cursor.fetchall():
            memories.append({
                'id': row[0],
                'user_id': row[1],
                'user_text': row[2],
                'ai_response': row[3],
                'emotion_state': json.loads(row[4]) if row[4] else {},
                'timestamp': row[5],
                'importance': row[6]
            })
        
        conn.close()
        return memories
    
    def search_semantic(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """搜索语义记忆"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT id, concept, definition, related_concepts, confidence
            FROM semantic_memory
            WHERE concept LIKE ? OR definition LIKE ?
            ORDER BY confidence DESC
            LIMIT ?
        ''', (f'%{query}%', f'%{query}%', limit))
        
        memories = []
        for row in cursor.fetchall():
            memories.append({
                'id': row[0],
                'concept': row[1],
                'definition': row[2],
                'related_concepts': json.loads(row[3]) if row[3] else [],
                'confidence': row[4]
            })
        
        conn.close()
        return memories
    
    def get_stats(self) -> Dict[str, Any]:
        """获取记忆统计"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        stats = {}
        
        for table in ['short_term_memory', 'long_term_memory', 'episodic_memory', 'semantic_memory']:
            cursor.execute(f'SELECT COUNT(*) FROM {table}')
            stats[table] = cursor.fetchone()[0]
        
        conn.close()
        return stats

# 全局管理器
memory_manager = MemoryManager()

# ==================== API 路由 ====================

@app.route('/add/short_term', methods=['POST'])
def add_short_term():
    """添加短期记忆"""
    data = request.json or {}
    content = data.get('content', '')
    importance = data.get('importance', 0.5)
    
    if not content:
        return jsonify({'error': 'content is required'}), 400
    
    memory_id = memory_manager.add_short_term(content, importance)
    
    return jsonify({
        'success': True,
        'memory_id': memory_id,
        'type': 'short_term'
    })

@app.route('/add/episodic', methods=['POST'])
def add_episodic():
    """添加情景记忆"""
    data = request.json or {}
    user_id = data.get('user_id', 'unknown')
    user_text = data.get('user_text', '')
    ai_response = data.get('ai_response', '')
    emotion_state = data.get('emotion_state', {})
    importance = data.get('importance', 0.5)
    
    memory_id = memory_manager.add_episodic(
        user_id, user_text, ai_response, emotion_state, importance
    )
    
    return jsonify({
        'success': True,
        'memory_id': memory_id,
        'type': 'episodic'
    })

@app.route('/add/semantic', methods=['POST'])
def add_semantic():
    """添加语义记忆"""
    data = request.json or {}
    concept = data.get('concept', '')
    definition = data.get('definition', '')
    related_concepts = data.get('related_concepts', [])
    confidence = data.get('confidence', 0.5)
    
    if not concept:
        return jsonify({'error': 'concept is required'}), 400
    
    memory_id = memory_manager.add_semantic(
        concept, definition, related_concepts, confidence
    )
    
    return jsonify({
        'success': True,
        'memory_id': memory_id,
        'type': 'semantic'
    })

@app.route('/recall/short_term', methods=['GET'])
def recall_short_term():
    """回忆短期记忆"""
    limit = int(request.args.get('limit', 10))
    memories = memory_manager.recall_short_term(limit)
    
    return jsonify({
        'success': True,
        'memories': memories,
        'count': len(memories)
    })

@app.route('/recall/episodic', methods=['GET'])
def recall_episodic():
    """回忆情景记忆"""
    user_id = request.args.get('user_id')
    limit = int(request.args.get('limit', 10))
    
    memories = memory_manager.recall_episodic(user_id, limit)
    
    return jsonify({
        'success': True,
        'memories': memories,
        'count': len(memories)
    })

@app.route('/search/semantic', methods=['GET'])
def search_semantic():
    """搜索语义记忆"""
    query = request.args.get('query', '')
    limit = int(request.args.get('limit', 5))
    
    if not query:
        return jsonify({'error': 'query is required'}), 400
    
    memories = memory_manager.search_semantic(query, limit)
    
    return jsonify({
        'success': True,
        'memories': memories,
        'count': len(memories)
    })

@app.route('/memory/store', methods=['POST'])
def store_memory():
    """
    统一的记忆存储接口
    根据内容类型自动分类存储
    
    POST /memory/store
    {
        "content": "用户输入或AI回复",
        "source": "danmaku|creator|system",
        "userId": "user_id",
        "type": "auto|episodic|semantic|short_term",  # auto 表示自动分类
        "metadata": {
            "emotion": {...},
            "drives": {...},
            "mood_instruction": "..."
        }
    }
    """
    data = request.json or {}
    content = data.get('content', '')
    source = data.get('source', 'unknown')
    user_id = data.get('userId', 'anonymous')
    memory_type = data.get('type', 'auto')
    metadata = data.get('metadata', {})
    
    if not content:
        return jsonify({'error': 'content is required'}), 400
    
    try:
        memory_id = None
        stored_type = None
        
        # 自动分类逻辑
        if memory_type == 'auto':
            # 简单的分类规则
            if source == 'danmaku' or source == 'creator':
                # 对话内容 → 情景记忆
                memory_type = 'episodic'
            elif len(content) > 100 and ('是' in content or '定义' in content or '概念' in content):
                # 长文本且包含定义性内容 → 语义记忆
                memory_type = 'semantic'
            else:
                # 默认 → 短期记忆
                memory_type = 'short_term'
        
        # 根据类型存储
        if memory_type == 'episodic':
            # 情景记忆（对话）
            ai_response = data.get('ai_response', '')
            emotion_state = metadata.get('emotion', {})
            importance = data.get('importance', 0.5)
            
            memory_id = memory_manager.add_episodic(
                user_id=user_id,
                user_text=content,
                ai_response=ai_response,
                emotion_state=emotion_state,
                importance=importance
            )
            stored_type = 'episodic'
            print(f"[Memory] 存储情景记忆: {content[:50]}... (user: {user_id})")
        
        elif memory_type == 'semantic':
            # 语义记忆（知识）
            concept = data.get('concept', content[:20])
            definition = content
            related_concepts = data.get('related_concepts', [])
            confidence = data.get('confidence', 0.5)
            
            memory_id = memory_manager.add_semantic(
                concept=concept,
                definition=definition,
                related_concepts=related_concepts,
                confidence=confidence
            )
            stored_type = 'semantic'
            print(f"[Memory] 存储语义记忆: {concept}")
        
        else:  # short_term
            # 短期记忆
            importance = data.get('importance', 0.5)
            memory_id = memory_manager.add_short_term(content, importance)
            stored_type = 'short_term'
            print(f"[Memory] 存储短期记忆: {content[:50]}...")
        
        return jsonify({
            'success': True,
            'memory_id': memory_id,
            'type': stored_type,
            'source': source,
            'userId': user_id
        })
    
    except Exception as e:
        print(f"[Memory] 存储失败: {e}")
        return jsonify({
            'error': str(e),
            'success': False
        }), 500

@app.route('/stats', methods=['GET'])
def get_stats():
    """获取统计信息"""
    stats = memory_manager.get_stats()
    
    return jsonify({
        'success': True,
        'stats': stats
    })

@app.route('/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({
        'status': 'healthy',
        'service': 'memory-system-v2',
        'uptime': time.time()
    })

# ==================== 启动 ====================

if __name__ == '__main__':
    port = int(os.environ.get('MEMORY_SYSTEM_V2_PORT', 4010))
    
    print(f"""
╔════════════════════════════════════════════════════════════╗
║           Memory System V2 - 记忆系统服务                   ║
╠════════════════════════════════════════════════════════════╣
║  端口: {port}                                                  ║
║  功能: 短期记忆 | 长期记忆 | 情景记忆 | 语义记忆               ║
║  数据库: {DB_PATH}
╚════════════════════════════════════════════════════════════╝
    """)
    
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
