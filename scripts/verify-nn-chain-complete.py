#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NN 链路完整性验证脚本
验证所有关键服务的连接和功能
"""

import requests
import json
import time
import sys
from typing import Dict, Any, List, Tuple

# 服务端点配置
SERVICES = {
    'memory_universe': 'http://localhost:4005',
    'brainnn': 'http://localhost:4007',
    'agent_core': 'http://localhost:4009',
    'memory_system_v2': 'http://localhost:4010',
    'reflection_engine': 'http://localhost:4011',
    'neuro_symbolic_bridge': 'http://localhost:4012',
    'prediction_engine': 'http://localhost:4013',
}

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'

def print_header(text: str):
    print(f"\n{Colors.BLUE}{'='*60}")
    print(f"  {text}")
    print(f"{'='*60}{Colors.RESET}\n")

def print_success(text: str):
    print(f"{Colors.GREEN}✅ {text}{Colors.RESET}")

def print_error(text: str):
    print(f"{Colors.RED}❌ {text}{Colors.RESET}")

def print_warning(text: str):
    print(f"{Colors.YELLOW}⚠️  {text}{Colors.RESET}")

def print_info(text: str):
    print(f"{Colors.BLUE}ℹ️  {text}{Colors.RESET}")

def check_service_health(service_name: str, endpoint: str) -> Tuple[bool, str]:
    """检查服务健康状态"""
    try:
        response = requests.get(f'{endpoint}/health', timeout=3)
        if response.status_code == 200:
            data = response.json()
            status = data.get('status', 'unknown')
            if status == 'healthy':
                return True, f"✅ {service_name} 健康"
            else:
                return False, f"⚠️  {service_name} 状态异常: {status}"
        else:
            return False, f"❌ {service_name} 返回错误状态码: {response.status_code}"
    except requests.exceptions.ConnectionError:
        return False, f"❌ {service_name} 连接失败 (端口 {endpoint.split(':')[-1]})"
    except requests.exceptions.Timeout:
        return False, f"❌ {service_name} 超时"
    except Exception as e:
        return False, f"❌ {service_name} 异常: {str(e)}"

def test_brainnn_think() -> bool:
    """测试 BrainNN /think 端点"""
    try:
        response = requests.post(
            f'{SERVICES["brainnn"]}/think',
            json={
                'text': '你好',
                'source': 'test'
            },
            timeout=5
        )
        if response.status_code == 200:
            data = response.json()
            # 检查是否调用了 Agent Core 和 Neuro-Symbolic Bridge
            has_agent = 'agent_analysis' in data
            has_neuro = 'neuro_symbolic' in data
            
            if has_agent or has_neuro:
                print_success("BrainNN /think 端点正常，已调用关键服务")
                return True
            else:
                print_warning("BrainNN /think 端点正常，但未检测到 Agent Core 或 Neuro-Symbolic 调用")
                return True
        else:
            print_error(f"BrainNN /think 返回错误: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"BrainNN /think 测试失败: {str(e)}")
        return False

def test_brainnn_tick() -> bool:
    """测试 BrainNN /tick 端点"""
    try:
        response = requests.get(
            f'{SERVICES["brainnn"]}/tick',
            timeout=5
        )
        if response.status_code == 200:
            data = response.json()
            print_success("BrainNN /tick 端点正常")
            return True
        else:
            print_error(f"BrainNN /tick 返回错误: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"BrainNN /tick 测试失败: {str(e)}")
        return False

def test_neuro_symbolic_check() -> bool:
    """测试 Neuro-Symbolic Bridge /check 端点"""
    try:
        response = requests.post(
            f'{SERVICES["neuro_symbolic_bridge"]}/check',
            json={
                'text': '你好',
                'source': 'test',
                'soul_state': {
                    'emotion': {'joy': 0.5},
                    'drives': {'boredom': 0.3}
                }
            },
            timeout=5
        )
        if response.status_code == 200:
            data = response.json()
            if 'result' in data:
                print_success("Neuro-Symbolic Bridge /check 端点正常")
                return True
            else:
                print_warning("Neuro-Symbolic Bridge /check 返回异常格式")
                return False
        else:
            print_error(f"Neuro-Symbolic Bridge /check 返回错误: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Neuro-Symbolic Bridge /check 测试失败: {str(e)}")
        return False

def test_memory_system_store() -> bool:
    """测试 Memory System V2 /memory/store 端点"""
    try:
        response = requests.post(
            f'{SERVICES["memory_system_v2"]}/memory/store',
            json={
                'content': '测试记忆',
                'source': 'test',
                'userId': 'test_user',
                'type': 'auto',
                'metadata': {
                    'emotion': {'joy': 0.5},
                    'drives': {'boredom': 0.3}
                }
            },
            timeout=5
        )
        if response.status_code == 200:
            data = response.json()
            if data.get('success'):
                print_success("Memory System V2 /memory/store 端点正常")
                return True
            else:
                print_warning("Memory System V2 /memory/store 返回失败")
                return False
        else:
            print_error(f"Memory System V2 /memory/store 返回错误: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Memory System V2 /memory/store 测试失败: {str(e)}")
        return False

def test_memory_universe_chat() -> bool:
    """测试 Memory Universe /api/chat 端点"""
    try:
        response = requests.post(
            f'{SERVICES["memory_universe"]}/api/chat',
            json={
                'message': '你好',
                'userId': 'test_user'
            },
            timeout=10
        )
        if response.status_code == 200:
            data = response.json()
            if 'text' in data or 'success' in data:
                print_success("Memory Universe /api/chat 端点正常")
                return True
            else:
                print_warning("Memory Universe /api/chat 返回异常格式")
                return False
        else:
            print_error(f"Memory Universe /api/chat 返回错误: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Memory Universe /api/chat 测试失败: {str(e)}")
        return False

def test_prediction_engine() -> bool:
    """测试 Prediction Engine 连接"""
    try:
        response = requests.get(
            f'{SERVICES["prediction_engine"]}/health',
            timeout=3
        )
        if response.status_code == 200:
            print_success("Prediction Engine 连接正常")
            return True
        else:
            print_warning(f"Prediction Engine 返回状态码: {response.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        print_warning("Prediction Engine 未启动（可选服务）")
        return True  # 不是必需的
    except Exception as e:
        print_warning(f"Prediction Engine 连接异常: {str(e)}（可选服务）")
        return True  # 不是必需的

def main():
    print_header("NN 链路完整性验证")
    
    # 1. 检查所有服务健康状态
    print_info("第一步：检查所有服务健康状态")
    print("-" * 60)
    
    health_results = {}
    for service_name, endpoint in SERVICES.items():
        healthy, message = check_service_health(service_name, endpoint)
        health_results[service_name] = healthy
        print(message)
    
    # 统计健康服务
    healthy_count = sum(1 for v in health_results.values() if v)
    total_count = len(health_results)
    print(f"\n健康服务: {healthy_count}/{total_count}")
    
    # 2. 测试关键端点
    print_info("\n第二步：测试关键端点")
    print("-" * 60)
    
    endpoint_results = {}
    
    if health_results.get('brainnn'):
        endpoint_results['brainnn_think'] = test_brainnn_think()
        endpoint_results['brainnn_tick'] = test_brainnn_tick()
    else:
        print_warning("BrainNN 未启动，跳过端点测试")
    
    if health_results.get('neuro_symbolic_bridge'):
        endpoint_results['neuro_symbolic_check'] = test_neuro_symbolic_check()
    else:
        print_warning("Neuro-Symbolic Bridge 未启动，跳过端点测试")
    
    if health_results.get('memory_system_v2'):
        endpoint_results['memory_store'] = test_memory_system_store()
    else:
        print_warning("Memory System V2 未启动，跳过端点测试")
    
    if health_results.get('memory_universe'):
        endpoint_results['memory_universe_chat'] = test_memory_universe_chat()
    else:
        print_warning("Memory Universe 未启动，跳过端点测试")
    
    # 3. 测试可选服务
    print_info("\n第三步：测试可选服务")
    print("-" * 60)
    
    test_prediction_engine()
    
    # 4. 生成报告
    print_header("验证报告")
    
    # 必需服务
    required_services = ['brainnn', 'memory_universe', 'neuro_symbolic_bridge', 'memory_system_v2']
    required_healthy = sum(1 for s in required_services if health_results.get(s))
    
    print(f"必需服务健康: {required_healthy}/{len(required_services)}")
    for service in required_services:
        status = "✅" if health_results.get(service) else "❌"
        print(f"  {status} {service}")
    
    # 关键端点
    print(f"\n关键端点测试: {sum(endpoint_results.values())}/{len(endpoint_results)}")
    for endpoint, result in endpoint_results.items():
        status = "✅" if result else "❌"
        print(f"  {status} {endpoint}")
    
    # 最终结论
    print_header("最终结论")
    
    all_required_healthy = all(health_results.get(s) for s in required_services)
    all_endpoints_ok = all(endpoint_results.values()) if endpoint_results else False
    
    if all_required_healthy and all_endpoints_ok:
        print_success("✅ NN 链路 100% 通顺！所有关键服务和端点都正常工作。")
        return 0
    elif all_required_healthy:
        print_warning("⚠️  必需服务都已启动，但部分端点测试失败。请检查服务日志。")
        return 1
    else:
        print_error("❌ 部分必需服务未启动。请先启动所有服务。")
        return 1

if __name__ == '__main__':
    sys.exit(main())
