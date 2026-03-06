"""
从 PyTorch checkpoint 导出权重到 JS 格式
"""
import json
import torch
import time
import os
import sys

# 添加项目根目录到路径
script_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(script_dir)
sys.path.insert(0, project_root)
os.chdir(project_root)

# 导入训练模块
import importlib.util
spec = importlib.util.spec_from_file_location("train_brain_pytorch", os.path.join(script_dir, "train-brain-pytorch.py"))
tbp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tbp)

def main():
    print("🔄 加载 checkpoint...")
    checkpoint = torch.load(tbp.CONFIG['CHECKPOINT_PATH'], map_location='cpu')
    
    print("🔧 初始化模型...")
    model = tbp.BrainNN()
    model.load_state_dict(checkpoint['model_state_dict'])
    model.eval()
    
    epoch = checkpoint['epoch']
    acc = checkpoint['val_acc']['overall'] * 100
    print(f"📊 Checkpoint epoch: {epoch}, val_acc: {acc:.1f}%")
    
    print("💾 导出权重...")
    tbp.export_weights(model, tbp.CONFIG['WEIGHTS_PATH'])
    
    print("✅ 完成!")

if __name__ == '__main__':
    main()
