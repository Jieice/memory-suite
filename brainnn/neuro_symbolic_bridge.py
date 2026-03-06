# -*- coding: utf-8 -*-
"""
Neuro-Symbolic Bridge - 神经符号桥接
负责：神经网络 + 符号推理融合，规则引擎，逻辑推理
"""

import os
import json
import time
import re
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, asdict
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

app.config['JSON_AS_ASCII'] = False
app.config['JSONIFY_MIMETYPE'] = 'application/json; charset=utf-8'

# ==================== 符号规则系统 ====================

class Rule:
    """规则定义"""
    def __init__(self, name: str, condition: callable, action: callable, priority: int = 0):
        self.name = name
        self.condition = condition
        self.action = action
        self.priority = priority
        self.trigger_count = 0
    
    def check(self, context: Dict[str, Any]) -> bool:
        """检查规则是否满足"""
        try:
            return self.condition(context)
        except:
            return False
    
    def execute(self, context: Dict[str, Any]) -> Dict[str, Any]:
        """执行规则动作"""
        self.trigger_count += 1
        try:
            return self.action(context)
        except Exception as e:
            return {'error': str(e)}

class RuleEngine:
    """规则引擎"""
    def __init__(self):
        self.rules: List[Rule] = []
        self._init_default_rules()
    
    def _init_default_rules(self):
        """初始化默认规则"""
        
        # 规则1：检测敏感词
        def check_sensitive(ctx):
            text = ctx.get('text', '').lower()
            sensitive_words = ['政治', '暴力', '色情']
            return any(word in text for word in sensitive_words)
        
        def action_sensitive(ctx):
            return {
                'action': 'filter',
                'reason': '检测到敏感内容',
                'suggestion': '请使用文明用语'
            }
        
        self.add_rule('sensitive_filter', check_sensitive, action_sensitive, priority=10)
        
        # 规则2：检测重复消息
        def check_repeat(ctx):
            text = ctx.get('text', '')
            history = ctx.get('history', [])
            return history and len(history) > 0 and history[-1] == text
        
        def action_repeat(ctx):
            return {
                'action': 'ignore',
                'reason': '重复消息',
                'suggestion': '已经回复过了哦'
            }
        
        self.add_rule('repeat_filter', check_repeat, action_repeat, priority=9)
        
        # 规则3：检测问候语
        def check_greeting(ctx):
            text = ctx.get('text', '').lower()
            greetings = ['你好', 'hello', 'hi', '早上好', '晚上好']
            return any(g in text for g in greetings)
        
        def action_greeting(ctx):
            return {
                'action': 'respond',
                'response_type': 'greeting',
                'suggestion': '友好回应'
            }
        
        self.add_rule('greeting_detector', check_greeting, action_greeting, priority=5)
        
        # 规则4：检测提问
        def check_question(ctx):
            text = ctx.get('text', '')
            return '?' in text or '？' in text or text.endswith('吗')
        
        def action_question(ctx):
            return {
                'action': 'respond',
                'response_type': 'question',
                'suggestion': '需要回答问题'
            }
        
        self.add_rule('question_detector', check_question, action_question, priority=6)
        
        # 规则5：情绪调节
        def check_negative_emotion(ctx):
            emotion = ctx.get('emotion', {})
            sadness = emotion.get('sadness', 0)
            anger = emotion.get('anger', 0)
            return sadness > 0.7 or anger > 0.7
        
        def action_emotion_regulate(ctx):
            return {
                'action': 'regulate_emotion',
                'suggestion': '使用温和、安慰的语气',
                'tone': 'gentle'
            }
        
        self.add_rule('emotion_regulator', check_negative_emotion, action_emotion_regulate, priority=7)
    
    def add_rule(self, name: str, condition: callable, action: callable, priority: int = 0):
        """添加规则"""
        rule = Rule(name, condition, action, priority)
        self.rules.append(rule)
        # 按优先级排序
        self.rules.sort(key=lambda r: r.priority, reverse=True)
    
    def evaluate(self, context: Dict[str, Any]) -> List[Dict[str, Any]]:
        """评估所有规则"""
        results = []
        
        for rule in self.rules:
            if rule.check(context):
                result = rule.execute(context)
                results.append({
                    'rule': rule.name,
                    'priority': rule.priority,
                    'result': result
                })
        
        return results
    
    def check_all(self, context: Dict[str, Any]) -> Dict[str, Any]:
        """
        检查所有规则并返回综合结果
        用于 BrainNN 的 /check 端点
        """
        results = self.evaluate(context)
        
        # 如果有过滤规则被触发，返回过滤结果
        for item in results:
            if item['result'].get('action') == 'filter':
                return {
                    'action': 'filter',
                    'reason': item['result'].get('reason'),
                    'suggestion': item['result'].get('suggestion'),
                    'triggered_rule': item['rule']
                }
        
        # 否则返回所有触发的规则
        return {
            'action': 'pass',
            'triggered_rules': [item['rule'] for item in results],
            'results': results
        }
    
    def get_rules_info(self) -> List[Dict[str, Any]]:
        """获取规则信息"""
        return [
            {
                'name': rule.name,
                'priority': rule.priority,
                'trigger_count': rule.trigger_count
            }
            for rule in self.rules
        ]

