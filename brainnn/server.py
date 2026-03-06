# -*- coding: utf-8 -*-
"""
BrainNN v8.0 - Agentic AI神经核心服务
端到端直播特化语言模型的 Python 后端

功能：
- Soul State 管理（情绪、人格、驱动力）
- Agent Core 集成（思考/规划/反思）
- Reflection Engine 集成（自我评估/错误分析）
- Neuro-Symbolic 融合（神经+符号）
- 与 Memory Universe 集成
"""

import os
import sys
import json
import time
import requests
import asyncio
from typing import Dict, Any, Optional
from dataclasses import dataclass, field, asdict
from flask import Flask, request, jsonify
from flask_cors import CORS
from fallback_handler import BrainNNFallbackHandler
from nested_learning_upgrade import NestedLearningSystem, SelfModifyingLearner, ContinuumMemorySystem

app = Flask(__name__)
CORS(app)

# 确保 Flask JSON 响应使用 UTF-8
app.config['JSON_AS_ASCII'] = False
app.config['JSONIFY_MIMETYPE'] = 'application/json; charset=utf-8'

# ==================== 服务 URL 配置 ====================

AGENT_CORE_URL = os.environ.get('AGENT_CORE_URL', 'http://127.0.0.1:4009')
MEMORY_SYSTEM_V2_URL = os.environ.get('MEMORY_SYSTEM_V2_URL', 'http://127.0.0.1:4010')
REFLECTION_ENGINE_URL = os.environ.get('REFLECTION_ENGINE_URL', 'http://127.0.0.1:4011')
NEURO_SYMBOLIC_BRIDGE_URL = os.environ.get('NEURO_SYMBOLIC_BRIDGE_URL', 'http://127.0.0.1:4012')

# ==================== 初始化 Fallback Handler ====================

fallback_handler = BrainNNFallbackHandler({
    'agent_core_url': AGENT_CORE_URL,
    'memory_system_url': MEMORY_SYSTEM_V2_URL,
    'neuro_symbolic_url': NEURO_SYMBOLIC_BRIDGE_URL,
    'reflection_engine_url': REFLECTION_ENGINE_URL
})


def _read_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, str(default)).strip().lower()
    if raw in ('1', 'true', 'yes', 'on'):
        return True
    if raw in ('0', 'false', 'no', 'off'):
        return False
    return default


def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def _read_float(name: str, default: float, lo: float = 0.0, hi: float = 1.0) -> float:
    try:
        value = float(os.environ.get(name, default))
    except Exception:
        value = default
    return _clamp(value, lo, hi)


def _coerce_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    raw = str(value).strip().lower()
    if raw in ('1', 'true', 'yes', 'on'):
        return True
    if raw in ('0', 'false', 'no', 'off'):
        return False
    return default


def _coerce_float(value: Any, default: float, lo: float = 0.0, hi: float = 1.0) -> float:
    try:
        parsed = float(value)
    except Exception:
        parsed = default
    return _clamp(parsed, lo, hi)


ANIME_TRAIT_ENABLED = _read_bool('ANIME_TRAIT_ENABLED', True)
ANIME_TRAIT_PROFILE = os.environ.get('ANIME_TRAIT_PROFILE', 'moe_balanced').strip() or 'moe_balanced'
ANIME_TRAIT_VARIATION = _read_float('ANIME_TRAIT_VARIATION', 0.35)
ANIME_TRAIT_NOVELTY_BASE = _read_float('ANIME_TRAIT_NOVELTY_BASE', 0.42)

ANIME_TRAIT_PROFILES = {
    'moe_balanced': {
        'tone_hint': 'cute_friendly',
        'kawaii': 0.72,
        'expressiveness': 0.66,
        'tsundere': 0.24,
        'chaos': 0.34,
        'intimacy': 0.52
    },
    'tsundere_playful': {
        'tone_hint': 'playful_tsundere',
        'kawaii': 0.62,
        'expressiveness': 0.72,
        'tsundere': 0.78,
        'chaos': 0.45,
        'intimacy': 0.48
    },
    'seiso_gentle': {
        'tone_hint': 'gentle_seiso',
        'kawaii': 0.58,
        'expressiveness': 0.48,
        'tsundere': 0.08,
        'chaos': 0.16,
        'intimacy': 0.6
    },
    'denpa_chaotic': {
        'tone_hint': 'quirky_denpa',
        'kawaii': 0.66,
        'expressiveness': 0.76,
        'tsundere': 0.2,
        'chaos': 0.82,
        'intimacy': 0.42
    }
}


