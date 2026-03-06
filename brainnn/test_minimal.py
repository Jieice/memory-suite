#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
最小化测试 - 直接测试嵌套学习系统，不依赖 HTTP
"""

import sys
import json
from nested_learning_upgrade import (
    NestedLearningSystem,
    SelfModifyingLearner,
    ContinuumMemorySystem
)

def test_nested_learning_system():
    """测试嵌套学习系统"""
    print("\n" + "="*60)
    print("测试 1: NestedLearningSystem 初始化")
    print("="*60)
    
    try:
        system = NestedLearningSystem()
        print("✅ 系统初始化成功")
        print(f"   层级数: {len(system.levels)}")
        for name, level in system.levels.items():
            print(f"   - {name}: {level.name} ({level.timescale.name})")
        return True
    except Exception as e:
        print(f"❌ 失败: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_process_input():
    """测试处理输入"""
    print("\n" + "="*60)
    print("测试 2: 处理输入")
    print("="*60)
    
    try:
        system = NestedLearningSystem()
        result = system.process_input({
            'type': 'danmaku',
            'content': '你好'
        })
        
        print("✅ 输入处理成功")
        print(f"   结果键: {list(result.keys())}")
        return True
    except Exception as e:
        print(f"❌ 失败: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_self_modifier():
    """测试自修改学习"""
    print("\n" + "="*60)
    print("测试 3: SelfModifyingLearner")
    print("="*60)
    
    try:
        learner = SelfModifyingLearner()
        feedback = {'sentiment': 'positive', 'score': 0.9}
        learner.learn_from_feedback(feedback)
        
        print("✅ 自修改学习初始化成功")
        print(f"   学习历史大小: {len(learner.learning_history)}")
        return True
    except Exception as e:
        print(f"❌ 失败: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_continuum_memory():
    """测试连续记忆系统"""
    print("\n" + "="*60)
    print("测试 4: ContinuumMemorySystem")
    print("="*60)
    
    try:
        memory = ContinuumMemorySystem()
        memory.store_memory("测试记忆", importance=0.8)
        recalled = memory.recall_memory("", layer='all')
        
        print("✅ 连续记忆系统初始化成功")
        print(f"   存储的记忆数: {len(recalled)}")
        return True
    except Exception as e:
        print(f"❌ 失败: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_system_state():
    """测试获取系统状态"""
    print("\n" + "="*60)
    print("测试 5: 获取系统状态")
    print("="*60)
    
    try:
        system = NestedLearningSystem()
        state = system.get_system_state()
        
        print("✅ 系统状态获取成功")
        print(f"   状态键: {list(state.keys())}")
        print(f"   层级数: {len(state['levels'])}")
        return True
    except Exception as e:
        print(f"❌ 失败: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_multi_input():
    """测试多次输入"""
    print("\n" + "="*60)
    print("测试 6: 多次输入处理")
    print("="*60)
    
    try:
        system = NestedLearningSystem()
        inputs = ['你好', '你叫什么', '谢谢']
        
        for i, text in enumerate(inputs):
            result = system.process_input({
                'type': 'danmaku',
                'content': text
            })
            print(f"   输入 {i+1}: {text} ✅")
        
        print("✅ 多次输入处理成功")
        return True
    except Exception as e:
        print(f"❌ 失败: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    print("\n" + "="*60)
    print("嵌套学习系统最小化测试")
    print("="*60)
    
    tests = [
        test_nested_learning_system,
        test_process_input,
        test_self_modifier,
        test_continuum_memory,
        test_system_state,
        test_multi_input
    ]
    
    results = []
    for test in tests:
        try:
            result = test()
            results.append(result)
        except Exception as e:
            print(f"❌ 测试异常: {e}")
            results.append(False)
    
    # 总结
    print("\n" + "="*60)
    print("测试总结")
    print("="*60)
    passed = sum(results)
    total = len(results)
    print(f"通过: {passed}/{total}")
    print(f"成功率: {passed/total*100:.1f}%")
    
    if passed == total:
        print("\n✅ 所有测试通过！嵌套学习系统工作正常！")
        return 0
    else:
        print(f"\n❌ 有 {total-passed} 个测试失败")
        return 1

if __name__ == '__main__':
    sys.exit(main())