# ==================== 逻辑推理系统 ====================

class LogicReasoner:
    """逻辑推理器"""
    
    def __init__(self):
        self.knowledge_base: Dict[str, Any] = {}
    
    def add_fact(self, key: str, value: Any):
        """添加事实"""
        self.knowledge_base[key] = value
    
    def query(self, key: str) -> Optional[Any]:
        """查询事实"""
        return self.knowledge_base.get(key)
    
    def infer(self, premises: List[str], conclusion: str) -> bool:
        """
        简单的逻辑推理
        例如：如果 A 且 B，则 C
        """
        # 检查所有前提是否为真
        all_true = all(self.knowledge_base.get(p, False) for p in premises)
        
        if all_true:
            # 推导结论
            self.knowledge_base[conclusion] = True
            return True
        
        return False
    
    def explain(self, key: str) -> List[str]:
        """解释推理过程"""
        # 简化版：返回相关的事实
        explanations = []
        
        if key in self.knowledge_base:
            explanations.append(f"{key} = {self.knowledge_base[key]}")
        
        return explanations

# ==================== 神经符号融合 ====================

class NeuroSymbolicBridge:
    """神经符号桥接器"""
    
    def __init__(self):
        self.rule_engine = RuleEngine()
        self.logic_reasoner = LogicReasoner()
    
    def process(self, neural_output: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
        """
        融合神经网络输出和符号推理
        
        neural_output: 来自 BrainNN 的输出（情绪、驱动力等）
        context: 上下文信息（文本、历史等）
        """
        
        # 1. 符号规则检查
        merged_context = {**context, **neural_output}
        rule_results = self.rule_engine.evaluate(merged_context)
        
        # 2. 逻辑推理
        reasoning_results = self._apply_reasoning(neural_output, context)
        
        # 3. 融合决策
        final_decision = self._merge_decisions(neural_output, rule_results, reasoning_results)
        
        return {
            'neural_output': neural_output,
            'rule_results': rule_results,
            'reasoning_results': reasoning_results,
            'final_decision': final_decision,
            'timestamp': time.time()
        }
    
    def _apply_reasoning(self, neural_output: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
        """应用逻辑推理"""
        
        # 添加当前状态到知识库
        emotion = neural_output.get('emotion', {})
        drives = neural_output.get('drives', {})
        
        # 推理规则
        inferences = []
        
        # 规则：如果无聊且好奇心高，则应该主动发言
        if drives.get('boredom', 0) > 0.7 and drives.get('curiosity', 0) > 0.6:
            inferences.append({
                'rule': 'boredom_curiosity_proactive',
                'conclusion': 'should_initiate_conversation',
                'confidence': 0.8
            })
        
        # 规则：如果情绪低落，则需要情绪调节
        if emotion.get('sadness', 0) > 0.7:
            inferences.append({
                'rule': 'sadness_regulation',
                'conclusion': 'need_emotional_support',
                'confidence': 0.9
            })
        
        return {
            'inferences': inferences,
            'knowledge_base_size': len(self.logic_reasoner.knowledge_base)
        }
    
    def _merge_decisions(self, neural_output: Dict[str, Any], 
                        rule_results: List[Dict[str, Any]], 
                        reasoning_results: Dict[str, Any]) -> Dict[str, Any]:
        """融合决策"""
        
        # 优先级：符号规则 > 逻辑推理 > 神经网络
        
        # 检查是否有高优先级规则触发
        high_priority_rules = [r for r in rule_results if r['priority'] >= 8]
        
        if high_priority_rules:
            # 使用规则决策
            return {
                'source': 'symbolic_rules',
                'decision': high_priority_rules[0]['result'],
                'confidence': 0.95
            }
        
        # 检查逻辑推理结果
        inferences = reasoning_results.get('inferences', [])
        if inferences:
            high_confidence = [i for i in inferences if i['confidence'] > 0.8]
            if high_confidence:
                return {
                    'source': 'logical_reasoning',
                    'decision': high_confidence[0],
                    'confidence': high_confidence[0]['confidence']
                }
        
        # 使用神经网络输出
        return {
            'source': 'neural_network',
            'decision': neural_output,
            'confidence': 0.7
        }

# 全局桥接器
bridge = NeuroSymbolicBridge()

# ==================== API 路由 ====================

@app.route('/check', methods=['POST'])
def check():
    """
    规则检查端点
    BrainNN 调用此端点进行内容过滤和规则检查
    
    POST /check
    {
        "text": "用户输入",
        "source": "danmaku|creator",
        "soul_state": {...}
    }
    """
    data = request.json or {}
    text = data.get('text', '')
    source = data.get('source', 'unknown')
    soul_state = data.get('soul_state', {})
    
    if not text:
        return jsonify({'error': 'text is required'}), 400
    
    # 构建检查上下文
    context = {
        'text': text,
        'source': source,
        'emotion': soul_state.get('emotion', {}),
        'history': []  # 可以从记忆系统获取
    }
    
    # 执行规则检查
    result = bridge.rule_engine.check_all(context)
    
    return jsonify({
        'success': True,
        'result': result
    })

@app.route('/process', methods=['POST'])
def process():
    """处理神经符号融合"""
    data = request.json or {}
    neural_output = data.get('neural_output', {})
    context = data.get('context', {})
    
    result = bridge.process(neural_output, context)
    
    return jsonify({
        'success': True,
        **result
    })

@app.route('/rules', methods=['GET'])
def get_rules():
    """获取规则列表"""
    rules = bridge.rule_engine.get_rules_info()
    
    return jsonify({
        'success': True,
        'rules': rules,
        'count': len(rules)
    })

@app.route('/rules/add', methods=['POST'])
def add_rule():
    """添加自定义规则（简化版）"""
    data = request.json or {}
    name = data.get('name', '')
    
    if not name:
        return jsonify({'error': 'rule name is required'}), 400
    
    # 这里可以扩展为支持动态规则定义
    return jsonify({
        'success': True,
        'message': 'Custom rule addition not fully implemented yet',
        'name': name
    })

@app.route('/knowledge/add', methods=['POST'])
def add_knowledge():
    """添加知识"""
    data = request.json or {}
    key = data.get('key', '')
    value = data.get('value')
    
    if not key:
        return jsonify({'error': 'key is required'}), 400
    
    bridge.logic_reasoner.add_fact(key, value)
    
    return jsonify({
        'success': True,
        'key': key,
        'value': value
    })

@app.route('/knowledge/query', methods=['GET'])
def query_knowledge():
    """查询知识"""
    key = request.args.get('key', '')
    
    if not key:
        return jsonify({'error': 'key is required'}), 400
    
    value = bridge.logic_reasoner.query(key)
    
    return jsonify({
        'success': True,
        'key': key,
        'value': value,
        'found': value is not None
    })

@app.route('/knowledge/all', methods=['GET'])
def get_all_knowledge():
    """获取所有知识"""
    return jsonify({
        'success': True,
        'knowledge_base': bridge.logic_reasoner.knowledge_base,
        'size': len(bridge.logic_reasoner.knowledge_base)
    })

@app.route('/infer', methods=['POST'])
def infer():
    """执行推理"""
    data = request.json or {}
    premises = data.get('premises', [])
    conclusion = data.get('conclusion', '')
    
    if not premises or not conclusion:
        return jsonify({'error': 'premises and conclusion are required'}), 400
    
    result = bridge.logic_reasoner.infer(premises, conclusion)
    
    return jsonify({
        'success': True,
        'inferred': result,
        'conclusion': conclusion
    })

@app.route('/explain', methods=['GET'])
def explain():
    """解释推理过程"""
    key = request.args.get('key', '')
    
    if not key:
        return jsonify({'error': 'key is required'}), 400
    
    explanations = bridge.logic_reasoner.explain(key)
    
    return jsonify({
        'success': True,
        'key': key,
        'explanations': explanations
    })

@app.route('/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({
        'status': 'healthy',
        'service': 'neuro-symbolic-bridge',
        'uptime': time.time(),
        'rules_count': len(bridge.rule_engine.rules),
        'knowledge_count': len(bridge.logic_reasoner.knowledge_base)
    })

# ==================== 启动 ====================

if __name__ == '__main__':
    port = int(os.environ.get('NEURO_SYMBOLIC_BRIDGE_PORT', 4012))
    
    print(f"""
╔════════════════════════════════════════════════════════════╗
║       Neuro-Symbolic Bridge - 神经符号桥接服务              ║
╠════════════════════════════════════════════════════════════╣
║  端口: {port}                                                  ║
║  功能: 神经网络融合 | 符号推理 | 规则引擎 | 逻辑推理          ║
║  规则数: {len(bridge.rule_engine.rules)}                                                 ║
╚════════════════════════════════════════════════════════════╝
    """)
    
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
