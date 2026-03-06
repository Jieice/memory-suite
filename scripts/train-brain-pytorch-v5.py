"""
BrainNN v5.0 PyTorch 训练脚本 - 完整版

v5.0 完整特性：
- v2.0: Chain-of-Thought 多步推理 (ACT)
- v3.0: Neural Memory 可微分记忆 (NTM-style)
- v4.0: World Model 预测用户反应
- v5.0: Meta-Learning 快速适应 (MAML-inspired)

架构概览：
┌─────────────────────────────────────────────────────────────┐
│                    BrainNN v5.0                              │
├─────────────────────────────────────────────────────────────┤
│  输入层                                                      │
│  ├── 状态向量 (27d) ──┐                                      │
│  ├── 感知向量 (8d)  ──┼── InputFusion ──► 隐藏状态 (512d)    │
│  ├── 消息嵌入 (1024d)─┤                                      │
│  └── 记忆嵌入 (1024d)─┘                                      │
├─────────────────────────────────────────────────────────────┤
│  编码层                                                      │
│  └── Transformer × 4 ──► 上下文表示                          │
├─────────────────────────────────────────────────────────────┤
│  v3.0 Neural Memory (NTM)                                    │
│  ├── Memory Bank (64 slots × 256d)                          │
│  ├── Read Head (content + location addressing)              │
│  └── Write Head (erase + add)                               │
├─────────────────────────────────────────────────────────────┤
│  v2.0 Chain-of-Thought (ACT)                                │
│  └── ReasoningCell × 1-5 steps (adaptive)                   │
├─────────────────────────────────────────────────────────────┤
│  v4.0 World Model                                           │
│  ├── User State Predictor (预测用户下一状态)                 │
│  ├── Response Effect Predictor (预测回复效果)                │
│  └── Counterfactual Reasoning (反事实推理)                   │
├─────────────────────────────────────────────────────────────┤
│  v5.0 Meta-Learning                                         │
│  ├── Task Encoder (识别对话类型)                             │
│  ├── Fast Weights (快速适应层)                               │
│  └── Adaptation Gate (控制适应程度)                          │
├─────────────────────────────────────────────────────────────┤
│  输出层                                                      │
│  ├── ThinkingHead ──► 思考方向、话题、关键词                 │
│  ├── EmotionHead ──► 情绪类型、强度、趋势                    │
│  ├── StrategyHead ──► 回复策略、语气、长度                   │
│  └── MemoryHead ──► 记忆联想、是否提及                       │
└─────────────────────────────────────────────────────────────┘

使用方法：
  python scripts/train-brain-pytorch-v5.py

训练完成后权重导出到 data/models/brain-nn-weights-v5.json
"""

import json
import os
import sys
import math
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from pathlib import Path
import time
from typing import Optional, List, Dict, Tuple
import random
import numpy as np

# 设置随机种子
SEED = 42
random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)
if torch.cuda.is_available():
    torch.cuda.manual_seed_all(SEED)

# ==================== 配置 ====================

CONFIG = {
    # 输入维度
    'STATE_DIM': 27,
    'PERCEPTION_DIM': 8,
    'EMBEDDING_DIM': 1024,
    
    # 网络结构（轻量版）
    'HIDDEN_DIM': 256,            # 减半
    'NUM_HEADS': 4,               # 减半
    'NUM_LAYERS': 2,              # 减半
    'FFN_DIM': 512,               # 减半
    'DROPOUT': 0.1,
    
    # v2.0 Chain-of-Thought 配置
    'MAX_REASONING_STEPS': 5,
    'MIN_REASONING_STEPS': 1,
    'REASONING_HIDDEN_DIM': 256,
    'HALT_THRESHOLD': 0.8,
    
    # v3.0 Neural Memory 配置（轻量版）
    'MEMORY_SLOTS': 32,           # 记忆槽数量（减半）
    'MEMORY_DIM': 128,            # 每个记忆槽的维度（减半）
    'NUM_READ_HEADS': 1,          # 读取头数量（减少）
    'NUM_WRITE_HEADS': 1,         # 写入头数量
    
    # v4.0 World Model 配置
    'WORLD_MODEL_DIM': 256,       # 世界模型隐藏维度
    'USER_STATE_DIM': 64,         # 用户状态维度
    'NUM_RESPONSE_EFFECTS': 5,    # 预测的回复效果类型数
    
    # v5.0 Meta-Learning 配置（轻量版）
    'TASK_EMBEDDING_DIM': 32,     # 任务嵌入维度（减小）
    'NUM_TASK_TYPES': 8,          # 任务类型数量
    'FAST_WEIGHT_DIM': 32,        # 快速权重维度（大幅减小）
    'ADAPTATION_STEPS': 3,        # 内循环适应步数
    'META_LR': 0.001,             # 元学习率
    
    # 输出维度
    'NUM_DIRECTIONS': 6,
    'NUM_EMOTIONS': 8,
    'NUM_STRATEGIES': 7,
    'NUM_TONES': 6,
    
    # 训练参数
    'BATCH_SIZE': 32,
    'EPOCHS': 150,
    'LR': 0.0003,
    'LR_DECAY': 0.95,
    'WEIGHT_DECAY': 1e-5,
    'WARMUP_STEPS': 500,
    'PONDER_COST': 0.005,
    'PATIENCE': 25,
    
    # 路径
    'DATA_PATH': 'data/training/brain-training-data-merged.json',
    'WEIGHTS_PATH': 'data/models/brain-nn-weights-v5.json',
    'CHECKPOINT_PATH': 'data/models/brain-nn-checkpoint-v5.pt',
}

DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f"[Device] Using: {DEVICE}")
if torch.cuda.is_available():
    print(f"   GPU: {torch.cuda.get_device_name(0)}")
    print(f"   VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")


# ==================== 数据集 ====================

class BrainDataset(Dataset):
    def __init__(self, samples):
        self.samples = samples
        
        # 标签映射
        self.direction_map = {'answer': 0, 'question': 1, 'share': 2, 'react': 3, 'recall': 4, 'ignore': 5}
        self.emotion_map = {'joy': 0, 'curiosity': 1, 'empathy': 2, 'surprise': 3, 'concern': 4, 'playful': 5, 'calm': 6, 'annoyed': 7}
        self.strategy_map = {'direct_answer': 0, 'share_experience': 1, 'ask_back': 2, 'empathize': 3, 'joke': 4, 'deflect': 5, 'silent': 6}
        self.tone_map = {'warm': 0, 'playful': 1, 'serious': 2, 'curious': 3, 'supportive': 4, 'teasing': 5}
        
        # v5.0: 任务类型映射
        self.task_type_map = {
            'greeting': 0, 'question': 1, 'emotional': 2, 'casual': 3,
            'technical': 4, 'story': 5, 'humor': 6, 'other': 7
        }
    
    def __len__(self):
        return len(self.samples)
    
    def __getitem__(self, idx):
        s = self.samples[idx]
        
        # 输入
        state = self._pad(s['input']['stateVector'], CONFIG['STATE_DIM'])
        perc = self._pad(s['input']['perceptionVector'], CONFIG['PERCEPTION_DIM'])
        msg_emb = self._pad(s['input']['messageEmbedding'], CONFIG['EMBEDDING_DIM'])
        mem_emb = self._pad(s['input']['memoryEmbedding'], CONFIG['EMBEDDING_DIM'])
        
        # 目标
        target = s['target']
        direction = self.direction_map.get(target['direction'], 0)
        emotion = self.emotion_map.get(target['emotionType'], 6)
        emotion_intensity = target.get('emotionIntensity', 0.5)
        strategy = self.strategy_map.get(target['strategyType'], 0)
        tone = self.tone_map.get(target['tone'], 0)
        use_memory = 1.0 if target.get('useMemory', False) else 0.0
        ask_back = 1.0 if target.get('askBack', False) else 0.0
        use_emoji = 1.0 if target.get('useEmoji', False) else 0.0
        
        # v2.0: 复杂度估计
        complexity = self._estimate_complexity(s)
        
        # v5.0: 任务类型
        task_type = self._infer_task_type(s)
        
        return {
            'state': torch.tensor(state, dtype=torch.float32),
            'perc': torch.tensor(perc, dtype=torch.float32),
            'msg_emb': torch.tensor(msg_emb, dtype=torch.float32),
            'mem_emb': torch.tensor(mem_emb, dtype=torch.float32),
            'direction': torch.tensor(direction, dtype=torch.long),
            'emotion': torch.tensor(emotion, dtype=torch.long),
            'emotion_intensity': torch.tensor(emotion_intensity, dtype=torch.float32),
            'strategy': torch.tensor(strategy, dtype=torch.long),
            'tone': torch.tensor(tone, dtype=torch.long),
            'use_memory': torch.tensor(use_memory, dtype=torch.float32),
            'ask_back': torch.tensor(ask_back, dtype=torch.float32),
            'use_emoji': torch.tensor(use_emoji, dtype=torch.float32),
            'complexity': torch.tensor(complexity, dtype=torch.float32),
            'task_type': torch.tensor(task_type, dtype=torch.long),
        }
    
    def _pad(self, arr, length):
        if arr is None:
            return [0.0] * length
        if len(arr) >= length:
            return arr[:length]
        return arr + [0.0] * (length - len(arr))
    
    def _estimate_complexity(self, sample) -> float:
        """估计样本复杂度 (0-1)"""
        complexity = 0.3
        target = sample.get('target', {})
        
        if target.get('useMemory', False):
            complexity += 0.2
        if target.get('askBack', False):
            complexity += 0.15
        
        complex_strategies = ['share_experience', 'empathize', 'ask_back']
        if target.get('strategyType') in complex_strategies:
            complexity += 0.15
        
        complex_directions = ['recall', 'share']
        if target.get('direction') in complex_directions:
            complexity += 0.1
        
        return min(1.0, complexity)
    
    def _infer_task_type(self, sample) -> int:
        """推断任务类型"""
        target = sample.get('target', {})
        direction = target.get('direction', '')
        strategy = target.get('strategyType', '')
        emotion = target.get('emotionType', '')
        
        # 简单规则推断
        if direction == 'answer' and strategy == 'direct_answer':
            return 1  # question
        elif emotion in ['empathy', 'concern']:
            return 2  # emotional
        elif strategy == 'joke':
            return 6  # humor
        elif direction == 'share':
            return 5  # story
        elif direction == 'react':
            return 3  # casual
        else:
            return 7  # other