def resolve_trait_runtime(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    runtime = payload if isinstance(payload, dict) else {}

    profile_raw = runtime.get('profile', runtime.get('trait_profile', ANIME_TRAIT_PROFILE))
    profile_name = str(profile_raw or 'moe_balanced').strip().lower()
    if profile_name not in ANIME_TRAIT_PROFILES:
        profile_name = 'moe_balanced'

    enabled = _coerce_bool(runtime.get('enabled', runtime.get('trait_enabled', ANIME_TRAIT_ENABLED)), ANIME_TRAIT_ENABLED)
    variation = _coerce_float(runtime.get('variation', runtime.get('trait_variation', ANIME_TRAIT_VARIATION)), ANIME_TRAIT_VARIATION)
    novelty_base = _coerce_float(
        runtime.get('novelty_base', runtime.get('trait_novelty_base', ANIME_TRAIT_NOVELTY_BASE)),
        ANIME_TRAIT_NOVELTY_BASE
    )

    return {
        'enabled': enabled,
        'profile': profile_name,
        'variation': variation,
        'novelty_base': novelty_base
    }

# ==================== 健康检查 ====================

@app.route('/health')
def health_check():
    return jsonify({
        'status': 'healthy',
        'service': 'brainnn',
        'timestamp': time.time()
    })

# ==================== 初始化 Nested Learning 系统 ====================

nested_learning_system = NestedLearningSystem()
self_modifier = SelfModifyingLearner()
continuum_memory = ContinuumMemorySystem()

# ==================== Soul State 定义 ====================

@dataclass
class EmotionState:
    """8维情绪状态 (Plutchik's wheel)"""
    joy: float = 0.5
    sadness: float = 0.1
    anger: float = 0.1
    fear: float = 0.05
    surprise: float = 0.2
    disgust: float = 0.05
    trust: float = 0.4
    anticipation: float = 0.3
    
    def to_dict(self) -> Dict[str, float]:
        return asdict(self)
    
    def decay(self, rate: float = 0.05):
        """情绪衰减，趋向基线"""
        baseline = {'joy': 0.5, 'sadness': 0.1, 'anger': 0.1, 'fear': 0.05,
                    'surprise': 0.2, 'disgust': 0.05, 'trust': 0.4, 'anticipation': 0.3}
        for k in baseline:
            current = getattr(self, k)
            target = baseline[k]
            setattr(self, k, current + (target - current) * rate)

@dataclass
class PersonalityState:
    """Big Five 人格特质"""
    openness: float = 0.7        # 开放性
    conscientiousness: float = 0.5  # 尽责性
    extraversion: float = 0.6    # 外向性
    agreeableness: float = 0.3   # 宜人性 (低=傲娇)
    neuroticism: float = 0.6     # 神经质 (高=敏感)
    
    def to_dict(self) -> Dict[str, float]:
        return asdict(self)

@dataclass
class WorldState:
    """直播间世界模型状态"""
    activity: str = "杂谈"        # 当前活动 (游戏/主题)
    atmosphere: float = 0.5      # 房间氛围 (0=冷场, 1=热烈)
    hot_topics: list = field(default_factory=list)  # 最近词云
    audience_pulse: float = 0.5  # 观众平均情绪 (0=负面, 1=正面)
    danmaku_density: float = 0.0 # 弹幕密度 (条/分)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class DriveState:
    """内在驱动力"""
    boredom: float = 0.3          # 无聊程度
    fatigue: float = 0.2          # 疲劳程度
    curiosity: float = 0.5        # 好奇心
    social_need: float = 0.4      # 社交需求
    expression_desire: float = 0.3 # 表达欲 (New in v9)
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
    
    def update(self, has_interaction: bool, world_atmosphere: float = 0.5, dt: float = 1.0):
        """更新驱动力"""
        if has_interaction:
            self.boredom = max(0, self.boredom - 0.1)
            self.social_need = max(0, self.social_need - 0.05)
            self.curiosity = min(1, self.curiosity + 0.02)
            self.expression_desire = max(0, self.expression_desire - 0.15)
        else:
            self.boredom = min(1, self.boredom + 0.02 * dt)
            self.social_need = min(1, self.social_need + 0.01 * dt)
            # 冷场且无聊时，表达欲快速上升
            self.expression_desire = min(1, self.expression_desire + 0.05 * dt * (1 - world_atmosphere))
        
        # 疲劳随时间增加
        self.fatigue = min(1, self.fatigue + 0.005 * dt)

@dataclass
class SoulState:
    """完整灵魂状态"""
    emotion: EmotionState = field(default_factory=EmotionState)
    personality: PersonalityState = field(default_factory=PersonalityState)
    drives: DriveState = field(default_factory=DriveState)
    world: WorldState = field(default_factory=WorldState) # Added WorldState
    last_interaction: float = field(default_factory=time.time)
    interaction_count: int = 0
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'emotion': self.emotion.to_dict(),
            'personality': self.personality.to_dict(),
            'drives': self.drives.to_dict(),
            'world': self.world.to_dict(),
            'interaction_count': self.interaction_count
        }

