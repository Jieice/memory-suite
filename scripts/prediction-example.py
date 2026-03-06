#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Prediction Engine 使用示例
演示如何在实际场景中使用预测引擎
"""

import requests
import json
import time
from typing import Dict, Any, Optional

PREDICTION_ENGINE_URL = 'http://localhost:4013'

def predict_interaction(content: str, context: Dict[str, Any] = None) -> Optional[Dict]:
    """预测互动效果"""
    try:
        response = requests.post(
            f'{PREDICTION_ENGINE_URL}/predict/interaction',
            json={
                'content': content,
                'context': context or {}
            },
            timeout=5
        )
        if response.status_code == 200:
            return response.json()['prediction']
        else:
            print(f"❌ Error: {response.status_code}")
            return None
    except Exception as e:
        print(f"❌ Exception: {e}")
        return None

def predict_sentiment(scenario: str, duration: int = 5) -> Optional[Dict]:
    """预测舆情演化"""
    try:
        response = requests.post(
            f'{PREDICTION_ENGINE_URL}/predict/sentiment',
            json={
                'scenario': scenario,
                'duration': duration
            },
            timeout=5
        )
        if response.status_code == 200:
            return response.json()['prediction']
        else:
            print(f"❌ Error: {response.status_code}")
            return None
    except Exception as e:
        print(f"❌ Exception: {e}")
        return None

def optimize_strategy(goal: str, constraints: list = None) -> Optional[Dict]:
    """优化策略"""
    try:
        response = requests.post(
            f'{PREDICTION_ENGINE_URL}/predict/optimize',
            json={
                'goal': goal,
                'constraints': constraints or []
            },
            timeout=5
        )
        if response.status_code == 200:
            return response.json()['optimization']
        else:
            print(f"❌ Error: {response.status_code}")
            return None
    except Exception as e:
        print(f"❌ Exception: {e}")
        return None

def check_health() -> bool:
    """检查服务健康状态"""
    try:
        response = requests.get(f'{PREDICTION_ENGINE_URL}/health', timeout=3)
        return response.status_code == 200
    except:
        return False

# ==================== 使用示例 ====================

def example_1_basic_prediction():
    """示例 1: 基础预测"""
    print("\n" + "="*60)
    print("示例 1: 基础互动预测")
    print("="*60)
    
    topics = [
        "今天想和大家聊聊游戏",
        "有人想听我唱歌吗？",
        "大家觉得最近的新闻怎么样？"
    ]
    
    for topic in topics:
        print(f"\n📝 话题: {topic}")
        prediction = predict_interaction(topic)
        
        if prediction:
            print(f"   互动率: {prediction['expected_interaction_rate']:.1%}")
            print(f"   正面率: {prediction['expected_positive_rate']:.1%}")
            print(f"   风险等级: {prediction['risk_level']}")
            print(f"   建议: {prediction['recommendations'][0]}")
        
        time.sleep(0.5)

def example_2_risk_assessment():
    """示例 2: 风险评估"""
    print("\n" + "="*60)
    print("示例 2: 敏感话题风险评估")
    print("="*60)
    
    sensitive_topic = "最近的政治新闻"
    
    print(f"\n📝 话题: {sensitive_topic}")
    prediction = predict_interaction(sensitive_topic)
    
    if prediction:
        risk_level = prediction['risk_level']
        print(f"   风险等级: {risk_level}")
        
        if risk_level == 'high':
            print("   ⚠️ 高风险！建议不要讨论此话题")
            print("   风险因素:")
            for factor in prediction['risk_factors']:
                print(f"      - {factor}")
        elif risk_level == 'medium':
            print("   ⚠️ 中等风险，需要谨慎处理")
        else:
            print("   ✅ 低风险，可以讨论")

def example_3_topic_selection():
    """示例 3: 话题选择优化"""
    print("\n" + "="*60)
    print("示例 3: 智能话题选择")
    print("="*60)
    
    candidates = [
        "今天天气真好",
        "有人玩过这个游戏吗？",
        "分享一个有趣的故事",
        "大家最近在忙什么？"
    ]
    
    print("\n🔍 评估候选话题...")
    
    best_topic = None
    best_score = 0
    
    for topic in candidates:
        prediction = predict_interaction(topic)
        if prediction:
            score = prediction['expected_interaction_rate']
            print(f"   {topic}: {score:.1%}")
            
            if score > best_score:
                best_score = score
                best_topic = topic
        
        time.sleep(0.3)
    
    print(f"\n✅ 最佳话题: {best_topic} (预期互动率: {best_score:.1%})")

def example_4_sentiment_evolution():
    """示例 4: 舆情演化模拟"""
    print("\n" + "="*60)
    print("示例 4: 舆情演化模拟")
    print("="*60)
    
    print("\n📊 模拟 5 分钟内的情绪变化...")
    
    result = predict_sentiment('general', duration=5)
    
    if result:
        print("\n时间线:")
        for point in result['timeline']:
            minute = point['minute']
            sentiment = point['average_sentiment']
            active = point['active_agents']
            
            # 可视化情绪
            bar_length = int(sentiment * 20)
            bar = '█' * bar_length + '░' * (20 - bar_length)
            
            print(f"   {minute}分钟: {bar} {sentiment:.2f} (活跃: {active})")
        
        print(f"\n分析:")
        print(f"   最终情绪: {result['risk_analysis']['final_sentiment']:.2f}")
        print(f"   趋势: {result['risk_analysis']['trend']}")
        print(f"   风险等级: {result['risk_analysis']['risk_level']}")

def example_5_strategy_optimization():
    """示例 5: 策略优化"""
    print("\n" + "="*60)
    print("示例 5: 直播策略优化")
    print("="*60)
    
    goals = [
        ('maximize_engagement', '最大化互动'),
        ('build_community', '建立社区感'),
        ('content_quality', '提升内容质量')
    ]
    
    for goal_id, goal_name in goals:
        print(f"\n🎯 目标: {goal_name}")
        
        result = optimize_strategy(goal_id, constraints=['no_controversial'])
        
        if result:
            strategy = result['optimal_strategy']
            print(f"   策略: {strategy['name']}")
            print(f"   行动:")
            for action in strategy['actions'][:3]:
                print(f"      • {action}")
            
            if 'expected_outcome' in strategy:
                outcome = strategy['expected_outcome']
                print(f"   预期效果:")
                for key, value in outcome.items():
                    print(f"      - {key}: {value}")
        
        time.sleep(0.5)

def example_6_real_time_decision():
    """示例 6: 实时决策支持"""
    print("\n" + "="*60)
    print("示例 6: 实时决策支持（模拟主动发言）")
    print("="*60)
    
    print("\n🤖 AI 想要主动发言...")
    
    # 模拟 AI 生成的候选话题
    candidate_topics = [
        "好安静啊，有人在吗？",
        "最近有什么好玩的游戏推荐吗？",
        "今天心情不错，和大家分享一下"
    ]
    
    print("\n🔍 评估候选话题...")
    
    for i, topic in enumerate(candidate_topics, 1):
        print(f"\n候选 {i}: {topic}")
        prediction = predict_interaction(topic)
        
        if prediction:
            interaction_rate = prediction['expected_interaction_rate']
            risk_level = prediction['risk_level']
            
            print(f"   预期互动率: {interaction_rate:.1%}")
            print(f"   风险等级: {risk_level}")
            
            # 决策逻辑
            if risk_level == 'high':
                print("   ❌ 决策: 拒绝（风险过高）")
            elif interaction_rate < 0.3:
                print("   ⚠️ 决策: 不推荐（互动率过低）")
            else:
                print("   ✅ 决策: 可以使用")
                print(f"   建议: {prediction['recommendations'][0]}")
        
        time.sleep(0.5)

# ==================== 主程序 ====================

def main():
    print("""
╔════════════════════════════════════════════════════════════╗
║        Prediction Engine 使用示例                           ║
║        演示如何在实际场景中使用预测引擎                      ║
╚════════════════════════════════════════════════════════════╝
    """)
    
    # 检查服务
    print("🔍 检查 Prediction Engine 服务...")
    if not check_health():
        print("❌ Prediction Engine 未运行！")
        print("请先启动服务: cd brainnn && python prediction_engine.py")
        return
    
    print("✅ Prediction Engine 正常运行\n")
    
    # 运行示例
    try:
        example_1_basic_prediction()
        example_2_risk_assessment()
        example_3_topic_selection()
        example_4_sentiment_evolution()
        example_5_strategy_optimization()
        example_6_real_time_decision()
        
        print("\n" + "="*60)
        print("✅ 所有示例运行完成！")
        print("="*60)
        
    except KeyboardInterrupt:
        print("\n\n⚠️ 用户中断")
    except Exception as e:
        print(f"\n\n❌ 错误: {e}")

if __name__ == '__main__':
    main()