# ==================== 模型组件 ====================

class InputFusion(nn.Module):
    """输入融合层"""
    def __init__(self, hidden_dim, embedding_dim):
        super().__init__()
        self.state_proj = nn.Linear(CONFIG['STATE_DIM'], hidden_dim)
        self.perc_proj = nn.Linear(CONFIG['PERCEPTION_DIM'], hidden_dim)
        self.msg_proj = nn.Linear(embedding_dim, hidden_dim)
        self.mem_proj = nn.Linear(embedding_dim, hidden_dim)
        self.fusion = nn.Linear(hidden_dim * 4, hidden_dim)
        self.norm = nn.LayerNorm(hidden_dim)
        self.dropout = nn.Dropout(CONFIG['DROPOUT'])
    
    def forward(self, state, perc, msg_emb, mem_emb):
        h1 = F.gelu(self.state_proj(state))
        h2 = F.gelu(self.perc_proj(perc))
        h3 = F.gelu(self.msg_proj(msg_emb))
        h4 = F.gelu(self.mem_proj(mem_emb))
        concat = torch.cat([h1, h2, h3, h4], dim=-1)
        return self.norm(self.dropout(self.fusion(concat)))


class TransformerBlock(nn.Module):
    """Transformer 块"""
    def __init__(self, hidden_dim, num_heads, ffn_dim, dropout=0.1):
        super().__init__()
        self.attn = nn.MultiheadAttention(hidden_dim, num_heads, dropout=dropout, batch_first=True)
        self.ffn = nn.Sequential(
            nn.Linear(hidden_dim, ffn_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(ffn_dim, hidden_dim),
            nn.Dropout(dropout)
        )
        self.norm1 = nn.LayerNorm(hidden_dim)
        self.norm2 = nn.LayerNorm(hidden_dim)
        self.dropout = nn.Dropout(dropout)
    
    def forward(self, x):
        x_seq = x.unsqueeze(1)
        attn_out, _ = self.attn(x_seq, x_seq, x_seq)
        x = self.norm1(x + self.dropout(attn_out.squeeze(1)))
        x = self.norm2(x + self.ffn(x))
        return x


# ==================== v3.0 Neural Memory (NTM-style) ====================

class NeuralMemory(nn.Module):
    """
    v3.0 Neural Turing Machine 风格的可微分记忆
    
    特点：
    - 外部记忆矩阵 (Memory Bank)
    - 基于内容的寻址 (Content-based Addressing)
    - 基于位置的寻址 (Location-based Addressing)
    - 可学习的读写操作
    """
    def __init__(self, hidden_dim, memory_slots, memory_dim, num_read_heads, num_write_heads):
        super().__init__()
        self.hidden_dim = hidden_dim
        self.memory_slots = memory_slots
        self.memory_dim = memory_dim
        self.num_read_heads = num_read_heads
        self.num_write_heads = num_write_heads
        
        # 初始记忆（可学习）
        self.init_memory = nn.Parameter(torch.randn(memory_slots, memory_dim) * 0.01)
        
        # 读取头
        self.read_key_proj = nn.Linear(hidden_dim, memory_dim * num_read_heads)
        self.read_beta_proj = nn.Linear(hidden_dim, num_read_heads)  # 锐度
        self.read_gate_proj = nn.Linear(hidden_dim, num_read_heads)  # 内容/位置门
        self.read_shift_proj = nn.Linear(hidden_dim, 3 * num_read_heads)  # 位置偏移 [-1, 0, 1]
        
        # 写入头
        self.write_key_proj = nn.Linear(hidden_dim, memory_dim * num_write_heads)
        self.write_beta_proj = nn.Linear(hidden_dim, num_write_heads)
        self.write_gate_proj = nn.Linear(hidden_dim, num_write_heads)
        self.write_shift_proj = nn.Linear(hidden_dim, 3 * num_write_heads)
        self.erase_proj = nn.Linear(hidden_dim, memory_dim * num_write_heads)
        self.add_proj = nn.Linear(hidden_dim, memory_dim * num_write_heads)
        
        # 读取结果投影
        self.read_out_proj = nn.Linear(memory_dim * num_read_heads, hidden_dim)
        
        # 初始读取权重
        self.init_read_weights = nn.Parameter(torch.zeros(num_read_heads, memory_slots))
        self.init_write_weights = nn.Parameter(torch.zeros(num_write_heads, memory_slots))
        nn.init.uniform_(self.init_read_weights, 0, 1.0 / memory_slots)
        nn.init.uniform_(self.init_write_weights, 0, 1.0 / memory_slots)
    
    def _content_addressing(self, key, memory, beta):
        """基于内容的寻址"""
        # key: [batch, memory_dim], memory: [batch, slots, memory_dim]
        # 计算余弦相似度
        key_norm = F.normalize(key, dim=-1).unsqueeze(1)  # [batch, 1, memory_dim]
        mem_norm = F.normalize(memory, dim=-1)  # [batch, slots, memory_dim]
        similarity = torch.bmm(key_norm, mem_norm.transpose(1, 2)).squeeze(1)  # [batch, slots]
        
        # 应用锐度
        return F.softmax(beta.unsqueeze(-1) * similarity, dim=-1)
    
    def _location_addressing(self, prev_weights, shift, gamma=1.0):
        """基于位置的寻址（循环卷积）"""
        batch_size = prev_weights.size(0)
        # shift: [batch, 3] 对应 [-1, 0, 1] 的权重
        shift = F.softmax(shift, dim=-1)
        
        # 简化的循环卷积
        w_shifted = torch.zeros_like(prev_weights)
        w_shifted += shift[:, 0:1] * torch.roll(prev_weights, -1, dims=-1)
        w_shifted += shift[:, 1:2] * prev_weights
        w_shifted += shift[:, 2:3] * torch.roll(prev_weights, 1, dims=-1)
        
        # 锐化
        w_sharp = w_shifted ** gamma
        return w_sharp / (w_sharp.sum(dim=-1, keepdim=True) + 1e-8)
    
    def forward(self, hidden, prev_memory=None, prev_read_weights=None, prev_write_weights=None):
        """
        Args:
            hidden: [batch, hidden_dim] - 当前隐藏状态
            prev_memory: [batch, slots, memory_dim] - 上一步的记忆
            prev_read_weights: [batch, num_read_heads, slots] - 上一步的读取权重
            prev_write_weights: [batch, num_write_heads, slots] - 上一步的写入权重
        
        Returns:
            read_out: [batch, hidden_dim] - 读取结果
            new_memory: [batch, slots, memory_dim] - 更新后的记忆
            read_weights: [batch, num_read_heads, slots] - 新的读取权重
            write_weights: [batch, num_write_heads, slots] - 新的写入权重
        """
        batch_size = hidden.size(0)
        
        # 初始化记忆和权重
        if prev_memory is None:
            prev_memory = self.init_memory.unsqueeze(0).expand(batch_size, -1, -1)
        if prev_read_weights is None:
            prev_read_weights = F.softmax(self.init_read_weights, dim=-1).unsqueeze(0).expand(batch_size, -1, -1)
        if prev_write_weights is None:
            prev_write_weights = F.softmax(self.init_write_weights, dim=-1).unsqueeze(0).expand(batch_size, -1, -1)
        
        # ===== 读取操作 =====
        read_keys = self.read_key_proj(hidden).view(batch_size, self.num_read_heads, self.memory_dim)
        read_betas = F.softplus(self.read_beta_proj(hidden))  # [batch, num_read_heads]
        read_gates = torch.sigmoid(self.read_gate_proj(hidden))  # [batch, num_read_heads]
        read_shifts = self.read_shift_proj(hidden).view(batch_size, self.num_read_heads, 3)
        
        read_weights_list = []
        read_vectors = []
        
        for i in range(self.num_read_heads):
            # 内容寻址
            content_w = self._content_addressing(
                read_keys[:, i], prev_memory, read_betas[:, i]
            )
            # 插值
            gated_w = read_gates[:, i:i+1] * content_w + (1 - read_gates[:, i:i+1]) * prev_read_weights[:, i]
            # 位置寻址
            final_w = self._location_addressing(gated_w, read_shifts[:, i])
            read_weights_list.append(final_w)
            
            # 读取
            read_vec = torch.bmm(final_w.unsqueeze(1), prev_memory).squeeze(1)  # [batch, memory_dim]
            read_vectors.append(read_vec)
        
        read_weights = torch.stack(read_weights_list, dim=1)  # [batch, num_read_heads, slots]
        read_concat = torch.cat(read_vectors, dim=-1)  # [batch, num_read_heads * memory_dim]
        read_out = self.read_out_proj(read_concat)  # [batch, hidden_dim]
        
        # ===== 写入操作 =====
        write_keys = self.write_key_proj(hidden).view(batch_size, self.num_write_heads, self.memory_dim)
        write_betas = F.softplus(self.write_beta_proj(hidden))
        write_gates = torch.sigmoid(self.write_gate_proj(hidden))
        write_shifts = self.write_shift_proj(hidden).view(batch_size, self.num_write_heads, 3)
        erase_vectors = torch.sigmoid(self.erase_proj(hidden).view(batch_size, self.num_write_heads, self.memory_dim))
        add_vectors = self.add_proj(hidden).view(batch_size, self.num_write_heads, self.memory_dim)
        
        new_memory = prev_memory.clone()
        write_weights_list = []
        
        for i in range(self.num_write_heads):
            # 计算写入权重
            content_w = self._content_addressing(
                write_keys[:, i], prev_memory, write_betas[:, i]
            )
            gated_w = write_gates[:, i:i+1] * content_w + (1 - write_gates[:, i:i+1]) * prev_write_weights[:, i]
            final_w = self._location_addressing(gated_w, write_shifts[:, i])
            write_weights_list.append(final_w)
            
            # 擦除和添加
            # new_memory = memory * (1 - w * e) + w * a
            w_expand = final_w.unsqueeze(-1)  # [batch, slots, 1]
            erase = erase_vectors[:, i].unsqueeze(1)  # [batch, 1, memory_dim]
            add = add_vectors[:, i].unsqueeze(1)  # [batch, 1, memory_dim]
            
            new_memory = new_memory * (1 - w_expand * erase) + w_expand * add
        
        write_weights = torch.stack(write_weights_list, dim=1)
        
        return read_out, new_memory, read_weights, write_weights


# ==================== v2.0 Chain-of-Thought (ACT) ====================

class ReasoningCell(nn.Module):
    """推理单元 - Chain-of-Thought 的核心"""
    def __init__(self, hidden_dim, reasoning_dim):
        super().__init__()
        self.hidden_dim = hidden_dim
        self.reasoning_dim = reasoning_dim
        
        # GRU 风格的推理状态更新
        self.update_gate = nn.Linear(hidden_dim + reasoning_dim, reasoning_dim)
        self.reset_gate = nn.Linear(hidden_dim + reasoning_dim, reasoning_dim)
        self.candidate = nn.Linear(hidden_dim + reasoning_dim, reasoning_dim)
        
        # 停止概率预测
        self.halt_proj = nn.Linear(reasoning_dim, 1)
        
        # 推理状态到隐藏状态的投影
        self.reasoning_to_hidden = nn.Linear(reasoning_dim, hidden_dim)
        
        self.norm = nn.LayerNorm(reasoning_dim)
    
    def forward(self, hidden, reasoning_state):
        combined = torch.cat([hidden, reasoning_state], dim=-1)
        
        z = torch.sigmoid(self.update_gate(combined))
        r = torch.sigmoid(self.reset_gate(combined))
        
        combined_reset = torch.cat([hidden, r * reasoning_state], dim=-1)
        candidate = torch.tanh(self.candidate(combined_reset))
        
        new_reasoning_state = (1 - z) * reasoning_state + z * candidate
        new_reasoning_state = self.norm(new_reasoning_state)
        
        halt_prob = torch.sigmoid(self.halt_proj(new_reasoning_state))
        reasoning_contribution = self.reasoning_to_hidden(new_reasoning_state)
        
        return new_reasoning_state, halt_prob, reasoning_contribution


class AdaptiveComputationTime(nn.Module):
    """v2.0 自适应计算时间 (ACT)"""
    def __init__(self, hidden_dim, reasoning_dim, max_steps):
        super().__init__()
        self.max_steps = max_steps
        self.reasoning_cell = ReasoningCell(hidden_dim, reasoning_dim)
        self.init_reasoning = nn.Parameter(torch.zeros(reasoning_dim))
    
    def forward(self, hidden, threshold=0.8):
        batch_size = hidden.size(0)
        device = hidden.device
        
        reasoning_state = self.init_reasoning.unsqueeze(0).expand(batch_size, -1)
        
        accumulated_hidden = torch.zeros_like(hidden)
        accumulated_halt = torch.zeros(batch_size, 1, device=device)
        remainder = torch.ones(batch_size, 1, device=device)
        
        halt_probs = []
        n_updates = torch.zeros(batch_size, 1, device=device)
        
        for step in range(self.max_steps):
            reasoning_state, halt_prob, reasoning_contribution = self.reasoning_cell(hidden, reasoning_state)
            
            hidden = hidden + reasoning_contribution * 0.1
            
            still_running = (accumulated_halt < threshold).float()
            
            if step == self.max_steps - 1:
                halt_weight = remainder
            else:
                halt_weight = halt_prob * still_running
            
            halt_probs.append(halt_weight.squeeze(-1))
            
            accumulated_hidden = accumulated_hidden + halt_weight * hidden
            accumulated_halt = accumulated_halt + halt_weight
            remainder = remainder - halt_weight
            n_updates = n_updates + still_running
        
        final_hidden = accumulated_hidden / (accumulated_halt + 1e-8)
        ponder_cost = n_updates.squeeze(-1)
        halting_distribution = torch.stack(halt_probs, dim=1)
        
        return final_hidden, ponder_cost, halting_distribution


# ==================== v4.0 World Model ====================

class WorldModel(nn.Module):
    """
    v4.0 世界模型 - 预测用户反应和回复效果
    
    功能：
    1. 预测用户下一状态（情绪、兴趣等）
    2. 预测不同回复策略的效果
    3. 反事实推理（如果用另一种方式回复会怎样）
    """
    def __init__(self, hidden_dim, world_model_dim, user_state_dim, num_response_effects):
        super().__init__()
        self.hidden_dim = hidden_dim
        self.world_model_dim = world_model_dim
        
        # 用户状态编码器
        self.user_state_encoder = nn.Sequential(
            nn.Linear(hidden_dim, world_model_dim),
            nn.GELU(),
            nn.Linear(world_model_dim, user_state_dim)
        )
        
        # 用户状态预测器（预测用户下一状态）
        self.user_state_predictor = nn.Sequential(
            nn.Linear(user_state_dim + hidden_dim, world_model_dim),
            nn.GELU(),
            nn.Dropout(CONFIG['DROPOUT']),
            nn.Linear(world_model_dim, user_state_dim)
        )
        
        # 回复效果预测器
        self.response_effect_predictor = nn.Sequential(
            nn.Linear(hidden_dim + CONFIG['NUM_STRATEGIES'], world_model_dim),
            nn.GELU(),
            nn.Dropout(CONFIG['DROPOUT']),
            nn.Linear(world_model_dim, num_response_effects)
        )
        
        # 反事实推理模块
        self.counterfactual_encoder = nn.Sequential(
            nn.Linear(hidden_dim + CONFIG['NUM_STRATEGIES'] * 2, world_model_dim),
            nn.GELU(),
            nn.Linear(world_model_dim, hidden_dim)
        )
        
        # 世界模型对主隐藏状态的贡献
        self.world_to_hidden = nn.Linear(user_state_dim + num_response_effects, hidden_dim)
    
    def forward(self, hidden, strategy_logits=None):
        """
        Args:
            hidden: [batch, hidden_dim] - 当前隐藏状态
            strategy_logits: [batch, num_strategies] - 策略 logits（可选）
        
        Returns:
            user_state: [batch, user_state_dim] - 预测的用户状态
            response_effects: [batch, num_response_effects] - 预测的回复效果
            world_contribution: [batch, hidden_dim] - 世界模型对隐藏状态的贡献
        """
        batch_size = hidden.size(0)
        
        # 编码当前用户状态
        user_state = self.user_state_encoder(hidden)
        
        # 预测用户下一状态
        user_input = torch.cat([user_state, hidden], dim=-1)
        predicted_user_state = self.user_state_predictor(user_input)
        
        # 预测回复效果
        if strategy_logits is None:
            strategy_logits = torch.zeros(batch_size, CONFIG['NUM_STRATEGIES'], device=hidden.device)
        
        strategy_probs = F.softmax(strategy_logits, dim=-1)
        effect_input = torch.cat([hidden, strategy_probs], dim=-1)
        response_effects = torch.sigmoid(self.response_effect_predictor(effect_input))
        
        # 世界模型贡献
        world_features = torch.cat([predicted_user_state, response_effects], dim=-1)
        world_contribution = self.world_to_hidden(world_features)
        
        return predicted_user_state, response_effects, world_contribution
    
    def counterfactual_reasoning(self, hidden, actual_strategy, alternative_strategy):
        """
        反事实推理：如果用另一种策略会怎样
        
        Args:
            hidden: [batch, hidden_dim]
            actual_strategy: [batch, num_strategies] - 实际策略 one-hot
            alternative_strategy: [batch, num_strategies] - 替代策略 one-hot
        
        Returns:
            counterfactual_hidden: [batch, hidden_dim] - 反事实情况下的隐藏状态
        """
        cf_input = torch.cat([hidden, actual_strategy, alternative_strategy], dim=-1)
        return self.counterfactual_encoder(cf_input)


# ==================== v5.0 Meta-Learning ====================

class MetaLearner(nn.Module):
    """
    v5.0 元学习模块 - 快速适应新对话风格
    
    灵感来自 MAML (Model-Agnostic Meta-Learning)
    
    功能：
    1. 识别当前对话的"任务类型"（闲聊、问答、情感支持等）
    2. 生成任务特定的"快速权重"
    3. 动态调整模型行为以适应当前对话风格
    """
    def __init__(self, hidden_dim, task_embedding_dim, num_task_types, fast_weight_dim):
        super().__init__()
        self.hidden_dim = hidden_dim
        self.task_embedding_dim = task_embedding_dim
        self.num_task_types = num_task_types
        self.fast_weight_dim = fast_weight_dim
        
        # 任务类型嵌入
        self.task_embeddings = nn.Embedding(num_task_types, task_embedding_dim)
        
        # 任务编码器（从隐藏状态推断任务类型）
        self.task_encoder = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.GELU(),
            nn.Dropout(CONFIG['DROPOUT']),
            nn.Linear(hidden_dim // 2, num_task_types)
        )
        
        # 快速权重生成器（Hypernetwork 风格）
        self.fast_weight_generator = nn.Sequential(
            nn.Linear(task_embedding_dim + hidden_dim, hidden_dim),
            nn.GELU(),
            nn.Dropout(CONFIG['DROPOUT']),
            nn.Linear(hidden_dim, fast_weight_dim * hidden_dim)
        )
        
        # 快速权重应用层
        self.fast_weight_proj = nn.Linear(fast_weight_dim, hidden_dim)
        
        # 适应门（控制快速权重的影响程度）
        self.adaptation_gate = nn.Sequential(
            nn.Linear(hidden_dim + task_embedding_dim, hidden_dim // 2),
            nn.GELU(),
            nn.Linear(hidden_dim // 2, 1),
            nn.Sigmoid()
        )
        
        # 上下文记忆（用于跨轮次适应）
        self.context_memory = nn.GRU(
            input_size=hidden_dim,
            hidden_size=task_embedding_dim,
            num_layers=1,
            batch_first=True
        )
        
        # 初始上下文
        self.init_context = nn.Parameter(torch.zeros(1, task_embedding_dim))
    
    def forward(self, hidden, prev_context=None, task_type=None):
        """
        Args:
            hidden: [batch, hidden_dim] - 当前隐藏状态
            prev_context: [batch, task_embedding_dim] - 上一轮的上下文（可选）
            task_type: [batch] - 任务类型标签（训练时提供，推理时自动推断）
        
        Returns:
            adapted_hidden: [batch, hidden_dim] - 适应后的隐藏状态
            task_logits: [batch, num_task_types] - 任务类型预测
            new_context: [batch, task_embedding_dim] - 新的上下文
            adaptation_strength: [batch, 1] - 适应强度
        """
        batch_size = hidden.size(0)
        device = hidden.device
        
        # 初始化上下文
        if prev_context is None:
            prev_context = self.init_context.expand(batch_size, -1)
        
        # 推断任务类型
        task_logits = self.task_encoder(hidden)
        
        # 获取任务嵌入
        if task_type is not None:
            # 训练时：使用真实标签
            task_emb = self.task_embeddings(task_type)
        else:
            # 推理时：使用软预测
            task_probs = F.softmax(task_logits, dim=-1)
            task_emb = torch.matmul(task_probs, self.task_embeddings.weight)
        
        # 更新上下文记忆
        context_input = hidden.unsqueeze(1)  # [batch, 1, hidden_dim]
        _, new_context = self.context_memory(context_input, prev_context.unsqueeze(0).contiguous())
        new_context = new_context.squeeze(0)  # [batch, task_embedding_dim]
        
        # 结合任务嵌入和上下文
        combined_task = task_emb + new_context
        
        # 生成快速权重
        fw_input = torch.cat([combined_task, hidden], dim=-1)
        fast_weights = self.fast_weight_generator(fw_input)
        fast_weights = fast_weights.view(batch_size, self.fast_weight_dim, self.hidden_dim)
        
        # 应用快速权重
        # hidden: [batch, hidden_dim] -> [batch, 1, hidden_dim]
        hidden_expanded = hidden.unsqueeze(1)
        # fast_weights: [batch, fast_weight_dim, hidden_dim]
        # 结果: [batch, 1, fast_weight_dim] -> [batch, fast_weight_dim]
        fast_features = torch.bmm(hidden_expanded, fast_weights.transpose(1, 2)).squeeze(1)
        fast_contribution = self.fast_weight_proj(fast_features)
        
        # 计算适应门
        gate_input = torch.cat([hidden, combined_task], dim=-1)
        adaptation_strength = self.adaptation_gate(gate_input)
        
        # 应用适应
        adapted_hidden = hidden + adaptation_strength * fast_contribution
        
        return adapted_hidden, task_logits, new_context, adaptation_strength


# ==================== BrainNN v5.0 主模型 ====================

class BrainNNv5(nn.Module):
    """
    BrainNN v5.0 - 完整版大脑神经网络
    
    集成所有高级特性：
    - v2.0: Chain-of-Thought 多步推理
    - v3.0: Neural Memory 可微分记忆
    - v4.0: World Model 预测用户反应
    - v5.0: Meta-Learning 快速适应
    """
    def __init__(self):
        super().__init__()
        hidden_dim = CONFIG['HIDDEN_DIM']
        reasoning_dim = CONFIG['REASONING_HIDDEN_DIM']
        
        # ===== 输入融合 =====
        self.input_fusion = InputFusion(hidden_dim, CONFIG['EMBEDDING_DIM'])
        
        # ===== Transformer 编码器 =====
        self.transformers = nn.ModuleList([
            TransformerBlock(hidden_dim, CONFIG['NUM_HEADS'], CONFIG['FFN_DIM'])
            for _ in range(CONFIG['NUM_LAYERS'])
        ])
        
        # ===== v3.0: Neural Memory =====
        self.neural_memory = NeuralMemory(
            hidden_dim=hidden_dim,
            memory_slots=CONFIG['MEMORY_SLOTS'],
            memory_dim=CONFIG['MEMORY_DIM'],
            num_read_heads=CONFIG['NUM_READ_HEADS'],
            num_write_heads=CONFIG['NUM_WRITE_HEADS']
        )
        self.memory_gate = nn.Sequential(
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.Sigmoid()
        )
        
        # ===== v2.0: Chain-of-Thought =====
        self.act = AdaptiveComputationTime(
            hidden_dim, reasoning_dim, CONFIG['MAX_REASONING_STEPS']
        )
        
        # ===== v4.0: World Model =====
        self.world_model = WorldModel(
            hidden_dim=hidden_dim,
            world_model_dim=CONFIG['WORLD_MODEL_DIM'],
            user_state_dim=CONFIG['USER_STATE_DIM'],
            num_response_effects=CONFIG['NUM_RESPONSE_EFFECTS']
        )
        self.world_gate = nn.Sequential(
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.Sigmoid()
        )
        
        # ===== v5.0: Meta-Learning =====
        self.meta_learner = MetaLearner(
            hidden_dim=hidden_dim,
            task_embedding_dim=CONFIG['TASK_EMBEDDING_DIM'],
            num_task_types=CONFIG['NUM_TASK_TYPES'],
            fast_weight_dim=CONFIG['FAST_WEIGHT_DIM']
        )
        
        # ===== 输出头 =====
        self.direction_head = nn.Linear(hidden_dim, CONFIG['NUM_DIRECTIONS'])
        self.emotion_head = nn.Linear(hidden_dim, CONFIG['NUM_EMOTIONS'])
        self.emotion_intensity_head = nn.Linear(hidden_dim, 1)
        self.strategy_head = nn.Linear(hidden_dim, CONFIG['NUM_STRATEGIES'])
        self.tone_head = nn.Linear(hidden_dim, CONFIG['NUM_TONES'])
        self.use_memory_head = nn.Linear(hidden_dim, 1)
        self.ask_back_head = nn.Linear(hidden_dim, 1)
        self.use_emoji_head = nn.Linear(hidden_dim, 1)
        
        # 推理深度预测
        self.depth_predictor = nn.Linear(hidden_dim, 1)
        
        # 最终融合层
        self.final_fusion = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(CONFIG['DROPOUT'])
        )
    
    def forward(self, state, perc, msg_emb, mem_emb, 
                task_type=None,
                prev_memory=None, prev_read_weights=None, prev_write_weights=None,
                prev_context=None,
                use_act=True, use_memory=True, use_world_model=True, use_meta=True):
        """
        完整前向传播
        
        Args:
            state, perc, msg_emb, mem_emb: 输入
            task_type: [batch] - 任务类型（训练时提供）
            prev_memory, prev_read_weights, prev_write_weights: Neural Memory 状态
            prev_context: Meta-Learning 上下文
            use_*: 控制各模块是否启用
        """
        batch_size = state.size(0)
        
        # ===== 1. 输入融合 =====
        h = self.input_fusion(state, perc, msg_emb, mem_emb)
        
        # ===== 2. Transformer 编码 =====
        for block in self.transformers:
            h = block(h)
        
        # ===== 3. v3.0 Neural Memory =====
        memory_out = None
        new_memory = None
        new_read_weights = None
        new_write_weights = None
        
        if use_memory:
            memory_out, new_memory, new_read_weights, new_write_weights = self.neural_memory(
                h, prev_memory, prev_read_weights, prev_write_weights
            )
            # 门控融合
            gate_input = torch.cat([h, memory_out], dim=-1)
            memory_gate = self.memory_gate(gate_input)
            h = h + memory_gate * memory_out
        
        # ===== 4. v2.0 Chain-of-Thought =====
        ponder_cost = torch.zeros(batch_size, device=h.device)
        halting_dist = None
        
        if use_act:
            h, ponder_cost, halting_dist = self.act(h, threshold=CONFIG['HALT_THRESHOLD'])
        
        # ===== 5. v4.0 World Model =====
        user_state = None
        response_effects = None
        
        if use_world_model:
            # 先计算策略 logits
            strategy_logits = self.strategy_head(h)
            user_state, response_effects, world_contribution = self.world_model(h, strategy_logits)
            # 门控融合
            gate_input = torch.cat([h, world_contribution], dim=-1)
            world_gate = self.world_gate(gate_input)
            h = h + world_gate * world_contribution
        
        # ===== 6. v5.0 Meta-Learning =====
        task_logits = None
        new_context = None
        adaptation_strength = None
        
        if use_meta:
            h, task_logits, new_context, adaptation_strength = self.meta_learner(
                h, prev_context, task_type
            )
        
        # ===== 7. 最终融合 =====
        h = self.final_fusion(h)
        
        # ===== 8. 输出 =====
        return {
            # 主要输出
            'direction': self.direction_head(h),
            'emotion': self.emotion_head(h),
            'emotion_intensity': torch.sigmoid(self.emotion_intensity_head(h)),
            'strategy': self.strategy_head(h),
            'tone': self.tone_head(h),
            'use_memory': torch.sigmoid(self.use_memory_head(h)),
            'ask_back': torch.sigmoid(self.ask_back_head(h)),
            'use_emoji': torch.sigmoid(self.use_emoji_head(h)),
            'hidden': h,
            
            # v2.0 输出
            'ponder_cost': ponder_cost,
            'halting_distribution': halting_dist,
            'predicted_depth': torch.sigmoid(self.depth_predictor(h)),
            
            # v3.0 输出
            'new_memory': new_memory,
            'new_read_weights': new_read_weights,
            'new_write_weights': new_write_weights,
            
            # v4.0 输出
            'user_state': user_state,
            'response_effects': response_effects,
            
            # v5.0 输出
            'task_logits': task_logits,
            'new_context': new_context,
            'adaptation_strength': adaptation_strength,
        }


# ==================== Focal Loss ====================

class FocalLoss(nn.Module):
    """Focal Loss - 处理类别不均衡"""
    def __init__(self, alpha=None, gamma=2.0, reduction='mean'):
        super().__init__()
        self.alpha = alpha
        self.gamma = gamma
        self.reduction = reduction
    
    def forward(self, inputs, targets):
        ce_loss = F.cross_entropy(inputs, targets, reduction='none')
        pt = torch.exp(-ce_loss)
        focal_weight = (1 - pt) ** self.gamma
        
        if self.alpha is not None:
            alpha_t = self.alpha[targets]
            focal_loss = alpha_t * focal_weight * ce_loss
        else:
            focal_loss = focal_weight * ce_loss
        
        if self.reduction == 'mean':
            return focal_loss.mean()
        elif self.reduction == 'sum':
            return focal_loss.sum()
        return focal_loss


def get_class_weights():
    """计算类别权重"""
    # 基于训练数据的类别分布
    direction_counts = [6942, 1102, 1034, 844, 78, 1]
    emotion_counts = [1105, 1251, 174, 654, 250, 289, 6158, 119]
    strategy_counts = [7524, 242, 929, 195, 518, 6, 586]
    tone_counts = [7437, 1011, 264, 1061, 186, 41]
    task_counts = [500, 2000, 500, 3000, 500, 500, 500, 2500]  # 估计值
    
    def calc_alpha(counts):
        beta = 0.9999
        effective_num = [1 - beta**c if c > 0 else 1e-8 for c in counts]
        weights = [(1 - beta) / en for en in effective_num]
        total_w = sum(weights)
        return [w / total_w * len(counts) for w in weights]
    
    return {
        'direction': torch.tensor(calc_alpha(direction_counts), dtype=torch.float32),
        'emotion': torch.tensor(calc_alpha(emotion_counts), dtype=torch.float32),
        'strategy': torch.tensor(calc_alpha(strategy_counts), dtype=torch.float32),
        'tone': torch.tensor(calc_alpha(tone_counts), dtype=torch.float32),
        'task': torch.tensor(calc_alpha(task_counts), dtype=torch.float32),
    }


# 全局变量
CLASS_WEIGHTS = None
FOCAL_LOSSES = None

def init_class_weights():
    global CLASS_WEIGHTS, FOCAL_LOSSES
    CLASS_WEIGHTS = get_class_weights()
    for k, v in CLASS_WEIGHTS.items():
        CLASS_WEIGHTS[k] = v.to(DEVICE)
    
    FOCAL_LOSSES = {
        'direction': FocalLoss(alpha=CLASS_WEIGHTS['direction'], gamma=2.0),
        'emotion': FocalLoss(alpha=CLASS_WEIGHTS['emotion'], gamma=2.0),
        'strategy': FocalLoss(alpha=CLASS_WEIGHTS['strategy'], gamma=2.0),
        'tone': FocalLoss(alpha=CLASS_WEIGHTS['tone'], gamma=2.0),
        'task': FocalLoss(alpha=CLASS_WEIGHTS['task'], gamma=2.0),
    }
    
    print(f"[Focal Loss] gamma=2.0, 类别权重已初始化")


# ==================== 训练 ====================

def compute_loss(outputs, batch):
    """计算多任务损失"""
    bce = nn.BCELoss()
    mse = nn.MSELoss()
    
    # 主任务损失 (Focal Loss)
    direction_loss = FOCAL_LOSSES['direction'](outputs['direction'], batch['direction'])
    emotion_loss = FOCAL_LOSSES['emotion'](outputs['emotion'], batch['emotion'])
    strategy_loss = FOCAL_LOSSES['strategy'](outputs['strategy'], batch['strategy'])
    tone_loss = FOCAL_LOSSES['tone'](outputs['tone'], batch['tone'])
    
    # 回归损失
    intensity_loss = mse(outputs['emotion_intensity'].squeeze(), batch['emotion_intensity'])
    
    # 二分类损失
    use_memory_loss = bce(outputs['use_memory'].squeeze(), batch['use_memory'])
    ask_back_loss = bce(outputs['ask_back'].squeeze(), batch['ask_back'])
    use_emoji_loss = bce(outputs['use_emoji'].squeeze(), batch['use_emoji'])
    
    # v2.0: 推理深度损失
    depth_loss = mse(outputs['predicted_depth'].squeeze(), batch['complexity'])
    
    # v2.0: 推理成本惩罚
    ponder_loss = outputs['ponder_cost'].mean() * CONFIG['PONDER_COST']
    
    # v5.0: 任务类型损失
    task_loss = torch.tensor(0.0, device=DEVICE)
    if outputs['task_logits'] is not None:
        task_loss = FOCAL_LOSSES['task'](outputs['task_logits'], batch['task_type'])
    
    # 加权总损失
    total = (
        direction_loss * 1.0 +
        emotion_loss * 0.8 +
        strategy_loss * 1.0 +
        tone_loss * 0.5 +
        intensity_loss * 0.3 +
        use_memory_loss * 0.2 +
        ask_back_loss * 0.2 +
        use_emoji_loss * 0.2 +
        depth_loss * 0.3 +
        ponder_loss +
        task_loss * 0.3  # v5.0
    )
    
    return total, {
        'direction': direction_loss.item(),
        'emotion': emotion_loss.item(),
        'strategy': strategy_loss.item(),
        'tone': tone_loss.item(),
        'ponder': ponder_loss.item(),
        'depth': depth_loss.item(),
        'task': task_loss.item() if isinstance(task_loss, torch.Tensor) else task_loss,
    }


def compute_accuracy(outputs, batch):
    """计算准确率"""
    direction_acc = (outputs['direction'].argmax(dim=1) == batch['direction']).float().mean()
    emotion_acc = (outputs['emotion'].argmax(dim=1) == batch['emotion']).float().mean()
    strategy_acc = (outputs['strategy'].argmax(dim=1) == batch['strategy']).float().mean()
    tone_acc = (outputs['tone'].argmax(dim=1) == batch['tone']).float().mean()
    
    # v5.0: 任务类型准确率
    task_acc = 0.0
    if outputs['task_logits'] is not None:
        task_acc = (outputs['task_logits'].argmax(dim=1) == batch['task_type']).float().mean().item()
    
    avg_ponder = outputs['ponder_cost'].mean().item()
    
    # 适应强度
    adapt_strength = 0.0
    if outputs['adaptation_strength'] is not None:
        adapt_strength = outputs['adaptation_strength'].mean().item()
    
    return {
        'direction': direction_acc.item(),
        'emotion': emotion_acc.item(),
        'strategy': strategy_acc.item(),
        'tone': tone_acc.item(),
        'task': task_acc,
        'overall': (direction_acc + emotion_acc + strategy_acc + tone_acc).item() / 4,
        'avg_ponder': avg_ponder,
        'adapt_strength': adapt_strength,
    }


def train_epoch(model, loader, optimizer, scheduler):
    model.train()
    total_loss = 0
    total_acc = {'direction': 0, 'emotion': 0, 'strategy': 0, 'tone': 0, 'task': 0, 
                 'overall': 0, 'avg_ponder': 0, 'adapt_strength': 0}
    
    for batch in loader:
        batch = {k: v.to(DEVICE) for k, v in batch.items()}
        
        optimizer.zero_grad()
        outputs = model(
            batch['state'], batch['perc'], batch['msg_emb'], batch['mem_emb'],
            task_type=batch['task_type']
        )
        
        loss, _ = compute_loss(outputs, batch)
        loss.backward()
        
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        
        optimizer.step()
        if scheduler:
            scheduler.step()
        
        total_loss += loss.item()
        acc = compute_accuracy(outputs, batch)
        for k in total_acc:
            total_acc[k] += acc[k]
    
    n = len(loader)
    return total_loss / n, {k: v / n for k, v in total_acc.items()}


def evaluate(model, loader):
    model.eval()
    total_loss = 0
    total_acc = {'direction': 0, 'emotion': 0, 'strategy': 0, 'tone': 0, 'task': 0,
                 'overall': 0, 'avg_ponder': 0, 'adapt_strength': 0}
    
    with torch.no_grad():
        for batch in loader:
            batch = {k: v.to(DEVICE) for k, v in batch.items()}
            outputs = model(
                batch['state'], batch['perc'], batch['msg_emb'], batch['mem_emb'],
                task_type=batch['task_type']
            )
            
            loss, _ = compute_loss(outputs, batch)
            total_loss += loss.item()
            
            acc = compute_accuracy(outputs, batch)
            for k in total_acc:
                total_acc[k] += acc[k]
    
    n = len(loader)
    return total_loss / n, {k: v / n for k, v in total_acc.items()}


# ==================== 权重导出 ====================

def export_weights(model, path):
    """导出权重为 JS 可读的 JSON 格式（v5.0 完整版）"""
    weights = {}
    hidden_dim = CONFIG['HIDDEN_DIM']
    reasoning_dim = CONFIG['REASONING_HIDDEN_DIM']
    memory_dim = CONFIG['MEMORY_DIM']
    
    def tensor_to_list(t):
        return t.detach().cpu().numpy().flatten().tolist()
    
    # ===== 输入融合层 =====
    weights['inputFusion'] = {
        'stateProj': {'W': tensor_to_list(model.input_fusion.state_proj.weight), 'b': tensor_to_list(model.input_fusion.state_proj.bias)},
        'percProj': {'W': tensor_to_list(model.input_fusion.perc_proj.weight), 'b': tensor_to_list(model.input_fusion.perc_proj.bias)},
        'msgProj': {'W': tensor_to_list(model.input_fusion.msg_proj.weight), 'b': tensor_to_list(model.input_fusion.msg_proj.bias)},
        'memProj': {'W': tensor_to_list(model.input_fusion.mem_proj.weight), 'b': tensor_to_list(model.input_fusion.mem_proj.bias)},
        'fusionProj': {'W': tensor_to_list(model.input_fusion.fusion.weight), 'b': tensor_to_list(model.input_fusion.fusion.bias)},
    }
    
    # ===== Transformer 层 =====
    weights['transformers'] = []
    for i, block in enumerate(model.transformers):
        block_weights = {
            'attn': {
                'Wq': {'W': tensor_to_list(block.attn.in_proj_weight[:hidden_dim]), 'b': tensor_to_list(block.attn.in_proj_bias[:hidden_dim])},
                'Wk': {'W': tensor_to_list(block.attn.in_proj_weight[hidden_dim:hidden_dim*2]), 'b': tensor_to_list(block.attn.in_proj_bias[hidden_dim:hidden_dim*2])},
                'Wv': {'W': tensor_to_list(block.attn.in_proj_weight[hidden_dim*2:]), 'b': tensor_to_list(block.attn.in_proj_bias[hidden_dim*2:])},
                'Wo': {'W': tensor_to_list(block.attn.out_proj.weight), 'b': tensor_to_list(block.attn.out_proj.bias)},
            },
            'ffn': {
                'fc1': {'W': tensor_to_list(block.ffn[0].weight), 'b': tensor_to_list(block.ffn[0].bias)},
                'fc2': {'W': tensor_to_list(block.ffn[3].weight), 'b': tensor_to_list(block.ffn[3].bias)},
            },
            'ln1': {'gamma': tensor_to_list(block.norm1.weight), 'beta': tensor_to_list(block.norm1.bias)},
            'ln2': {'gamma': tensor_to_list(block.norm2.weight), 'beta': tensor_to_list(block.norm2.bias)},
        }
        weights['transformers'].append(block_weights)
    
    # ===== v2.0: 推理模块 =====
    act = model.act
    rc = act.reasoning_cell
    weights['reasoning'] = {
        'initState': tensor_to_list(act.init_reasoning),
        'cell': {
            'updateGate': {'W': tensor_to_list(rc.update_gate.weight), 'b': tensor_to_list(rc.update_gate.bias)},
            'resetGate': {'W': tensor_to_list(rc.reset_gate.weight), 'b': tensor_to_list(rc.reset_gate.bias)},
            'candidate': {'W': tensor_to_list(rc.candidate.weight), 'b': tensor_to_list(rc.candidate.bias)},
            'haltProj': {'W': tensor_to_list(rc.halt_proj.weight), 'b': tensor_to_list(rc.halt_proj.bias)},
            'reasoningToHidden': {'W': tensor_to_list(rc.reasoning_to_hidden.weight), 'b': tensor_to_list(rc.reasoning_to_hidden.bias)},
            'norm': {'gamma': tensor_to_list(rc.norm.weight), 'beta': tensor_to_list(rc.norm.bias)},
        }
    }
    
    # ===== v3.0: Neural Memory =====
    nm = model.neural_memory
    weights['neuralMemory'] = {
        'initMemory': tensor_to_list(nm.init_memory),
        'initReadWeights': tensor_to_list(nm.init_read_weights),
        'initWriteWeights': tensor_to_list(nm.init_write_weights),
        'readKeyProj': {'W': tensor_to_list(nm.read_key_proj.weight), 'b': tensor_to_list(nm.read_key_proj.bias)},
        'readBetaProj': {'W': tensor_to_list(nm.read_beta_proj.weight), 'b': tensor_to_list(nm.read_beta_proj.bias)},
        'readGateProj': {'W': tensor_to_list(nm.read_gate_proj.weight), 'b': tensor_to_list(nm.read_gate_proj.bias)},
        'readShiftProj': {'W': tensor_to_list(nm.read_shift_proj.weight), 'b': tensor_to_list(nm.read_shift_proj.bias)},
        'writeKeyProj': {'W': tensor_to_list(nm.write_key_proj.weight), 'b': tensor_to_list(nm.write_key_proj.bias)},
        'writeBetaProj': {'W': tensor_to_list(nm.write_beta_proj.weight), 'b': tensor_to_list(nm.write_beta_proj.bias)},
        'writeGateProj': {'W': tensor_to_list(nm.write_gate_proj.weight), 'b': tensor_to_list(nm.write_gate_proj.bias)},
        'writeShiftProj': {'W': tensor_to_list(nm.write_shift_proj.weight), 'b': tensor_to_list(nm.write_shift_proj.bias)},
        'eraseProj': {'W': tensor_to_list(nm.erase_proj.weight), 'b': tensor_to_list(nm.erase_proj.bias)},
        'addProj': {'W': tensor_to_list(nm.add_proj.weight), 'b': tensor_to_list(nm.add_proj.bias)},
        'readOutProj': {'W': tensor_to_list(nm.read_out_proj.weight), 'b': tensor_to_list(nm.read_out_proj.bias)},
    }
    weights['memoryGate'] = {
        'W': tensor_to_list(model.memory_gate[0].weight),
        'b': tensor_to_list(model.memory_gate[0].bias),
    }
    
    # ===== v4.0: World Model =====
    wm = model.world_model
    weights['worldModel'] = {
        'userStateEncoder': {
            'fc1': {'W': tensor_to_list(wm.user_state_encoder[0].weight), 'b': tensor_to_list(wm.user_state_encoder[0].bias)},
            'fc2': {'W': tensor_to_list(wm.user_state_encoder[2].weight), 'b': tensor_to_list(wm.user_state_encoder[2].bias)},
        },
        'userStatePredictor': {
            'fc1': {'W': tensor_to_list(wm.user_state_predictor[0].weight), 'b': tensor_to_list(wm.user_state_predictor[0].bias)},
            'fc2': {'W': tensor_to_list(wm.user_state_predictor[3].weight), 'b': tensor_to_list(wm.user_state_predictor[3].bias)},
        },
        'responseEffectPredictor': {
            'fc1': {'W': tensor_to_list(wm.response_effect_predictor[0].weight), 'b': tensor_to_list(wm.response_effect_predictor[0].bias)},
            'fc2': {'W': tensor_to_list(wm.response_effect_predictor[3].weight), 'b': tensor_to_list(wm.response_effect_predictor[3].bias)},
        },
        'counterfactualEncoder': {
            'fc1': {'W': tensor_to_list(wm.counterfactual_encoder[0].weight), 'b': tensor_to_list(wm.counterfactual_encoder[0].bias)},
            'fc2': {'W': tensor_to_list(wm.counterfactual_encoder[2].weight), 'b': tensor_to_list(wm.counterfactual_encoder[2].bias)},
        },
        'worldToHidden': {'W': tensor_to_list(wm.world_to_hidden.weight), 'b': tensor_to_list(wm.world_to_hidden.bias)},
    }
    weights['worldGate'] = {
        'W': tensor_to_list(model.world_gate[0].weight),
        'b': tensor_to_list(model.world_gate[0].bias),
    }
    
    # ===== v5.0: Meta-Learning =====
    ml = model.meta_learner
    weights['metaLearner'] = {
        'taskEmbeddings': tensor_to_list(ml.task_embeddings.weight),
        'taskEncoder': {
            'fc1': {'W': tensor_to_list(ml.task_encoder[0].weight), 'b': tensor_to_list(ml.task_encoder[0].bias)},
            'fc2': {'W': tensor_to_list(ml.task_encoder[3].weight), 'b': tensor_to_list(ml.task_encoder[3].bias)},
        },
        'fastWeightGenerator': {
            'fc1': {'W': tensor_to_list(ml.fast_weight_generator[0].weight), 'b': tensor_to_list(ml.fast_weight_generator[0].bias)},
            'fc2': {'W': tensor_to_list(ml.fast_weight_generator[3].weight), 'b': tensor_to_list(ml.fast_weight_generator[3].bias)},
        },
        'fastWeightProj': {'W': tensor_to_list(ml.fast_weight_proj.weight), 'b': tensor_to_list(ml.fast_weight_proj.bias)},
        'adaptationGate': {
            'fc1': {'W': tensor_to_list(ml.adaptation_gate[0].weight), 'b': tensor_to_list(ml.adaptation_gate[0].bias)},
            'fc2': {'W': tensor_to_list(ml.adaptation_gate[2].weight), 'b': tensor_to_list(ml.adaptation_gate[2].bias)},
        },
        'contextMemory': {
            'weight_ih': tensor_to_list(ml.context_memory.weight_ih_l0),
            'weight_hh': tensor_to_list(ml.context_memory.weight_hh_l0),
            'bias_ih': tensor_to_list(ml.context_memory.bias_ih_l0),
            'bias_hh': tensor_to_list(ml.context_memory.bias_hh_l0),
        },
        'initContext': tensor_to_list(ml.init_context),
    }
    
    # ===== 输出头 =====
    weights['thinkingHead'] = {
        'directionProj': {'W': tensor_to_list(model.direction_head.weight), 'b': tensor_to_list(model.direction_head.bias)},
        'depthProj': {'W': tensor_to_list(model.depth_predictor.weight), 'b': tensor_to_list(model.depth_predictor.bias)},
    }
    
    weights['emotionHead'] = {
        'primaryTypeProj': {'W': tensor_to_list(model.emotion_head.weight), 'b': tensor_to_list(model.emotion_head.bias)},
        'primaryIntensityProj': {'W': tensor_to_list(model.emotion_intensity_head.weight), 'b': tensor_to_list(model.emotion_intensity_head.bias)},
    }
    
    weights['strategyHead'] = {
        'typeProj': {'W': tensor_to_list(model.strategy_head.weight), 'b': tensor_to_list(model.strategy_head.bias)},
        'toneProj': {'W': tensor_to_list(model.tone_head.weight), 'b': tensor_to_list(model.tone_head.bias)},
        'useMemoryProj': {'W': tensor_to_list(model.use_memory_head.weight), 'b': tensor_to_list(model.use_memory_head.bias)},
        'askBackProj': {'W': tensor_to_list(model.ask_back_head.weight), 'b': tensor_to_list(model.ask_back_head.bias)},
        'useEmojiProj': {'W': tensor_to_list(model.use_emoji_head.weight), 'b': tensor_to_list(model.use_emoji_head.bias)},
    }
    
    weights['finalFusion'] = {
        'fc': {'W': tensor_to_list(model.final_fusion[0].weight), 'b': tensor_to_list(model.final_fusion[0].bias)},
        'ln': {'gamma': tensor_to_list(model.final_fusion[1].weight), 'beta': tensor_to_list(model.final_fusion[1].bias)},
    }
    
    output = {
        'version': 'v5.0-brain-full',
        'timestamp': int(time.time() * 1000),
        'config': {
            **CONFIG,
            'architecture': 'full-brain-v5',
            'features': ['chain-of-thought', 'neural-memory', 'world-model', 'meta-learning'],
        },
        'weights': weights
    }
    
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(output, f)
    
    print(f"✅ v5.0 权重已导出: {path}")


# ==================== 主流程 ====================

def main():
    print("\n" + "=" * 70)
    print("🧠 BrainNN v5.0 PyTorch 训练 - 完整版")
    print("=" * 70)
    print("\n特性：")
    print("  ✓ v2.0 Chain-of-Thought 多步推理")
    print("  ✓ v3.0 Neural Memory 可微分记忆")
    print("  ✓ v4.0 World Model 预测用户反应")
    print("  ✓ v5.0 Meta-Learning 快速适应")
    print("=" * 70 + "\n")
    
    # 加载数据
    print("[数据] 加载训练数据...")
    data_path = Path(CONFIG['DATA_PATH'])
    if not data_path.exists():
        print(f"❌ 数据文件不存在: {data_path}")
        print("   请先运行数据生成脚本")
        sys.exit(1)
    
    with open(data_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    samples = data['samples'] if 'samples' in data else data
    print(f"[数据] 总样本数: {len(samples):,}")
    
    # 划分数据集
    val_size = int(len(samples) * 0.1)
    random.shuffle(samples)
    train_samples = samples[val_size:]
    val_samples = samples[:val_size]
    
    print(f"[数据] 训练集: {len(train_samples):,}, 验证集: {len(val_samples):,}")
    
    train_dataset = BrainDataset(train_samples)
    val_dataset = BrainDataset(val_samples)
    
    train_loader = DataLoader(train_dataset, batch_size=CONFIG['BATCH_SIZE'], shuffle=True, num_workers=0)
    val_loader = DataLoader(val_dataset, batch_size=CONFIG['BATCH_SIZE'], shuffle=False, num_workers=0)
    
    # 初始化类别权重
    init_class_weights()
    
    # 创建模型
    print("\n[模型] 创建 BrainNN v5.0...")
    model = BrainNNv5().to(DEVICE)
    
    # 统计参数量
    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"[模型] 总参数: {total_params:,}")
    print(f"[模型] 可训练参数: {trainable_params:,}")
    
    # 分模块统计
    module_params = {
        'InputFusion': sum(p.numel() for p in model.input_fusion.parameters()),
        'Transformers': sum(p.numel() for p in model.transformers.parameters()),
        'NeuralMemory (v3.0)': sum(p.numel() for p in model.neural_memory.parameters()),
        'ACT (v2.0)': sum(p.numel() for p in model.act.parameters()),
        'WorldModel (v4.0)': sum(p.numel() for p in model.world_model.parameters()),
        'MetaLearner (v5.0)': sum(p.numel() for p in model.meta_learner.parameters()),
    }
    print("\n[模型] 各模块参数量:")
    for name, count in module_params.items():
        print(f"   {name}: {count:,}")
    
    # 优化器
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=CONFIG['LR'],
        weight_decay=CONFIG['WEIGHT_DECAY']
    )
    
    # 学习率调度
    total_steps = len(train_loader) * CONFIG['EPOCHS']
    warmup_steps = CONFIG['WARMUP_STEPS']
    
    def lr_lambda(step):
        if step < warmup_steps:
            return step / warmup_steps
        return CONFIG['LR_DECAY'] ** ((step - warmup_steps) / 1000)
    
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_lambda)
    
    # 训练
    print(f"\n[训练] 开始训练 (共 {CONFIG['EPOCHS']} epochs)...")
    print(f"[训练] Batch Size: {CONFIG['BATCH_SIZE']}, LR: {CONFIG['LR']}")
    print("-" * 70)
    
    best_val_acc = 0
    patience_counter = 0
    
    for epoch in range(CONFIG['EPOCHS']):
        start_time = time.time()
        
        # 训练
        train_loss, train_acc = train_epoch(model, train_loader, optimizer, scheduler)
        
        # 验证
        val_loss, val_acc = evaluate(model, val_loader)
        
        epoch_time = time.time() - start_time
        current_lr = optimizer.param_groups[0]['lr']
        
        # 打印进度
        print(f"Epoch {epoch+1:3d}/{CONFIG['EPOCHS']} | "
              f"Train Loss: {train_loss:.4f} | Val Loss: {val_loss:.4f} | "
              f"Val Acc: {val_acc['overall']*100:.1f}% | "
              f"Ponder: {val_acc['avg_ponder']:.2f} | "
              f"Adapt: {val_acc['adapt_strength']:.3f} | "
              f"LR: {current_lr:.6f} | "
              f"Time: {epoch_time:.1f}s")
        
        # 详细准确率（每10个epoch）
        if (epoch + 1) % 10 == 0:
            print(f"   详细: Dir={val_acc['direction']*100:.1f}% | "
                  f"Emo={val_acc['emotion']*100:.1f}% | "
                  f"Str={val_acc['strategy']*100:.1f}% | "
                  f"Tone={val_acc['tone']*100:.1f}% | "
                  f"Task={val_acc['task']*100:.1f}%")
        
        # 保存最佳模型
        if val_acc['overall'] > best_val_acc:
            best_val_acc = val_acc['overall']
            patience_counter = 0
            
            # 保存 checkpoint
            torch.save({
                'epoch': epoch,
                'model_state_dict': model.state_dict(),
                'optimizer_state_dict': optimizer.state_dict(),
                'val_acc': val_acc,
                'config': CONFIG,
            }, CONFIG['CHECKPOINT_PATH'])
            
            # 导出权重
            export_weights(model, CONFIG['WEIGHTS_PATH'])
            print(f"   ✅ 新最佳! 准确率: {best_val_acc*100:.2f}%")
        else:
            patience_counter += 1
        
        # 早停
        if patience_counter >= CONFIG['PATIENCE']:
            print(f"\n[早停] {CONFIG['PATIENCE']} epochs 无改善，停止训练")
            break
    
    print("\n" + "=" * 70)
    print("🎉 训练完成!")
    print(f"   最佳验证准确率: {best_val_acc*100:.2f}%")
    print(f"   权重已保存到: {CONFIG['WEIGHTS_PATH']}")
    print("=" * 70)


if __name__ == '__main__':
    main()
