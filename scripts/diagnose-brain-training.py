"""
诊断 BrainNN 训练问题
检查模型预测分布是否多样化
"""

import json
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from pathlib import Path
from collections import Counter

# 复用训练脚本的配置和模型定义
CONFIG = {
    'STATE_DIM': 27,
    'PERCEPTION_DIM': 8,
    'EMBEDDING_DIM': 1024,
    'HIDDEN_DIM': 512,
    'NUM_HEADS': 8,
    'NUM_LAYERS': 4,
    'FFN_DIM': 1024,
    'MAX_REASONING_STEPS': 5,
    'MIN_REASONING_STEPS': 1,
    'REASONING_HIDDEN_DIM': 256,
    'HALT_THRESHOLD': 0.8,
    'NUM_DIRECTIONS': 6,
    'NUM_EMOTIONS': 8,
    'NUM_STRATEGIES': 7,
    'NUM_TONES': 6,
}

DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# 标签名称
DIRECTION_NAMES = ['answer', 'question', 'share', 'react', 'recall', 'ignore']
EMOTION_NAMES = ['joy', 'curiosity', 'empathy', 'surprise', 'concern', 'playful', 'calm', 'annoyed']
STRATEGY_NAMES = ['direct_answer', 'share_experience', 'ask_back', 'empathize', 'joke', 'deflect', 'silent']
TONE_NAMES = ['warm', 'playful', 'serious', 'curious', 'supportive', 'teasing']


class BrainDataset(Dataset):
    def __init__(self, samples):
        self.samples = samples
        self.direction_map = {'answer': 0, 'question': 1, 'share': 2, 'react': 3, 'recall': 4, 'ignore': 5}
        self.emotion_map = {'joy': 0, 'curiosity': 1, 'empathy': 2, 'surprise': 3, 'concern': 4, 'playful': 5, 'calm': 6, 'annoyed': 7}
        self.strategy_map = {'direct_answer': 0, 'share_experience': 1, 'ask_back': 2, 'empathize': 3, 'joke': 4, 'deflect': 5, 'silent': 6}
        self.tone_map = {'warm': 0, 'playful': 1, 'serious': 2, 'curious': 3, 'supportive': 4, 'teasing': 5}
    
    def __len__(self):
        return len(self.samples)
    
    def __getitem__(self, idx):
        s = self.samples[idx]
        state = self._pad(s['input']['stateVector'], CONFIG['STATE_DIM'])
        perc = self._pad(s['input']['perceptionVector'], CONFIG['PERCEPTION_DIM'])
        msg_emb = self._pad(s['input']['messageEmbedding'], CONFIG['EMBEDDING_DIM'])
        mem_emb = self._pad(s['input']['memoryEmbedding'], CONFIG['EMBEDDING_DIM'])
        
        target = s['target']
        direction = self.direction_map.get(target['direction'], 0)
        emotion = self.emotion_map.get(target['emotionType'], 6)
        strategy = self.strategy_map.get(target['strategyType'], 0)
        tone = self.tone_map.get(target['tone'], 0)
        
        return {
            'state': torch.tensor(state, dtype=torch.float32),
            'perc': torch.tensor(perc, dtype=torch.float32),
            'msg_emb': torch.tensor(msg_emb, dtype=torch.float32),
            'mem_emb': torch.tensor(mem_emb, dtype=torch.float32),
            'direction': torch.tensor(direction, dtype=torch.long),
            'emotion': torch.tensor(emotion, dtype=torch.long),
            'strategy': torch.tensor(strategy, dtype=torch.long),
            'tone': torch.tensor(tone, dtype=torch.long),
        }
    
    def _pad(self, arr, length):
        if arr is None:
            return [0.0] * length
        if len(arr) >= length:
            return arr[:length]
        return arr + [0.0] * (length - len(arr))


