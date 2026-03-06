# -*- coding: utf-8 -*-
"""
Prediction Engine - 群体智能预测引擎
基于 OASIS/MiroFish 的多智能体模拟系统

功能：
- 实时预测互动效果
- 舆情模拟与风险评估
- 策略优化建议
- 与 Memory System 深度集成
"""

import os
import json
import time
import asyncio
import requests
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, asdict, field
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
import threading

app = Flask(__name__)
CORS(app)

app.config['JSON_AS_ASCII'] = False
app.config['JSONIFY_MIMETYPE'] = 'application/json; charset=utf-8'

# ==================== 配置 ====================

MEMORY_SYSTEM_V2_URL = os.environ.get('MEMORY_SYSTEM_V2_URL', 'http://127.0.0.1:4010')
AGENT_CORE_URL = os.environ.get('AGENT_CORE_URL', 'http://127.0.0.1:4009')
REFLECTION_ENGINE_URL = os.environ.get('REFLECTION_ENGINE_URL', 'http://127.0.0.1:4011')

# 预测引擎配置
PREDICTION_AGENT_COUNT = int(os.environ.get('PREDICTION_AGENT_COUNT', 1000))  # 默认1000个虚拟观众
PREDICTION_CACHE_TTL = int(os.environ.get('PREDICTION_CACHE_TTL', 300))  # 缓存5分钟
PREDICTION_ENABLED = os.environ.get('PREDICTION_ENABLED', 'true').lower() == 'true'

# ==================== 数据结构 ====================

@dataclass
class VirtualAgent:
    """虚拟观众智能体"""
    id: str
    personality: Dict[str, float]  # Big Five
    interests: List[str]
    activity_level: float  # 活跃度 0-1
    sentiment: float  # 情绪 -1 到 1
    
    def react_to_content(self, content: str, context: Dict[str, Any]) -> Dict[str, Any]:
        """对内容做出反应"""
        # 简化版反应模型
        reaction_score = 0.5
        
        # 基于兴趣匹配
        for interest in self.interests:
            if interest.lower() in content.lower():
                reaction_score += 0.2
        
        # 基于人格特质
        if self.personality.get('extraversion', 0.5) > 0.7:
            reaction_score += 0.1  # 外向者更容易互动
        
        # 基于活跃度
        reaction_score *= self.activity_level
        
        # 限制在 0-1
        reaction_score = max(0, min(1, reaction_score))
        
        # 决定行为
        will_interact = reaction_score > 0.5
        will_like = reaction_score > 0.6
        will_comment = reaction_score > 0.7
        
        return {
            'agent_id': self.id,
            'reaction_score': reaction_score,
            'will_interact': will_interact,
            'will_like': will_like,
            'will_comment': will_comment,
            'sentiment_change': (reaction_score - 0.5) * 0.2
        }

@dataclass
class PredictionResult:
    """预测结果"""
    scenario: str
    timestamp: float
    expected_interaction_rate: float  # 预期互动率
    expected_positive_rate: float  # 预期正面反馈率
    risk_level: str  # low, medium, high
    risk_factors: List[str]
    recommendations: List[str]
    agent_reactions: List[Dict[str, Any]]
    confidence: float
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class SimulationState:
    """模拟状态"""
    agents: List[VirtualAgent] = field(default_factory=list)
    history: List[Dict[str, Any]] = field(default_factory=list)
    cache: Dict[str, PredictionResult] = field(default_factory=dict)
    last_update: float = 0.0
    
    def get_cached_prediction(self, key: str) -> Optional[PredictionResult]:
        """获取缓存的预测"""
        if key in self.cache:
            result = self.cache[key]
            if time.time() - result.timestamp < PREDICTION_CACHE_TTL:
                return result
            else:
                del self.cache[key]
        return None
    
    def cache_prediction(self, key: str, result: PredictionResult):
        """缓存预测结果"""
        self.cache[key] = result

# 全局状态
simulation_state = SimulationState()

# ==================== 智能体生成 ====================

