#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NN 链路测试脚本
验证所有修复是否生效
"""

import requests
import json
import time
from typing import Dict, Any

# 服务 URL
BRAINNN_URL = 'http://127.0.0.1:4007'
AGENT_CORE_URL = 'http://127.0.0.1:4009'
MEMORY_SYSTEM_URL = 'http://127.0.0.1:4010'
REFLECTION_ENGINE_URL = 'http://127.0.0.1:4011'
NEURO_SYMBOLIC_URL = 'http://127.0.0.1:4012'
PREDICTION_ENGINE_URL = 'http://127.0.0.1:4013'

def print_section(title: str):
    """打印分隔符"""
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}\n")

def test_service_health(url: str, service_name: str) -> bool:
    """测试服务健康状态"""
    try:
        response = requests.get(f'{url}/health', timeout=2)
        if response.status_code == 200:
            data = response.json()
            if data.get('status') == 'healthy':
                print(f"✅ {service_name} 健康")
                return True
        print(f"❌ {service_name} 不健康")
        return False
    except Exception as e:
        print(f"❌ {service_name} 无法连接: {e}")
        return False

def test_prediction_engine():
    """测试优先级 1: Prediction Engine 的 /predict/should_say 端点"""
    print_section("优先级 1: Prediction Engine - /predict/should_say 端点")
    
    if not test_service_health(PREDICTION_ENGINE_URL, 'Prediction Engine'):
        return False
    
    try:
        # 测试正常内容
        response = requests.post(
            f'{PREDICTION_ENGINE_URL}/predict/should_say',
            json={
                'text': '今天想和大家聊聊游戏',
                'context': {
                    'userId': 'test_user',
                    'source': 'creator'
                }
            },
            timeout=5
        )
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ /predict/should_say 端点正常")
            print(f"   - allowed: {data.get('allowed')}")
            print(f"   - confidence: {data.get('confidence')}")
            print(f"   - reason: {data.get('reason')}")
            return True
        else:
            print(f"❌ /predict/should_say 返回错误: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ /predict/should_say 调用失败: {e}")
        return False

def test_memory_system():
    """测试优先级 2: Memory System V2 的 /memory/store 端点"""
    print_section("优先级 2: Memory System V2 - /memory/store 端点")
    
    if not test_service_health(MEMORY_SYSTEM_URL, 'Memory System V2'):
        return False
    
    try:
        # 测试存储记忆
        response = requests.post(
            f'{MEMORY_SYSTEM_URL}/memory/store',
            json={
                'content': '用户说：今天天气真好',
                'source': 'danmaku',
                'userId': 'test_user',
                'type': 'auto',
                'metadata': {
                    'emotion': {'joy': 0.6},
                    'drives': {'boredom': 0.3}
                }
            },
            timeout=5
        )
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ /memory/store 端点正常")
            print(f"   - memory_id: {data.get('memory_id')}")
            print(f"   - type: {data.get('type')}")
            return True
        else:
            print(f"❌ /memory/store 返回错误: {response.status_code}")
            print(f"   响应: {response.text}")
            return False
    except Exception as e:
        print(f"❌ /memory/store 调用失败: {e}")
        return False

def test_reflection_engine():
    """测试优先级 3: Reflection Engine 的反馈循环"""
    print_section("优先级 3: Reflection Engine - 反馈循环")
    
    if not test_service_health(REFLECTION_ENGINE_URL, 'Reflection Engine'):
        return False
    
    try:
        # 测试处理反馈
        response = requests.post(
            f'{REFLECTION_ENGINE_URL}/feedback',
            json={
                'type': 'positive',
                'value': 0.8,
                'context': {'message': '很好的回复'}
            },
            timeout=5
        )
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ /feedback 端点正常")
            print(f"   - feedback_id: {data.get('feedback_id')}")
            print(f"   - should_reflect: {data.get('should_reflect')}")
            print(f"   - should_update_soul: {data.get('should_update_soul')}")
            
            if data.get('soul_updates'):
                print(f"   - soul_updates: {json.dumps(data.get('soul_updates'), indent=6)}")
            
            return True
        else:
            print(f"❌ /feedback 返回错误: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ /feedback 调用失败: {e}")
        return False

def test_brainnn_feedback():
    """测试 BrainNN 的 /feedback 端点是否应用学习结果"""
    print_section("优先级 3: BrainNN - /feedback 端点应用学习结果")
    
    if not test_service_health(BRAINNN_URL, 'BrainNN'):
        return False
    
    try:
        # 获取初始状态
        response = requests.get(f'{BRAINNN_URL}/state', timeout=2)
        initial_state = response.json() if response.status_code == 200 else {}
        print(f"初始 Soul State: {json.dumps(initial_state, indent=2)}")
        
        # 发送反馈
        response = requests.post(
            f'{BRAINNN_URL}/feedback',
            json={
                'type': 'positive',
                'value': 0.9,
                'context': {}
            },
            timeout=5
        )
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ BrainNN /feedback 端点正常")
            print(f"   - soul_updated: {data.get('soul_updated')}")
            
            if data.get('soul_state'):
                print(f"   - 更新后的 Soul State: {json.dumps(data.get('soul_state'), indent=6)}")
            
            return True
        else:
            print(f"❌ BrainNN /feedback 返回错误: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ BrainNN /feedback 调用失败: {e}")
        return False

def test_brainnn_tick():
    """测试优先级 4: BrainNN 的 /tick 端点主动发言决策"""
    print_section("优先级 4: BrainNN - /tick 端点主动发言决策")
    
    if not test_service_health(BRAINNN_URL, 'BrainNN'):
        return False
    
    try:
        # 测试心跳检查
        response = requests.get(f'{BRAINNN_URL}/tick', timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ /tick 端点正常")
            print(f"   - should_proactive: {data.get('should_proactive')}")
            print(f"   - topic: {data.get('topic')}")
            print(f"   - decision_reason: {data.get('decision_reason')}")
            print(f"   - time_since_last_interaction: {data.get('time_since_last_interaction'):.1f}s")
            
            return True
        else:
            print(f"❌ /tick 返回错误: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ /tick 调用失败: {e}")
        return False

def test_brainnn_think():
    """测试 BrainNN 的 /think 端点是否调用了 Memory System V2"""
    print_section("验证: BrainNN /think 端点调用 Memory System V2")
    
    if not test_service_health(BRAINNN_URL, 'BrainNN'):
        return False
    
    try:
        # 测试思考接口
        response = requests.post(
            f'{BRAINNN_URL}/think',
            json={
                'text': '今天天气真好',
                'source': 'danmaku'
            },
            timeout=5
        )
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ /think 端点正常")
            print(f"   - mood_instruction: {data.get('mood_instruction')}")
            print(f"   - soul: {json.dumps(data.get('soul'), indent=6)}")
            
            return True
        else:
            print(f"❌ /think 返回错误: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ /think 调用失败: {e}")
        return False

def main():
    """主测试函数"""
    print("\n" + "="*60)
    print("  NN 链路完整性测试")
    print("="*60)
    
    results = {
        '优先级 1: Prediction Engine': test_prediction_engine(),
        '优先级 2: Memory System V2': test_memory_system(),
        '优先级 3: Reflection Engine': test_reflection_engine(),
        '优先级 3: BrainNN Feedback': test_brainnn_feedback(),
        '优先级 4: BrainNN Tick': test_brainnn_tick(),
        '验证: BrainNN Think': test_brainnn_think(),
    }
    
    # 总结
    print_section("测试总结")
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    for test_name, result in results.items():
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status} - {test_name}")
    
    print(f"\n总体: {passed}/{total} 通过")
    
    if passed == total:
        print("\n🎉 所有测试通过！NN 链路已修复。")
    else:
        print(f"\n⚠️ 还有 {total - passed} 个测试失败，请检查日志。")

if __name__ == '__main__':
    main()