# 简化的模型（不需要完整的 ACT）
class SimpleBrainNN(nn.Module):
    def __init__(self):
        super().__init__()
        hidden_dim = CONFIG['HIDDEN_DIM']
        
        # 输入融合
        self.state_proj = nn.Linear(CONFIG['STATE_DIM'], hidden_dim)
        self.perc_proj = nn.Linear(CONFIG['PERCEPTION_DIM'], hidden_dim)
        self.msg_proj = nn.Linear(CONFIG['EMBEDDING_DIM'], hidden_dim)
        self.mem_proj = nn.Linear(CONFIG['EMBEDDING_DIM'], hidden_dim)
        self.fusion = nn.Linear(hidden_dim * 4, hidden_dim)
        self.norm = nn.LayerNorm(hidden_dim)
        
        # 简单的 MLP
        self.mlp = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.GELU(),
            nn.Dropout(0.1),
            nn.Linear(hidden_dim, hidden_dim),
            nn.GELU(),
            nn.Dropout(0.1),
        )
        
        # 输出头
        self.direction_head = nn.Linear(hidden_dim, CONFIG['NUM_DIRECTIONS'])
        self.emotion_head = nn.Linear(hidden_dim, CONFIG['NUM_EMOTIONS'])
        self.strategy_head = nn.Linear(hidden_dim, CONFIG['NUM_STRATEGIES'])
        self.tone_head = nn.Linear(hidden_dim, CONFIG['NUM_TONES'])
    
    def forward(self, state, perc, msg_emb, mem_emb):
        h1 = F.gelu(self.state_proj(state))
        h2 = F.gelu(self.perc_proj(perc))
        h3 = F.gelu(self.msg_proj(msg_emb))
        h4 = F.gelu(self.mem_proj(mem_emb))
        concat = torch.cat([h1, h2, h3, h4], dim=-1)
        h = self.norm(self.fusion(concat))
        h = self.mlp(h)
        
        return {
            'direction': self.direction_head(h),
            'emotion': self.emotion_head(h),
            'strategy': self.strategy_head(h),
            'tone': self.tone_head(h),
        }


def analyze_data_distribution(samples):
    """分析数据分布"""
    print("\n" + "=" * 60)
    print("📊 数据分布分析")
    print("=" * 60)
    
    direction_counts = Counter()
    emotion_counts = Counter()
    strategy_counts = Counter()
    tone_counts = Counter()
    
    for s in samples:
        target = s['target']
        direction_counts[target['direction']] += 1
        emotion_counts[target['emotionType']] += 1
        strategy_counts[target['strategyType']] += 1
        tone_counts[target['tone']] += 1
    
    total = len(samples)
    
    print(f"\n方向 (direction) - 总计 {total}:")
    for name, count in direction_counts.most_common():
        print(f"  {name}: {count} ({count/total*100:.1f}%)")
    
    print(f"\n情绪 (emotion) - 总计 {total}:")
    for name, count in emotion_counts.most_common():
        print(f"  {name}: {count} ({count/total*100:.1f}%)")
    
    print(f"\n策略 (strategy) - 总计 {total}:")
    for name, count in strategy_counts.most_common():
        print(f"  {name}: {count} ({count/total*100:.1f}%)")
    
    print(f"\n语气 (tone) - 总计 {total}:")
    for name, count in tone_counts.most_common():
        print(f"  {name}: {count} ({count/total*100:.1f}%)")
    
    # 计算理论最大准确率（如果只预测最常见类别）
    max_direction = max(direction_counts.values()) / total
    max_emotion = max(emotion_counts.values()) / total
    max_strategy = max(strategy_counts.values()) / total
    max_tone = max(tone_counts.values()) / total
    
    print(f"\n⚠️ 如果只预测最常见类别的理论准确率:")
    print(f"  方向: {max_direction*100:.1f}%")
    print(f"  情绪: {max_emotion*100:.1f}%")
    print(f"  策略: {max_strategy*100:.1f}%")
    print(f"  语气: {max_tone*100:.1f}%")
    print(f"  总体: {(max_direction + max_emotion + max_strategy + max_tone) / 4 * 100:.1f}%")