# ==================== 全局状态 ====================

soul = SoulState()

# ==================== API 路由 ====================

@app.route('/process', methods=['POST'])
def process_input():
    """
    处理输入（弹幕/用户消息）
    使用嵌套学习系统进行多时间尺度处理
    返回：情绪状态、驱动力、Agent决策、嵌套学习结果
    """
    global soul, nested_learning_system
    
    data = request.json or {}
    text = data.get('text', '')
    source = data.get('source', 'danmaku')
    
    if not text:
        return jsonify({'error': 'text is required'}), 400
    
    # 更新交互
    soul.interaction_count += 1
    soul.last_interaction = time.time()
    
    # 更新驱动力
    soul.drives.update(has_interaction=True)
    
    # ==================== 嵌套学习处理 ====================
    # 通过多时间尺度的嵌套优化层级处理输入
    nested_result = nested_learning_system.process_input({
        'type': source,
        'content': text,
        'soul_state': soul.to_dict()
    })
    
    # 生成情绪指令（传给 LLM）
    mood_instruction = generate_mood_instruction(soul)
    
    print(f"[BrainNN] Input: {text[:50]}... | Mood: {mood_instruction[:30]}...")
    print(f"[BrainNN] Nested Learning Levels Updated: {list(nested_result.keys())}")
    
    with app.app_context():
        return jsonify({
            'soul_state': soul.to_dict(),
            'mood_instruction': mood_instruction,
            'should_proactive': False,
            'proactive_topic': None,
            'agent_decision': None,
            'reflection': None,
            'neuro_symbolic': None,
            # ==================== 新增：嵌套学习结果 ====================
            'nested_learning': {
                'immediate_response': nested_result.get('immediate_response'),
                'thought_process': nested_result.get('thought_process'),
                'emotional_state': nested_result.get('emotional_state'),
                'memory_updates': nested_result.get('memory_updates'),
                'learned_insights': nested_result.get('learned_insights')
            }
        })

@app.route('/think', methods=['POST'])
def think():
    """
    思考接口 - 处理输入并返回情绪/人格/驱动力
    供 Memory Universe 调用
    """
    global soul
    
    data = request.json or {}
    text = data.get('text', '')
    source = data.get('source', 'danmaku')
    trait_runtime = resolve_trait_runtime(data.get('trait_runtime'))
    
    if not text:
        return jsonify({'error': 'text is required'}), 400
    
    # 更新交互
    soul.interaction_count += 1
    soul.last_interaction = time.time()
    
    # 更新驱动力
    soul.drives.update(has_interaction=True, world_atmosphere=soul.world.atmosphere)
    
    # 情绪衰减
    soul.emotion.decay(rate=0.02)

    # 模拟环境影响：弹幕密度增加会提升气氛
    soul.world.danmaku_density = min(1.0, soul.world.danmaku_density + 0.1)
    soul.world.atmosphere = min(1.0, soul.world.atmosphere + 0.05)
    
    # 生成包含 WorldState 和 CoT 协议的指令
    mood_instruction = generate_mood_instruction(soul)
    
    # 使用 Fallback Handler 处理思考
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        think_result = loop.run_until_complete(
            fallback_handler.think(text, source)
        )
        loop.close()
    except Exception as e:
        print(f"[BrainNN] Fallback handler error: {e}")
        think_result = {
            'success': False,
            'text': text,
            'source': source,
            'services_used': [],
            'services_failed': []
        }
    
    print(f"[BrainNN] Think: {text[:50]}... | Mood: {mood_instruction[:30]}...")

    trait_signal = build_trait_signal(soul, source, text, trait_runtime)
    style_guidance = build_style_guidance(soul, mood_instruction, source, trait_signal)
    reply_constraints = build_reply_constraints(source, trait_signal)
    
    with app.app_context():
        return jsonify({
            'soul': soul.to_dict(),
            'text': text,
            'policy': [],
            'actions': [],
            'mood_instruction': mood_instruction,
            'style_guidance': style_guidance,
            'reply_constraints': reply_constraints,
            'trait_signal': trait_signal,
            'trait_runtime': trait_runtime,
            'think_result': think_result
        })