def generate_virtual_agents(count: int, historical_data: Optional[List[Dict]] = None) -> List[VirtualAgent]:
    """
    生成虚拟观众智能体
    基于历史数据构建真实的观众画像
    """
    import random
    
    agents = []
    
    # 如果有历史数据，分析观众特征
    if historical_data:
        # 从历史弹幕分析观众兴趣、活跃度等
        audience_interests = {}
        audience_activity = {}
        
        for msg in historical_data:
            user_id = msg.get('userId', 'unknown')
            
            # 统计兴趣（简单关键词匹配）
            interests = msg.get('interests', [])
            for interest in interests:
                if interest not in audience_interests:
                    audience_interests[interest] = 0
                audience_interests[interest] += 1
            
            # 统计活跃度
            if user_id not in audience_activity:
                audience_activity[user_id] = 0
            audience_activity[user_id] += 1
        
        # 计算兴趣分布
        total_interests = sum(audience_interests.values()) if audience_interests else 1
        interest_distribution = {k: v / total_interests for k, v in audience_interests.items()}
        
        # 计算活跃度分布
        avg_activity = sum(audience_activity.values()) / len(audience_activity) if audience_activity else 1
    
    # 生成虚拟观众
    for i in range(count):
        # 随机生成人格特质（Big Five）
        personality = {
            'openness': random.uniform(0.3, 0.9),
            'conscientiousness': random.uniform(0.3, 0.8),
            'extraversion': random.uniform(0.2, 0.9),
            'agreeableness': random.uniform(0.3, 0.8),
            'neuroticism': random.uniform(0.2, 0.7)
        }
        
        # 根据历史数据调整兴趣分布
        if historical_data and audience_interests:
            # 70%概率使用历史兴趣，30%随机
            if random.random() < 0.7:
                # 从历史兴趣中随机选择
                top_interests = sorted(interest_distribution.items(), key=lambda x: x[1], reverse=True)[:5]
                interests = [item[0] for item in top_interests]
            else:
                all_interests = ['游戏', '音乐', '动漫', '科技', '美食', '旅游', '电影', '运动', '学习', '聊天']
                interests = random.sample(all_interests, k=random.randint(2, 5))
        else:
            # 随机兴趣标签
            all_interests = ['游戏', '音乐', '动漫', '科技', '美食', '旅游', '电影', '运动', '学习', '聊天']
            interests = random.sample(all_interests, k=random.randint(2, 5))
        
        # 根据历史数据调整活跃度
        if historical_data and audience_activity:
            # 基于历史活跃度生成
            activity_level = min(1.0, random.gauss(avg_activity, 0.2))
        else:
            # 活跃度（符合幂律分布：少数人很活跃，多数人潜水）
            activity_level = random.betavariate(2, 5)  # 偏向低活跃度
        
        # 初始情绪（略微正面）
        sentiment = random.uniform(0.3, 0.7)
        
        agent = VirtualAgent(
            id=f"agent_{i}",
            personality=personality,
            interests=interests,
            activity_level=activity_level,
            sentiment=sentiment
        )
        agents.append(agent)
    
    return agents

# ==================== 预测引擎核心 ====================

