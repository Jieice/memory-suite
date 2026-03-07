#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
快速修复脚本 - 为所有 Python 服务添加 UTF-8 编码支持
"""

import os
import sys
import re

def fix_python_file(filepath):
    """为 Python 文件添加 UTF-8 编码配置"""
    print(f"正在修复: {filepath}")
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 检查是否已经有 JSON_AS_ASCII 配置
    if 'JSON_AS_ASCII' in content:
        print(f"  ✓ 已经配置过编码")
        return
    
    # 移除旧的错误配置（如果存在）
    old_config = """
# 设置 UTF-8 编码
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
"""
    content = content.replace(old_config, '')
    
    # 如果是 Flask 应用，在 app = Flask(__name__) 后添加配置
    if 'Flask(__name__)' in content and 'JSON_AS_ASCII' not in content:
        # 找到 app = Flask(__name__) 的位置
        pattern = r'(app = Flask\(__name__\)\s*\n(?:CORS\(app\)\s*\n)?)'
        replacement = r'\1\n# 确保 Flask JSON 响应使用 UTF-8\napp.config[\'JSON_AS_ASCII\'] = False\napp.config[\'JSONIFY_MIMETYPE\'] = \'application/json; charset=utf-8\'\n'
        content = re.sub(pattern, replacement, content)
    
    # 写回文件
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"  ✓ 修复完成")

def main():
    """主函数"""
    print("=" * 60)
    print("Memory Suite - UTF-8 编码修复工具 v2")
    print("=" * 60)
    print()
    
    # 需要修复的文件列表
    files_to_fix = [
        'brainnn/server.py',
        'brainnn/agent_core.py',
        'brainnn/memory_system_v2.py',
        'brainnn/reflection_engine.py',
        'brainnn/neuro_symbolic_bridge.py',
    ]
    
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    for filepath in files_to_fix:
        full_path = os.path.join(base_dir, filepath)
        if os.path.exists(full_path):
            fix_python_file(full_path)
        else:
            print(f"⚠️  文件不存在: {filepath}")
    
    print()
    print("=" * 60)
    print("✓ 所有文件修复完成！")
    print("=" * 60)
    print()
    print("下一步:")
    print("1. 重启统一运行时: stop-all.bat && start-unified.bat")
    print("2. 测试中文显示")
    print()

if __name__ == '__main__':
    main()