@app.route('/tick', methods=['POST'])
def tick():
    """
    定时心跳 - 更新灵魂状态并判断是否主动发言
    供 Memory Universe 定时调用 (例如每 10 秒)
    """
    global soul
    
    # 距离上次交互的时间
    dt = time.time() - soul.last_interaction
    
    # 更新驱动力 (无交互模式)
    soul.drives.update(has_interaction=False, world_atmosphere=soul.world.atmosphere, dt=dt/10.0)
    
    # 表达欲检查
    should_proactive = soul.drives.expression_desire > 0.8
    proactive_topic = None
    
    if should_proactive:
        # 根据当前世界模型选择话题
        if soul.world.hot_topics:
            proactive_topic = f"谈谈大家刚才聊的 {soul.world.hot_topics[0]}"
        else:
            proactive_topic = f"关于 {soul.world.activity} 的随口吐槽"
        
        # 记录主动发言导致的交互更新
        soul.last_interaction = time.time()
        # 略微降低表达欲，防止连续刷屏
        soul.drives.expression_desire = 0.4

    return jsonify({
        'success': True,
        'soul': soul.to_dict(),
        'should_proactive': should_proactive,
        'proactive_topic': proactive_topic,
        'mood_instruction': generate_mood_instruction(soul)
    })

def generate_mood_instruction(soul: SoulState) -> str:
    """生成包含 WorldState 的增强指令（v9.0 CoT 协议）"""
    emotion = soul.emotion
    personality = soul.personality
    drives = soul.drives
    world = soul.world
    
    # 基础语气指令
    moods = []
    if emotion.joy > 0.7: moods.append("活泼开心")
    elif emotion.sadness > 0.6: moods.append("略显忧郁")
    elif emotion.anger > 0.6: moods.append("带着点傲娇的小脾气")
    
    # 环境感知指令 (World Model Integration)
    env_context = f"当前正在进行：{world.activity}。"
    if world.atmosphere < 0.3:
        env_context += "直播间现在有点冷场，你需要主动寻找话题或吐槽。"
    elif world.atmosphere > 0.8:
        env_context += "直播间非常热闹，保持高频互动。"
    
    if world.hot_topics:
        env_context += f"大家正在聊：{', '.join(world.hot_topics[:3])}。"

    # CoT 强制协议提示
    cot_protocol = (
        "\n### 强制思考协议 (CoT) ###\n"
        "在回复之前，你必须先在脑海中完成以下分析并以 JSON 格式输出：\n"
        "1. observation: 对当前直播间氛围和对方话语的观察\n"
        "2. intent_analysis: 分析对方是真的在提问，还是在玩梗/调戏你\n"
        "3. social_strategy: 思考你的回复会引导什么样的直播间节奏\n"
        "4. expression_desire: 你的当前表达欲望水平\n"
        "最后给出最终的 'response'。\n"
    )
    
    base_instr = "，".join(moods) if moods else "自然"
    return f"【状态：{base_instr}】{env_context}{cot_protocol}"