def predict_interaction(content: str, context: Dict[str, Any]) -> PredictionResult:
    """
    预测互动效果
    """
    global simulation_state
    
    # 检查缓存
    cache_key = f"interaction_{hash(content)}"
    cached = simulation_state.get_cached_prediction(cache_key)
    if cached:
        print(f"[Prediction] Using cached result for: {content[:30]}...")
        return cached
    
    # 确保有虚拟观众
    if not simulation_state.agents:
        print(f"[Prediction] Generating {PREDICTION_AGENT_COUNT} virtual agents...")
        simulation_state.agents = generate_virtual_agents(PREDICTION_AGENT_COUNT)
    
    # 让所有虚拟观众对内容做出反应
    reactions = []
    for agent in simulation_state.agents:
        reaction = agent.react_to_content(content, context)
        reactions.append(reaction)
    
    # 统计结果
    total_agents = len(reactions)
    interacting_agents = sum(1 for r in reactions if r['will_interact'])
    liking_agents = sum(1 for r in reactions if r['will_like'])
    commenting_agents = sum(1 for r in reactions if r['will_comment'])
    
    interaction_rate = interacting_agents / total_agents if total_agents > 0 else 0
    positive_rate = liking_agents / total_agents if total_agents > 0 else 0
    
    # 风险评估
    risk_level = 'low'
    risk_factors = []
    
    if interaction_rate < 0.2:
        risk_level = 'high'
        risk_factors.append('预期互动率过低，可能无人回应')
    elif interaction_rate < 0.4:
        risk_level = 'medium'
        risk_factors.append('互动率偏低')
    
    if positive_rate < 0.3:
        risk_factors.append('正面反馈率低，可能引发负面情绪')
    
    # 生成建议
    recommendations = []
    if interaction_rate < 0.3:
        recommendations.append('建议选择更有趣或更贴近观众兴趣的话题')
    if positive_rate < 0.4:
        recommendations.append('建议调整语气，增加正面情绪表达')
    if commenting_agents < total_agents * 0.1:
        recommendations.append('建议增加互动性问题，引导观众评论')
    
    if not recommendations:
        recommendations.append('预期效果良好，可以继续')
    
    # 构建结果
    result = PredictionResult(
        scenario='interaction_prediction',
        timestamp=time.time(),
        expected_interaction_rate=interaction_rate,
        expected_positive_rate=positive_rate,
        risk_level=risk_level,
        risk_factors=risk_factors,
        recommendations=recommendations,
        agent_reactions=reactions[:10],  # 只返回前10个样本
        confidence=0.7  # 简化版置信度
    )
    
    # 缓存结果
    simulation_state.cache_prediction(cache_key, result)
    
    return result

def predict_sentiment_evolution(scenario: str, duration_minutes: int = 5) -> Dict[str, Any]:
    """
    预测舆情演化
    模拟一段时间内的情绪变化
    """
    global simulation_state
    
    if not simulation_state.agents:
        simulation_state.agents = generate_virtual_agents(PREDICTION_AGENT_COUNT)
    
    # 时间线模拟
    timeline = []
    current_sentiment = sum(a.sentiment for a in simulation_state.agents) / len(simulation_state.agents)
    
    for minute in range(duration_minutes):
        # 简化版：情绪会逐渐趋向中性
        current_sentiment = current_sentiment * 0.9 + 0.5 * 0.1
        
        timeline.append({
            'minute': minute,
            'average_sentiment': current_sentiment,
            'active_agents': int(len(simulation_state.agents) * 0.3 * (1 - minute / duration_minutes))
        })
    
    # 风险分析
    final_sentiment = timeline[-1]['average_sentiment']
    risk_analysis = {
        'final_sentiment': final_sentiment,
        'trend': 'declining' if final_sentiment < 0.5 else 'stable',
        'risk_level': 'high' if final_sentiment < 0.3 else 'low'
    }
    
    return {
        'scenario': scenario,
        'duration_minutes': duration_minutes,
        'timeline': timeline,
        'risk_analysis': risk_analysis,
        'recommendations': [
            '建议在前3分钟内积极互动' if risk_analysis['risk_level'] == 'high' else '保持当前策略'
        ]
    }

def optimize_strategy(goal: str, constraints: List[str]) -> Dict[str, Any]:
    """
    策略优化
    基于目标和约束，推荐最优策略
    """
    strategies = {
        'maximize_engagement': {
            'name': '最大化互动',
            'actions': [
                '提出开放性问题',
                '分享有趣的故事或观点',
                '回应观众评论',
                '使用表情和语气词增加亲和力'
            ],
            'expected_outcome': {
                'interaction_rate': 0.6,
                'positive_rate': 0.7,
                'duration': '持续15-20分钟'
            }
        },
        'build_community': {
            'name': '建立社区感',
            'actions': [
                '记住常客的名字和喜好',
                '创建内部梗和话题',
                '鼓励观众之间互动',
                '定期举办活动'
            ],
            'expected_outcome': {
                'retention_rate': 0.8,
                'loyalty_score': 0.75
            }
        },
        'content_quality': {
            'name': '提升内容质量',
            'actions': [
                '深入探讨话题',
                '提供独特见解',
                '保持专业性',
                '避免争议话题'
            ],
            'expected_outcome': {
                'satisfaction_rate': 0.85,
                'share_rate': 0.3
            }
        }
    }
    
    # 根据目标选择策略
    strategy = strategies.get(goal, strategies['maximize_engagement'])
    
    # 应用约束
    if 'no_controversial' in constraints:
        strategy['actions'] = [a for a in strategy['actions'] if '争议' not in a]
    
    return {
        'goal': goal,
        'optimal_strategy': strategy,
        'confidence': 0.75,
        'estimated_time': '10-15分钟'
    }

