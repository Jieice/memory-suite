# -*- coding: utf-8 -*-
"""
Agent Core - 智能体核心
负责：思考、规划、决策、主动发言
"""

import os
import json
import time
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, asdict
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

app.config['JSON_AS_ASCII'] = False
app.config['JSONIFY_MIMETYPE'] = 'application/json; charset=utf-8'

# ==================== Agent 状态 ====================

@dataclass
class ThinkingState:
    """思考状态"""
    current_goal: Optional[str] = None
    plan_steps: List[str] = None
    reasoning_chain: List[str] = None
    confidence: float = 0.5
    
    def __post_init__(self):
        if self.plan_steps is None:
            self.plan_steps = []
        if self.reasoning_chain is None:
            self.reasoning_chain = []
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class ProactiveState:
    """主动发言状态"""
    last_proactive_time: float = 0.0
    proactive_count: int = 0
    topics_discussed: List[str] = None
    cooldown_seconds: float = 180.0  # 3分钟冷却
    
    def __post_init__(self):
        if self.topics_discussed is None:
            self.topics_discussed = []
    
    def can_proactive(self) -> bool:
        """检查是否可以主动发言"""
        elapsed = time.time() - self.last_proactive_time
        return elapsed >= self.cooldown_seconds
    
    def mark_proactive(self, topic: str):
        """标记已主动发言"""
        self.last_proactive_time = time.time()
        self.proactive_count += 1
        self.topics_discussed.append(topic)
        # 保留最近10个话题
        if len(self.topics_discussed) > 10:
            self.topics_discussed = self.topics_discussed[-10:]
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

# 全局状态
thinking_state = ThinkingState()
proactive_state = ProactiveState()

# ==================== 思考引擎 ====================

def analyze_situation(soul_state: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    """
    分析当前情况
    基于 Soul State 和上下文进行推理
    """
    emotion = soul_state.get('emotion', {})
    drives = soul_state.get('drives', {})
    
    # 分析情绪状态
    dominant_emotion = max(emotion.items(), key=lambda x: x[1])[0] if emotion else 'neutral'
    
    # 分析驱动力
    boredom = drives.get('boredom', 0)
    social_need = drives.get('social_need', 0)
    curiosity = drives.get('curiosity', 0)
    
    # 推理链
    reasoning = []
    
    if boredom > 0.7:
        reasoning.append("检测到高无聊度，需要寻找有趣话题")
    if social_need > 0.7:
        reasoning.append("社交需求高，应该主动互动")
    if curiosity > 0.6:
        reasoning.append("好奇心驱动，可以提问或探索")
    
    # 生成目标
    goal = None
    if boredom > 0.7 or social_need > 0.7:
        goal = "initiate_conversation"
    elif curiosity > 0.6:
        goal = "explore_topic"
    else:
        goal = "maintain_engagement"
    
    return {
        'dominant_emotion': dominant_emotion,
        'goal': goal,
        'reasoning': reasoning,
        'urgency': max(boredom, social_need, curiosity)
    }

def plan_action(goal: str, context: Dict[str, Any]) -> List[str]:
    """
    规划行动步骤
    """
    plans = {
        'initiate_conversation': [
            '选择合适的话题',
            '生成开场白',
            '等待观众回应'
        ],
        'explore_topic': [
            '提出问题',
            '引导讨论',
            '总结观点'
        ],
        'maintain_engagement': [
            '回应观众',
            '保持互动',
            '调整语气'
        ]
    }
    
    return plans.get(goal, ['观察情况', '适时回应'])

def should_proactive_speak(soul_state: Dict[str, Any], time_since_last: float) -> Tuple[bool, Optional[str]]:
    """
    判断是否应该主动发言
    返回：(是否发言, 话题)
    """
    global proactive_state
    
    # 检查冷却时间
    if not proactive_state.can_proactive():
        return False, None
    
    drives = soul_state.get('drives', {})
    boredom = drives.get('boredom', 0)
    social_need = drives.get('social_need', 0)
    
    # 决策逻辑
    should_speak = False
    topic = None
    
    # 条件1：无聊度过高
    if boredom > 0.75:
        should_speak = True
        topic = generate_topic('boredom', soul_state)
    
    # 条件2：社交需求高且长时间无互动
    elif social_need > 0.7 and time_since_last > 180:
        should_speak = True
        topic = generate_topic('social', soul_state)
    
    # 条件3：超长时间无互动（5分钟）
    elif time_since_last > 300:
        should_speak = True
        topic = generate_topic('timeout', soul_state)
    
    if should_speak and topic:
        proactive_state.mark_proactive(topic)
    
    return should_speak, topic

def generate_topic(reason: str, soul_state: Dict[str, Any]) -> str:
    """
    生成主动发言话题
    """
    topics = {
        'boredom': [
            '最近有什么有趣的事情吗？',
            '大家今天过得怎么样？',
            '有人想聊聊天吗？',
            '好安静啊，有人在吗？'
        ],
        'social': [
            '好久没和大家聊天了',
            '想念大家了',
            '有人在线吗？',
            '来聊聊天吧'
        ],
        'timeout': [
            '还有人在吗？',
            '大家都去哪了？',
            '好寂寞啊',
            '有人陪我说说话吗？'
        ]
    }
    
    import random
    topic_list = topics.get(reason, topics['boredom'])
    return random.choice(topic_list)

# ==================== API 路由 ====================

@app.route('/think', methods=['POST'])
def think():
    """
    思考接口
    输入：soul_state, context
    输出：分析结果、目标、计划
    """
    global thinking_state
    
    data = request.json or {}
    soul_state = data.get('soul_state', {})
    context = data.get('context', {})
    
    # 分析情况
    analysis = analyze_situation(soul_state, context)
    
    # 更新思考状态
    thinking_state.current_goal = analysis['goal']
    thinking_state.reasoning_chain = analysis['reasoning']
    thinking_state.confidence = min(1.0, analysis['urgency'])
    
    # 规划行动
    thinking_state.plan_steps = plan_action(analysis['goal'], context)
    
    return jsonify({
        'success': True,
        'analysis': analysis,
        'thinking_state': thinking_state.to_dict()
    })

@app.route('/plan', methods=['POST'])
def create_plan():
    """
    创建行动计划
    """
    data = request.json or {}
    goal = data.get('goal', 'maintain_engagement')
    context = data.get('context', {})
    
    steps = plan_action(goal, context)
    
    return jsonify({
        'success': True,
        'goal': goal,
        'steps': steps
    })

@app.route('/state', methods=['GET'])
def get_state():
    """获取当前状态"""
    return jsonify({
        'thinking': thinking_state.to_dict(),
        'proactive': proactive_state.to_dict()
    })

@app.route('/reset', methods=['POST'])
def reset():
    """重置状态"""
    global thinking_state, proactive_state
    thinking_state = ThinkingState()
    proactive_state = ProactiveState()
    return jsonify({'success': True})

@app.route('/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({
        'status': 'healthy',
        'service': 'agent-core',
        'uptime': time.time()
    })

# ==================== 启动 ====================

if __name__ == '__main__':
    port = int(os.environ.get('AGENT_CORE_PORT', 4009))
    
    print(f"""
╔════════════════════════════════════════════════════════════╗
║              Agent Core - 智能体核心服务                    ║
╠════════════════════════════════════════════════════════════╣
║  端口: {port}                                                  ║
║  功能: 思考 | 规划 | 决策 | 主动发言                          ║
╚════════════════════════════════════════════════════════════╝
    """)
    
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
