# -*- coding: utf-8 -*-
"""
Reflection Engine - 反思引擎
负责：自我评估、错误分析、在线学习、性能优化
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

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'reflection.db')
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

def init_db():
    """初始化数据库"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # 反馈记录表
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS feedback_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            feedback_type TEXT NOT NULL,
            value REAL NOT NULL,
            context TEXT,
            timestamp REAL NOT NULL,
            processed BOOLEAN DEFAULT 0
        )
    ''')
    
    # 错误分析表
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS error_analysis (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            error_type TEXT NOT NULL,
            description TEXT,
            input_text TEXT,
            output_text TEXT,
            timestamp REAL NOT NULL,
            severity REAL DEFAULT 0.5,
            resolved BOOLEAN DEFAULT 0
        )
    ''')
    
    # 性能指标表
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS performance_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            metric_name TEXT NOT NULL,
            value REAL NOT NULL,
            timestamp REAL NOT NULL
        )
    ''')
    
    # 学习记录表
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS learning_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson TEXT NOT NULL,
            category TEXT,
            confidence REAL DEFAULT 0.5,
            timestamp REAL NOT NULL,
            applied_count INTEGER DEFAULT 0
        )
    ''')
    
    conn.commit()
    conn.close()

init_db()

# ==================== 反思引擎 ====================

@dataclass
class ReflectionState:
    """反思状态"""
    total_feedback: int = 0
    positive_feedback: int = 0
    negative_feedback: int = 0
    error_count: int = 0
    learning_count: int = 0
    average_performance: float = 0.5
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

reflection_state = ReflectionState()