# ==================== API 路由 ====================

@app.route('/predict/interaction', methods=['POST'])
def api_predict_interaction():
    """
    预测互动效果
    POST /predict/interaction
    {
        "content": "今天想和大家聊聊游戏",
        "context": {
            "currentViewers": 150,
            "recentDanmaku": [...],
            "emotionState": {...}
        }
    }
    """
    if not PREDICTION_ENABLED:
        return jsonify({'error': 'Prediction engine is disabled'}), 503
    
    data = request.json or {}
    content = data.get('content', '')
    context = data.get('context', {})
    
    if not content:
        return jsonify({'error': 'content is required'}), 400
    
    try:
        result = predict_interaction(content, context)
        return jsonify({
            'success': True,
            'prediction': result.to_dict()
        })
    except Exception as e:
        print(f"[Prediction] Error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/predict/sentiment', methods=['POST'])
def api_predict_sentiment():
    """
    预测舆情演化
    POST /predict/sentiment
    {
        "scenario": "controversial_topic",
        "duration": 5
    }
    """
    if not PREDICTION_ENABLED:
        return jsonify({'error': 'Prediction engine is disabled'}), 503
    
    data = request.json or {}
    scenario = data.get('scenario', 'general')
    duration = data.get('duration', 5)
    
    try:
        result = predict_sentiment_evolution(scenario, duration)
        return jsonify({
            'success': True,
            'prediction': result
        })
    except Exception as e:
        print(f"[Prediction] Error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/predict/optimize', methods=['POST'])
def api_optimize_strategy():
    """
    策略优化
    POST /predict/optimize
    {
        "goal": "maximize_engagement",
        "constraints": ["no_controversial", "family_friendly"]
    }
    """
    if not PREDICTION_ENABLED:
        return jsonify({'error': 'Prediction engine is disabled'}), 503
    
    data = request.json or {}
    goal = data.get('goal', 'maximize_engagement')
    constraints = data.get('constraints', [])
    
    try:
        result = optimize_strategy(goal, constraints)
        return jsonify({
            'success': True,
            'optimization': result
        })
    except Exception as e:
        print(f"[Prediction] Error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/agents/generate', methods=['POST'])
def api_generate_agents():
    """
    生成虚拟观众
    POST /agents/generate
    {
        "count": 1000,
        "useHistoricalData": true
    }
    """
    global simulation_state
    
    data = request.json or {}
    count = data.get('count', PREDICTION_AGENT_COUNT)
    use_historical = data.get('useHistoricalData', False)
    
    historical_data = None
    if use_historical:
        # 从 Memory System 获取历史数据
        try:
            import requests
            memory_url = 'http://127.0.0.1:4002/memory/recent'
            response = requests.get(memory_url, params={'limit': 100, 'hours': 24}, timeout=2)
            if response.status_code == 200:
                data = response.json()
                if data.get('success'):
                    historical_data = data.get('memories', [])
                    print(f"[Prediction] 从 Memory System 获取到 {len(historical_data)} 条历史数据")
        except Exception as e:
            print(f"[Prediction] 从 Memory System 获取数据失败: {e}")
            historical_data = None
    
    simulation_state.agents = generate_virtual_agents(count, historical_data)
    simulation_state.last_update = time.time()
    
    return jsonify({
        'success': True,
        'agent_count': len(simulation_state.agents),
        'message': f'Generated {len(simulation_state.agents)} virtual agents'
    })

@app.route('/state', methods=['GET'])
def get_state():
    """获取当前状态"""
    return jsonify({
        'agent_count': len(simulation_state.agents),
        'cache_size': len(simulation_state.cache),
        'last_update': simulation_state.last_update,
        'enabled': PREDICTION_ENABLED
    })

@app.route('/reset', methods=['POST'])
def reset():
    """重置状态"""
    global simulation_state
    simulation_state = SimulationState()
    return jsonify({'success': True, 'message': 'Prediction engine reset'})

@app.route('/predict/should_say', methods=['POST'])
def api_predict_should_say():
    """
    判断是否应该说这句话（风险评估）
    POST /predict/should_say
    {
        "text": "今天想和大家聊聊游戏",
        "context": {
            "userId": "user_123",
            "source": "creator",
            "soulState": {...}
        }
    }
    
    返回：
    {
        "allowed": true/false,
        "reason": "拦截原因（如果被拦截）",
        "alternative": "替代建议（如果被拦截）",
        "confidence": 0.85,
        "prediction": {...}
    }
    """
    if not PREDICTION_ENABLED:
        return jsonify({
            'allowed': True,
            'reason': 'Prediction engine disabled',
            'confidence': 0.0
        }), 200
    
    data = request.json or {}
    text = data.get('text', '')
    context = data.get('context', {})
    
    if not text:
        return jsonify({'error': 'text is required'}), 400
    
    try:
        # 执行预测
        prediction = predict_interaction(text, context)
        
        # 风险评估逻辑
        allowed = True
        reason = None
        alternative = None
        
        # 高风险内容
        if prediction.risk_level == 'high':
            allowed = False
            reason = f"高风险：{', '.join(prediction.risk_factors)}"
            alternative = prediction.recommendations[0] if prediction.recommendations else '让我换个话题吧'
            print(f"[Prediction] 拦截高风险内容: {text[:50]}...")
        
        # 互动率过低
        elif prediction.expected_interaction_rate < 0.2:
            allowed = False
            reason = f"预期互动率过低 ({prediction.expected_interaction_rate * 100:.1f}%)"
            alternative = prediction.recommendations[0] if prediction.recommendations else '让我换个话题吧'
            print(f"[Prediction] 拦截低互动内容: {text[:50]}...")
        
        # 正面反馈率过低
        elif prediction.expected_positive_rate < 0.2:
            allowed = False
            reason = f"预期正面反馈率过低 ({prediction.expected_positive_rate * 100:.1f}%)"
            alternative = prediction.recommendations[0] if prediction.recommendations else '让我换个话题吧'
            print(f"[Prediction] 拦截低正面反馈内容: {text[:50]}...")
        
        if allowed:
            print(f"[Prediction] ✅ 内容通过检查: {text[:50]}... (互动率: {prediction.expected_interaction_rate * 100:.1f}%)")
        
        return jsonify({
            'allowed': allowed,
            'reason': reason,
            'alternative': alternative,
            'confidence': prediction.confidence,
            'prediction': prediction.to_dict()
        })
    
    except Exception as e:
        print(f"[Prediction] Error in should_say: {e}")
        return jsonify({
            'error': str(e),
            'allowed': True  # 降级：允许
        }), 500

@app.route('/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({
        'status': 'healthy',
        'service': 'prediction-engine',
        'agent_count': len(simulation_state.agents),
        'enabled': PREDICTION_ENABLED
    })

# ==================== 启动 ====================

if __name__ == '__main__':
    port = int(os.environ.get('PREDICTION_ENGINE_PORT', 4013))
    
    print(f"""
╔════════════════════════════════════════════════════════════╗
║          Prediction Engine - 群体智能预测引擎               ║
╠════════════════════════════════════════════════════════════╣
║  端口: {port}                                                  ║
║  虚拟观众: {PREDICTION_AGENT_COUNT}                                    ║
║  状态: {'启用' if PREDICTION_ENABLED else '禁用'}                                                ║
║  功能: 互动预测 | 舆情模拟 | 策略优化                         ║
╚════════════════════════════════════════════════════════════╝
    """)
    
    # 预生成虚拟观众
    if PREDICTION_ENABLED:
        print(f"[Prediction] Generating {PREDICTION_AGENT_COUNT} virtual agents...")
        simulation_state.agents = generate_virtual_agents(PREDICTION_AGENT_COUNT)
        print(f"[Prediction] Ready with {len(simulation_state.agents)} agents")
    
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