def analyze_input_variance(samples):
    """分析输入数据的方差"""
    print("\n" + "=" * 60)
    print("📈 输入数据方差分析")
    print("=" * 60)
    
    # 收集所有输入
    all_state = []
    all_perc = []
    all_msg = []
    all_mem = []
    
    for s in samples[:1000]:  # 只分析前 1000 个
        inp = s['input']
        all_state.append(inp['stateVector'][:CONFIG['STATE_DIM']] if inp['stateVector'] else [0]*CONFIG['STATE_DIM'])
        all_perc.append(inp['perceptionVector'][:CONFIG['PERCEPTION_DIM']] if inp['perceptionVector'] else [0]*CONFIG['PERCEPTION_DIM'])
        all_msg.append(inp['messageEmbedding'][:100] if inp['messageEmbedding'] else [0]*100)  # 只看前 100 维
        all_mem.append(inp['memoryEmbedding'][:100] if inp['memoryEmbedding'] else [0]*100)
    
    import numpy as np
    
    state_arr = np.array(all_state)
    perc_arr = np.array(all_perc)
    msg_arr = np.array(all_msg)
    mem_arr = np.array(all_mem)
    
    print(f"\nstateVector:")
    print(f"  均值范围: [{state_arr.mean(axis=0).min():.4f}, {state_arr.mean(axis=0).max():.4f}]")
    print(f"  方差范围: [{state_arr.var(axis=0).min():.4f}, {state_arr.var(axis=0).max():.4f}]")
    print(f"  总方差: {state_arr.var():.4f}")
    
    print(f"\nperceptionVector:")
    print(f"  均值范围: [{perc_arr.mean(axis=0).min():.4f}, {perc_arr.mean(axis=0).max():.4f}]")
    print(f"  方差范围: [{perc_arr.var(axis=0).min():.4f}, {perc_arr.var(axis=0).max():.4f}]")
    print(f"  总方差: {perc_arr.var():.4f}")
    
    print(f"\nmessageEmbedding (前100维):")
    print(f"  均值范围: [{msg_arr.mean(axis=0).min():.4f}, {msg_arr.mean(axis=0).max():.4f}]")
    print(f"  方差范围: [{msg_arr.var(axis=0).min():.4f}, {msg_arr.var(axis=0).max():.4f}]")
    print(f"  总方差: {msg_arr.var():.4f}")
    
    print(f"\nmemoryEmbedding (前100维):")
    print(f"  均值范围: [{mem_arr.mean(axis=0).min():.4f}, {mem_arr.mean(axis=0).max():.4f}]")
    print(f"  方差范围: [{mem_arr.var(axis=0).min():.4f}, {mem_arr.var(axis=0).max():.4f}]")
    print(f"  总方差: {mem_arr.var():.4f}")