class ReflectionEngine:
    """反思引擎"""
    
    def __init__(self):
        self.feedback_threshold = 5  # 累积多少反馈后进行反思
        self.error_severity_threshold = 0.7  # 严重错误阈值
    
    def process_feedback(self, feedback_type: str, value: float, context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        处理反馈
        feedback_type: 'positive', 'negative', 'neutral'
        value: 0.0 - 1.0
        
        返回：
        {
            'feedback_id': int,
            'should_reflect': bool,
            'reflection': {...},
            'should_update_soul': bool,
            'soul_updates': {
                'emotion': {...},
                'drives': {...}
            }
        }
        """
        global reflection_state
        
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # 记录反馈
        timestamp = time.time()
        context_json = json.dumps(context or {}, ensure_ascii=False)
        
        cursor.execute('''
            INSERT INTO feedback_log (feedback_type, value, context, timestamp)
            VALUES (?, ?, ?, ?)
        ''', (feedback_type, value, context_json, timestamp))
        
        feedback_id = cursor.lastrowid
        
        # 更新统计
        reflection_state.total_feedback += 1
        if feedback_type == 'positive':
            reflection_state.positive_feedback += 1
        elif feedback_type == 'negative':
            reflection_state.negative_feedback += 1
        
        conn.commit()
        conn.close()
        
        # 检查是否需要反思
        should_reflect = reflection_state.total_feedback % self.feedback_threshold == 0
        
        reflection_result = None
        soul_updates = None
        
        if should_reflect:
            reflection_result = self.reflect()
            # 生成 Soul State 更新建议
            soul_updates = self._generate_soul_updates(reflection_result)
        
        return {
            'feedback_id': feedback_id,
            'should_reflect': should_reflect,
            'reflection': reflection_result,
            'should_update_soul': soul_updates is not None,
            'soul_updates': soul_updates
        }
    
    def reflect(self) -> Dict[str, Any]:
        """
        执行反思
        分析最近的反馈和错误，生成改进建议
        """
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # 分析最近的反馈
        cursor.execute('''
            SELECT feedback_type, AVG(value), COUNT(*)
            FROM feedback_log
            WHERE processed = 0
            GROUP BY feedback_type
        ''')
        
        feedback_summary = {}
        for row in cursor.fetchall():
            feedback_summary[row[0]] = {
                'average': row[1],
                'count': row[2]
            }
        
        # 分析错误
        cursor.execute('''
            SELECT error_type, COUNT(*), AVG(severity)
            FROM error_analysis
            WHERE resolved = 0
            GROUP BY error_type
        ''')
        
        error_summary = {}
        for row in cursor.fetchall():
            error_summary[row[0]] = {
                'count': row[1],
                'average_severity': row[2]
            }
        
        # 生成改进建议
        improvements = self._generate_improvements(feedback_summary, error_summary)
        
        # 标记反馈为已处理
        cursor.execute('UPDATE feedback_log SET processed = 1 WHERE processed = 0')
        
        # 记录学习
        for improvement in improvements:
            self._record_learning(cursor, improvement)
        
        conn.commit()
        conn.close()
        
        return {
            'feedback_summary': feedback_summary,
            'error_summary': error_summary,
            'improvements': improvements,
            'timestamp': time.time()
        }
    
    def _generate_improvements(self, feedback_summary: Dict, error_summary: Dict) -> List[str]:
        """生成改进建议"""
        improvements = []
        
        # 基于反馈生成建议
        if 'negative' in feedback_summary:
            neg_count = feedback_summary['negative']['count']
            if neg_count > 3:
                improvements.append('检测到较多负面反馈，需要调整回复策略')
        
        if 'positive' in feedback_summary:
            pos_avg = feedback_summary['positive']['average']
            if pos_avg > 0.7:
                improvements.append('正面反馈良好，继续保持当前风格')
        
        # 基于错误生成建议
        for error_type, stats in error_summary.items():
            if stats['average_severity'] > 0.7:
                improvements.append(f'严重错误类型：{error_type}，需要优先修复')
        
        return improvements
    
    def _generate_soul_updates(self, reflection_result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        根据反思结果生成 Soul State 更新建议
        
        返回：
        {
            'emotion': {
                'joy': 0.6,
                'sadness': 0.1,
                ...
            },
            'drives': {
                'boredom': 0.3,
                'curiosity': 0.6,
                ...
            }
        }
        """
        if not reflection_result:
            return None
        
        feedback_summary = reflection_result.get('feedback_summary', {})
        error_summary = reflection_result.get('error_summary', {})
        
        # 初始化更新
        soul_updates = {
            'emotion': {},
            'drives': {}
        }
        
        # 基于反馈调整情绪
        if 'positive' in feedback_summary:
            pos_avg = feedback_summary['positive']['average']
            # 正面反馈多 → 增加快乐
            soul_updates['emotion']['joy'] = min(1.0, 0.5 + pos_avg * 0.3)
            soul_updates['emotion']['sadness'] = max(0, 0.1 - pos_avg * 0.05)
        
        if 'negative' in feedback_summary:
            neg_avg = feedback_summary['negative']['average']
            # 负面反馈多 → 增加悲伤
            soul_updates['emotion']['sadness'] = min(1.0, 0.1 + neg_avg * 0.3)
            soul_updates['emotion']['joy'] = max(0, 0.5 - neg_avg * 0.2)
        
        # 基于错误调整驱动力
        if error_summary:
            # 有错误 → 增加好奇心（想要改进）
            soul_updates['drives']['curiosity'] = min(1.0, 0.5 + len(error_summary) * 0.1)
            # 有错误 → 减少无聊（有事要做）
            soul_updates['drives']['boredom'] = max(0, 0.3 - len(error_summary) * 0.05)
        
        # 基于改进建议调整
        improvements = reflection_result.get('improvements', [])
        if improvements:
            # 有改进建议 → 增加期待
            soul_updates['emotion']['anticipation'] = min(1.0, 0.3 + len(improvements) * 0.1)
        
        return soul_updates if (soul_updates['emotion'] or soul_updates['drives']) else None
    
    def _record_learning(self, cursor, lesson: str):
        """记录学习内容"""
        global reflection_state
        
        timestamp = time.time()
        cursor.execute('''
            INSERT INTO learning_log (lesson, timestamp)
            VALUES (?, ?)
        ''', (lesson, timestamp))
        
        reflection_state.learning_count += 1
    
    def log_error(self, error_type: str, description: str, 
                  input_text: str = '', output_text: str = '', severity: float = 0.5) -> int:
        """记录错误"""
        global reflection_state
        
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        timestamp = time.time()
        cursor.execute('''
            INSERT INTO error_analysis 
            (error_type, description, input_text, output_text, timestamp, severity)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (error_type, description, input_text, output_text, timestamp, severity))
        
        error_id = cursor.lastrowid
        reflection_state.error_count += 1
        
        conn.commit()
        conn.close()
        
        # 严重错误立即反思
        if severity >= self.error_severity_threshold:
            self.reflect()
        
        return error_id
    
    def record_metric(self, metric_name: str, value: float):
        """记录性能指标"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        timestamp = time.time()
        cursor.execute('''
            INSERT INTO performance_metrics (metric_name, value, timestamp)
            VALUES (?, ?, ?)
        ''', (metric_name, value, timestamp))
        
        conn.commit()
        conn.close()
    
    def get_performance_summary(self, hours: int = 24) -> Dict[str, Any]:
        """获取性能摘要"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        cutoff_time = time.time() - (hours * 3600)
        
        # 获取各指标的平均值
        cursor.execute('''
            SELECT metric_name, AVG(value), COUNT(*)
            FROM performance_metrics
            WHERE timestamp > ?
            GROUP BY metric_name
        ''', (cutoff_time,))
        
        metrics = {}
        for row in cursor.fetchall():
            metrics[row[0]] = {
                'average': row[1],
                'count': row[2]
            }
        
        conn.close()
        return metrics
    
    def get_learning_history(self, limit: int = 10) -> List[Dict[str, Any]]:
        """获取学习历史"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT id, lesson, category, confidence, timestamp, applied_count
            FROM learning_log
            ORDER BY timestamp DESC
            LIMIT ?
        ''', (limit,))
        
        history = []
        for row in cursor.fetchall():
            history.append({
                'id': row[0],
                'lesson': row[1],
                'category': row[2],
                'confidence': row[3],
                'timestamp': row[4],
                'applied_count': row[5]
            })
        
        conn.close()
        return history

# 全局引擎
reflection_engine = ReflectionEngine()

# ==================== API 路由 ====================

@app.route('/feedback', methods=['POST'])
def process_feedback():
    """处理反馈"""
    data = request.json or {}
    feedback_type = data.get('type', 'neutral')
    value = data.get('value', 0.5)
    context = data.get('context', {})
    
    result = reflection_engine.process_feedback(feedback_type, value, context)
    
    return jsonify({
        'success': True,
        **result
    })

@app.route('/reflect', methods=['POST'])
def trigger_reflection():
    """手动触发反思"""
    result = reflection_engine.reflect()
    
    return jsonify({
        'success': True,
        'reflection': result
    })

@app.route('/error', methods=['POST'])
def log_error():
    """记录错误"""
    data = request.json or {}
    error_type = data.get('type', 'unknown')
    description = data.get('description', '')
    input_text = data.get('input_text', '')
    output_text = data.get('output_text', '')
    severity = data.get('severity', 0.5)
    
    error_id = reflection_engine.log_error(
        error_type, description, input_text, output_text, severity
    )
    
    return jsonify({
        'success': True,
        'error_id': error_id
    })

@app.route('/metric', methods=['POST'])
def record_metric():
    """记录性能指标"""
    data = request.json or {}
    metric_name = data.get('name', '')
    value = data.get('value', 0)
    
    if not metric_name:
        return jsonify({'error': 'metric name is required'}), 400
    
    reflection_engine.record_metric(metric_name, value)
    
    return jsonify({
        'success': True,
        'metric': metric_name,
        'value': value
    })

@app.route('/performance', methods=['GET'])
def get_performance():
    """获取性能摘要"""
    hours = int(request.args.get('hours', 24))
    summary = reflection_engine.get_performance_summary(hours)
    
    return jsonify({
        'success': True,
        'summary': summary,
        'hours': hours
    })

@app.route('/learning', methods=['GET'])
def get_learning():
    """获取学习历史"""
    limit = int(request.args.get('limit', 10))
    history = reflection_engine.get_learning_history(limit)
    
    return jsonify({
        'success': True,
        'history': history,
        'count': len(history)
    })

@app.route('/state', methods=['GET'])
def get_state():
    """获取反思状态"""
    return jsonify({
        'success': True,
        'state': reflection_state.to_dict()
    })

@app.route('/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({
        'status': 'healthy',
        'service': 'reflection-engine',
        'uptime': time.time()
    })

# ==================== 启动 ====================

if __name__ == '__main__':
    port = int(os.environ.get('REFLECTION_ENGINE_PORT', 4011))
    
    print(f"""
╔════════════════════════════════════════════════════════════╗
║          Reflection Engine - 反思引擎服务                   ║
╠════════════════════════════════════════════════════════════╣
║  端口: {port}                                                  ║
║  功能: 自我评估 | 错误分析 | 在线学习 | 性能优化               ║
║  数据库: {DB_PATH}
╚════════════════════════════════════════════════════════════╝
    """)
    
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