def build_trait_signal(
    soul: SoulState,
    source: str,
    text: str,
    trait_runtime: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    runtime = resolve_trait_runtime(trait_runtime)
    if not runtime.get('enabled', True):
        return {'enabled': False}

    profile_name = runtime.get('profile', 'moe_balanced')
    if profile_name not in ANIME_TRAIT_PROFILES:
        profile_name = 'moe_balanced'
    profile = ANIME_TRAIT_PROFILES[profile_name]
    variation = _coerce_float(runtime.get('variation', ANIME_TRAIT_VARIATION), ANIME_TRAIT_VARIATION)
    novelty_base = _coerce_float(runtime.get('novelty_base', ANIME_TRAIT_NOVELTY_BASE), ANIME_TRAIT_NOVELTY_BASE)

    joy = _clamp(getattr(soul.emotion, 'joy', 0.5))
    curiosity = _clamp(getattr(soul.drives, 'curiosity', 0.5))
    boredom = _clamp(getattr(soul.drives, 'boredom', 0.3))
    social_need = _clamp(getattr(soul.drives, 'social_need', 0.4))

    energy = _clamp((joy * 0.55) + (curiosity * 0.45))
    chaos = _clamp(profile['chaos'] + ((boredom - 0.5) * 0.24) + (variation * 0.12))
    tsundere = _clamp(profile['tsundere'] + (0.06 if source != 'creator' else -0.04))
    intimacy = _clamp(profile['intimacy'] + ((social_need - 0.5) * 0.18))
    kawaii_ratio = _clamp((profile['kawaii'] * 0.72) + (energy * 0.28))
    novelty = _clamp(novelty_base + (chaos * 0.35) + (variation * 0.2))
    expressiveness = _clamp((profile['expressiveness'] * 0.7) + (energy * 0.3))
    directness = _clamp(0.9 if source == 'creator' else (0.55 + (intimacy * 0.25)))

    lower = (text or '').lower()
    command_like = lower.startswith('/') or lower.startswith('debug') or lower.startswith('status')
    if command_like:
        novelty = _clamp(novelty - 0.25)
        chaos = _clamp(chaos - 0.2)
        directness = _clamp(directness + 0.2)

    return {
        'enabled': True,
        'profile': profile_name,
        'style_vector': {
            'tone_hint': profile['tone_hint'],
            'kawaii_ratio': round(kawaii_ratio, 3),
            'expressiveness': round(expressiveness, 3),
            'tsundere_bias': round(tsundere, 3),
            'chaos_bias': round(chaos, 3),
            'intimacy_bias': round(intimacy, 3),
            'directness': round(directness, 3)
        },
        'response_policy': {
            'novelty_target': round(novelty, 3),
            'surprise_rate': round(_clamp(0.12 + (chaos * 0.35)), 3),
            'roleplay_bias': round(_clamp(0.2 + (kawaii_ratio * 0.45)), 3),
            'japanese_token_rate': round(_clamp(0.02 + (kawaii_ratio * 0.08), 0, 0.2), 3)
        },
        'lora_hint': {
            'target_style_tag': profile_name,
            'weight_suggestion': round(_clamp(0.38 + (expressiveness * 0.3) + (tsundere * 0.18), 0.15, 0.95), 3)
        },
        'guardrails': {
            'ban_meta_assistant_style': True,
            'ban_creator_claim_for_public': source != 'creator'
        }
    }


def build_style_guidance(soul: SoulState, mood_instruction: str, source: str, trait_signal: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Build lightweight style guidance for the LLM prompt layer."""
    tone = 'natural'
    pacing = 'balanced'
    interaction_goal = 'keep_conversation_flow'
    avoid_phrases = ['作为AI', 'As an AI', 'Follow-up:']

    if soul.emotion.joy > 0.7:
        tone = 'cheerful'
    elif soul.emotion.sadness > 0.6:
        tone = 'gentle'
    elif soul.emotion.anger > 0.6:
        tone = 'calm_firm'

    if soul.drives.boredom > 0.65:
        interaction_goal = 'increase_engagement'
        pacing = 'proactive'
    elif soul.drives.social_need > 0.7:
        interaction_goal = 'invite_interaction'
        pacing = 'light'

    if source == 'creator':
        interaction_goal = 'execute_creator_intent'
        pacing = 'direct'

    style_vector = trait_signal.get('style_vector', {}) if isinstance(trait_signal, dict) else {}
    response_policy = trait_signal.get('response_policy', {}) if isinstance(trait_signal, dict) else {}
    guardrails = trait_signal.get('guardrails', {}) if isinstance(trait_signal, dict) else {}

    if style_vector.get('tone_hint'):
        tone = str(style_vector.get('tone_hint'))
    if isinstance(style_vector.get('directness'), (int, float)) and source != 'creator':
        pacing = 'dynamic' if float(style_vector.get('directness')) < 0.72 else pacing
    if trait_signal and trait_signal.get('enabled') and source != 'creator':
        interaction_goal = 'anime_stream_presence'
    if guardrails.get('ban_meta_assistant_style'):
        avoid_phrases.extend(['I am just an AI assistant', '我是一个AI助手'])

    return {
        'tone': tone,
        'pacing': pacing,
        'interaction_goal': interaction_goal,
        'avoid_phrases': avoid_phrases,
        'mood_hint': mood_instruction,
        'expressiveness': style_vector.get('expressiveness', 0.5),
        'kawaii_ratio': style_vector.get('kawaii_ratio', 0.4),
        'surprise_bias': response_policy.get('surprise_rate', 0.2),
        'roleplay_bias': response_policy.get('roleplay_bias', 0.3),
        'japanese_token_rate': response_policy.get('japanese_token_rate', 0.03)
    }


def build_reply_constraints(source: str, trait_signal: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Provide soft reply constraints from BrainNN side."""
    if source == 'creator':
        return {
            'max_sentences': 4,
            'max_chars_zh': 120,
            'max_words_en': 70
        }
    novelty_target = 0.45
    if isinstance(trait_signal, dict):
        response_policy = trait_signal.get('response_policy', {})
        if isinstance(response_policy.get('novelty_target'), (int, float)):
            novelty_target = float(response_policy.get('novelty_target'))
    max_sentences = 3 if novelty_target >= 0.6 else 2
    return {
        'max_sentences': max_sentences,
        'max_chars_zh': 88,
        'max_words_en': 42
    }


@app.route('/feedback', methods=['POST'])
def feedback():
    """
    学习反馈接口
    用于在线学习（Reflection Engine）
    
    POST /feedback
    {
        "type": "positive|negative|neutral",
        "value": 0.8,
        "context": {...}
    }
    
    返回：
    {
        "success": true,
        "feedback_processed": true,
        "soul_updated": true,
        "soul_state": {...}
    }
    """
    global soul
    
    data = request.json or {}
    feedback_type = data.get('type', 'unknown')
    value = data.get('value', 0)
    context = data.get('context', {})
    
    # 使用 Fallback Handler 处理反馈
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        feedback_result = loop.run_until_complete(
            fallback_handler.feedback({
                'type': feedback_type,
                'value': value,
                'context': context
            })
        )
        loop.close()
        
        return jsonify({
            'success': True,
            'feedback_processed': feedback_result.get('feedback_recorded', True),
            'soul_updated': feedback_result.get('reflection_applied', False),
            'soul_state': soul.to_dict(),
            'feedback_result': feedback_result
        })
    except Exception as e:
        print(f"[Feedback] Fallback handler error: {e}")
        # 降级：简单记录
        print(f"[Feedback] Type: {feedback_type}, Value: {value}")
        
        return jsonify({
            'success': True,
            'message': 'Feedback received (Reflection Engine unavailable)'
        })

@app.route('/world/update', methods=['POST'])
def update_world():
    """更新世界模型状态"""
    global soul
    data = request.json or {}
    
    if 'activity' in data: soul.world.activity = data['activity']
    if 'atmosphere' in data: soul.world.atmosphere = _coerce_float(data['atmosphere'], 0.5)
    if 'hot_topics' in data: soul.world.hot_topics = data['hot_topics']
    if 'audience_pulse' in data: soul.world.audience_pulse = _coerce_float(data['audience_pulse'], 0.5)
    if 'danmaku_density' in data: soul.world.danmaku_density = _coerce_float(data['danmaku_density'], 0.0)
    
    return jsonify({'success': True, 'world': soul.world.to_dict()})

@app.route('/reset', methods=['POST'])
def reset():
    """重置灵魂状态"""
    global soul
    soul = SoulState()
    return jsonify({'success': True, 'message': 'Soul state reset'})

@app.route('/state', methods=['GET'])
def get_state():
    """获取当前灵魂状态"""
    return jsonify(soul.to_dict())

@app.route('/state', methods=['POST'])
def set_state():
    """手动设置灵魂状态（调试用）"""
    global soul
    data = request.json or {}
    
    if 'emotion' in data:
        for k, v in data['emotion'].items():
            if hasattr(soul.emotion, k):
                setattr(soul.emotion, k, float(v))
    
    if 'drives' in data:
        for k, v in data['drives'].items():
            if hasattr(soul.drives, k):
                setattr(soul.drives, k, float(v))
    
    return jsonify({'success': True, 'state': soul.to_dict()})

# ==================== 嵌套学习 API 端点 ====================

@app.route('/nested/state', methods=['GET'])
def get_nested_state():
    """
    获取嵌套学习系统的状态
    返回：各层级的更新时间、上下文、目标
    """
    global nested_learning_system
    
    state = nested_learning_system.get_system_state()
    
    return jsonify({
        'nested_learning_state': state,
        'timestamp': time.time()
    })

@app.route('/nested/process', methods=['POST'])
def nested_process():
    """
    直接通过嵌套学习系统处理输入
    用于测试和调试
    """
    global nested_learning_system
    
    data = request.json or {}
    input_data = data.get('input', {})
    
    result = nested_learning_system.process_input(input_data)
    
    return jsonify({
        'result': result,
        'timestamp': time.time()
    })

@app.route('/memory/consolidate', methods=['POST'])
def consolidate_memory():
    """
    触发记忆巩固
    将短期记忆转移到长期记忆
    """
    global continuum_memory
    
    data = request.json or {}
    memories_to_consolidate = data.get('memories', [])
    
    for memory in memories_to_consolidate:
        continuum_memory.store_memory(
            memory.get('content', ''),
            importance=memory.get('importance', 0.5)
        )
    
    return jsonify({
        'consolidated_count': len(memories_to_consolidate),
        'timestamp': time.time()
    })

@app.route('/learning/feedback', methods=['POST'])
def learning_feedback():
    """
    提供反馈给自修改学习模块
    系统可能根据反馈修改自己的决策规则
    """
    global self_modifier
    
    data = request.json or {}
    feedback = data.get('feedback', {})
    
    self_modifier.learn_from_feedback(feedback)
    
    return jsonify({
        'feedback_processed': True,
        'rules_modified': self_modifier._should_modify_rules(feedback),
        'learning_history_size': len(self_modifier.learning_history),
        'timestamp': time.time()
    })

@app.route('/nested/info', methods=['GET'])
def nested_info():
    """
    获取嵌套学习系统的信息
    """
    return jsonify({
        'system': 'Nested Learning System',
        'version': '1.0',
        'levels': {
            'realtime': 'Gamma (10ms) - 实时反应',
            'thinking': 'Beta (100ms) - 思考规划',
            'personality': 'Alpha (500ms) - 情感人格',
            'consolidation': 'Theta (2s) - 记忆巩固',
            'learning': 'Delta (10s) - 长期学习'
        },
        'features': [
            'Multi-timescale processing',
            'Nested optimization',
            'Continual learning',
            'Self-modifying learning'
        ]
    })

# ==================== 启动 ====================

if __name__ == '__main__':
    port = int(os.environ.get('BRAINNN_PORT', 4007))
    device = os.environ.get('BRAINNN_DEVICE', 'cpu')
    
    print(f"""
╔════════════════════════════════════════════════════════════╗
║           BrainNN v8.0 - Agentic AI 神经核心服务            ║
╠══════════════════════════════════════════════════════════╣
║  端口: {port}                                                  ║
║  设备: {device}                                                ║
║  状态: Soul State + Agent Core + Reflection + Neuro-Symbolic   ║
╚══════════════════════════════════════════════════════════╝
    """)
    
    print("[BrainNN] Starting with Nested Learning System...")
    print("[BrainNN] Nested Learning Levels:")
    for name, level in nested_learning_system.levels.items():
        print(f"  - {level.name} ({level.timescale.name}): {level.objective}")
    
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