def train_and_analyze(samples):
    """训练简化模型并分析预测分布"""
    print("\n" + "=" * 60)
    print("🔬 训练简化模型并分析预测")
    print("=" * 60)
    
    # 划分数据
    val_size = int(len(samples) * 0.15)
    train_samples = samples[val_size:]
    val_samples = samples[:val_size]
    
    train_dataset = BrainDataset(train_samples)
    val_dataset = BrainDataset(val_samples)
    
    train_loader = DataLoader(train_dataset, batch_size=64, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=64, shuffle=False)
    
    # 创建模型
    model = SimpleBrainNN().to(DEVICE)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001)
    
    # 训练 5 个 epoch
    print("\n训练 5 个 epoch...")
    for epoch in range(5):
        model.train()
        for batch in train_loader:
            batch = {k: v.to(DEVICE) for k, v in batch.items()}
            optimizer.zero_grad()
            outputs = model(batch['state'], batch['perc'], batch['msg_emb'], batch['mem_emb'])
            
            loss = (
                F.cross_entropy(outputs['direction'], batch['direction']) +
                F.cross_entropy(outputs['emotion'], batch['emotion']) +
                F.cross_entropy(outputs['strategy'], batch['strategy']) +
                F.cross_entropy(outputs['tone'], batch['tone'])
            )
            loss.backward()
            optimizer.step()
        
        # 评估
        model.eval()
        pred_directions = []
        pred_emotions = []
        pred_strategies = []
        pred_tones = []
        true_directions = []
        true_emotions = []
        true_strategies = []
        true_tones = []
        
        with torch.no_grad():
            for batch in val_loader:
                batch = {k: v.to(DEVICE) for k, v in batch.items()}
                outputs = model(batch['state'], batch['perc'], batch['msg_emb'], batch['mem_emb'])
                
                pred_directions.extend(outputs['direction'].argmax(dim=1).cpu().tolist())
                pred_emotions.extend(outputs['emotion'].argmax(dim=1).cpu().tolist())
                pred_strategies.extend(outputs['strategy'].argmax(dim=1).cpu().tolist())
                pred_tones.extend(outputs['tone'].argmax(dim=1).cpu().tolist())
                
                true_directions.extend(batch['direction'].cpu().tolist())
                true_emotions.extend(batch['emotion'].cpu().tolist())
                true_strategies.extend(batch['strategy'].cpu().tolist())
                true_tones.extend(batch['tone'].cpu().tolist())
        
        # 计算准确率
        dir_acc = sum(p == t for p, t in zip(pred_directions, true_directions)) / len(pred_directions)
        emo_acc = sum(p == t for p, t in zip(pred_emotions, true_emotions)) / len(pred_emotions)
        str_acc = sum(p == t for p, t in zip(pred_strategies, true_strategies)) / len(pred_strategies)
        tone_acc = sum(p == t for p, t in zip(pred_tones, true_tones)) / len(pred_tones)
        
        print(f"Epoch {epoch+1}: dir={dir_acc*100:.1f}% emo={emo_acc*100:.1f}% str={str_acc*100:.1f}% tone={tone_acc*100:.1f}%")
    
    # 分析预测分布
    print("\n预测分布分析:")
    
    print(f"\n方向预测分布:")
    pred_dir_counts = Counter(pred_directions)
    for idx, count in pred_dir_counts.most_common():
        print(f"  {DIRECTION_NAMES[idx]}: {count} ({count/len(pred_directions)*100:.1f}%)")
    
    print(f"\n情绪预测分布:")
    pred_emo_counts = Counter(pred_emotions)
    for idx, count in pred_emo_counts.most_common():
        print(f"  {EMOTION_NAMES[idx]}: {count} ({count/len(pred_emotions)*100:.1f}%)")
    
    print(f"\n策略预测分布:")
    pred_str_counts = Counter(pred_strategies)
    for idx, count in pred_str_counts.most_common():
        print(f"  {STRATEGY_NAMES[idx]}: {count} ({count/len(pred_strategies)*100:.1f}%)")
    
    print(f"\n语气预测分布:")
    pred_tone_counts = Counter(pred_tones)
    for idx, count in pred_tone_counts.most_common():
        print(f"  {TONE_NAMES[idx]}: {count} ({count/len(pred_tones)*100:.1f}%)")


def main():
    print("🔍 BrainNN 训练诊断工具")
    
    # 加载数据
    data_path = Path('data/training/brain-training-data.json')
    with open(data_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    samples = data['samples'] if 'samples' in data else data
    print(f"加载了 {len(samples)} 个样本")
    
    # 分析数据分布
    analyze_data_distribution(samples)
    
    # 分析输入方差
    analyze_input_variance(samples)
    
    # 训练并分析
    train_and_analyze(samples)


if __name__ == '__main__':
    main()
