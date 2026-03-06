"""
BrainNN v2.0 PyTorch 训练脚本

v2.0 新特性：Chain-of-Thought 多步推理
- 迭代推理循环（最多 N 步）
- 动态推理深度（简单问题少步，复杂问题多步）
- 中间状态可视化
- 自我验证机制

使用 GPU 加速训练，比纯 JS 快 50-100 倍
训练完导出权重给 JS 运行时使用
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

# ==================== 配置 ====================

CONFIG = {
    'STATE_DIM': 27,
    'PERCEPTION_DIM': 8,
    'EMBEDDING_DIM': 1024,
    
    # 网络结构
    'HIDDEN_DIM': 512,
    'NUM_HEADS': 8,
    'NUM_LAYERS': 4,
    'FFN_DIM': 1024,
    
    # v2.0 Chain-of-Thought 配置
    'MAX_REASONING_STEPS': 5,      # 最大推理步数
    'MIN_REASONING_STEPS': 1,      # 最小推理步数
    'REASONING_HIDDEN_DIM': 256,   # 推理状态维度
    'HALT_THRESHOLD': 0.8,         # 停止推理的置信度阈值
    
    # 输出维度
    'NUM_DIRECTIONS': 6,
    'NUM_EMOTIONS': 8,
    'NUM_STRATEGIES': 7,
    'NUM_TONES': 6,
    
    # 训练参数 - 长时间最佳效果训练
    'BATCH_SIZE': 32,           # 小 batch 更好泛化
    'EPOCHS': 200,              # 长时间训练
    'LR': 0.0005,               # 稳定学习率
    'LR_DECAY': 0.95,
    'WEIGHT_DECAY': 1e-5,       # 轻微正则化
    'WARMUP_STEPS': 500,        # 更长预热
    'PONDER_COST': 0.005,       # 降低推理惩罚，让模型学会多步推理
    'PATIENCE': 30,             # 早停耐心值
    
    # 路径
    'DATA_PATH': 'data/training/brain-training-data-merged.json',  # 合并数据
    'WEIGHTS_PATH': 'data/models/brain-nn-weights.json',
    'CHECKPOINT_PATH': 'data/models/brain-nn-checkpoint.pt',
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
        
        # v2.0: 复杂度估计（用于动态推理深度）
        complexity = self._estimate_complexity(s)
        
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
        }
    
    def _pad(self, arr, length):
        if arr is None:
            return [0.0] * length
        if len(arr) >= length:
            return arr[:length]
        return arr + [0.0] * (length - len(arr))
    
    def _estimate_complexity(self, sample) -> float:
        """估计样本复杂度 (0-1)，用于动态推理深度"""
        complexity = 0.3  # 基础复杂度
        
        target = sample.get('target', {})
        
        # 需要记忆的更复杂
        if target.get('useMemory', False):
            complexity += 0.2
        
        # 需要反问的更复杂
        if target.get('askBack', False):
            complexity += 0.15
        
        # 某些策略更复杂
        complex_strategies = ['share_experience', 'empathize', 'ask_back']
        if target.get('strategyType') in complex_strategies:
            complexity += 0.15
        
        # 某些方向更复杂
        complex_directions = ['recall', 'share']
        if target.get('direction') in complex_directions:
            complexity += 0.1
        
        return min(1.0, complexity)


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
    
    def forward(self, state, perc, msg_emb, mem_emb):
        h1 = F.gelu(self.state_proj(state))
        h2 = F.gelu(self.perc_proj(perc))
        h3 = F.gelu(self.msg_proj(msg_emb))
        h4 = F.gelu(self.mem_proj(mem_emb))
        concat = torch.cat([h1, h2, h3, h4], dim=-1)
        return self.norm(self.fusion(concat))


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
        # x: [batch, hidden_dim] -> [batch, 1, hidden_dim] for attention
        x_seq = x.unsqueeze(1)
        attn_out, _ = self.attn(x_seq, x_seq, x_seq)
        x = self.norm1(x + self.dropout(attn_out.squeeze(1)))
        x = self.norm2(x + self.ffn(x))
        return x


class ReasoningCell(nn.Module):
    """
    v2.0 推理单元 - Chain-of-Thought 的核心
    
    每一步推理：
    1. 接收当前隐藏状态 + 推理状态
    2. 更新推理状态（思考）
    3. 输出停止概率（是否继续推理）
    """
    def __init__(self, hidden_dim, reasoning_dim):
        super().__init__()
        self.hidden_dim = hidden_dim
        self.reasoning_dim = reasoning_dim
        
        # 推理状态更新（类似 GRU）
        self.update_gate = nn.Linear(hidden_dim + reasoning_dim, reasoning_dim)
        self.reset_gate = nn.Linear(hidden_dim + reasoning_dim, reasoning_dim)
        self.candidate = nn.Linear(hidden_dim + reasoning_dim, reasoning_dim)
        
        # 停止概率预测
        self.halt_proj = nn.Linear(reasoning_dim, 1)
        
        # 推理状态到隐藏状态的投影
        self.reasoning_to_hidden = nn.Linear(reasoning_dim, hidden_dim)
        
        self.norm = nn.LayerNorm(reasoning_dim)
    
    def forward(self, hidden: torch.Tensor, reasoning_state: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Args:
            hidden: [batch, hidden_dim] - 当前隐藏状态
            reasoning_state: [batch, reasoning_dim] - 当前推理状态
        
        Returns:
            new_reasoning_state: [batch, reasoning_dim] - 更新后的推理状态
            halt_prob: [batch, 1] - 停止推理的概率
            reasoning_contribution: [batch, hidden_dim] - 推理对隐藏状态的贡献
        """
        combined = torch.cat([hidden, reasoning_state], dim=-1)
        
        # GRU 风格的更新
        z = torch.sigmoid(self.update_gate(combined))
        r = torch.sigmoid(self.reset_gate(combined))
        
        combined_reset = torch.cat([hidden, r * reasoning_state], dim=-1)
        candidate = torch.tanh(self.candidate(combined_reset))
        
        new_reasoning_state = (1 - z) * reasoning_state + z * candidate
        new_reasoning_state = self.norm(new_reasoning_state)
        
        # 停止概率
        halt_prob = torch.sigmoid(self.halt_proj(new_reasoning_state))
        
        # 推理贡献
        reasoning_contribution = self.reasoning_to_hidden(new_reasoning_state)
        
        return new_reasoning_state, halt_prob, reasoning_contribution


class AdaptiveComputationTime(nn.Module):
    """
    v2.0 自适应计算时间 (ACT)
    
    动态决定推理步数：
    - 简单问题：1-2 步
    - 复杂问题：3-5 步
    - 累积停止概率达到阈值时停止
    """
    def __init__(self, hidden_dim, reasoning_dim, max_steps):
        super().__init__()
        self.max_steps = max_steps
        self.reasoning_cell = ReasoningCell(hidden_dim, reasoning_dim)
        
        # 初始推理状态
        self.init_reasoning = nn.Parameter(torch.zeros(reasoning_dim))
    
    def forward(self, hidden: torch.Tensor, threshold: float = 0.8) -> Tuple[torch.Tensor, List[torch.Tensor], torch.Tensor, torch.Tensor]:
        """
        Args:
            hidden: [batch, hidden_dim] - 初始隐藏状态
            threshold: 停止阈值
        
        Returns:
            final_hidden: [batch, hidden_dim] - 最终隐藏状态（加权平均）
            reasoning_steps: List[Tensor] - 每步的推理状态（用于可视化）
            ponder_cost: [batch] - 推理步数（用于损失）
            halting_distribution: [batch, max_steps] - 每步的停止概率分布
        """
        batch_size = hidden.size(0)
        device = hidden.device
        
        # 初始化
        reasoning_state = self.init_reasoning.unsqueeze(0).expand(batch_size, -1)
        
        # 累积变量
        accumulated_hidden = torch.zeros_like(hidden)
        accumulated_halt = torch.zeros(batch_size, 1, device=device)
        remainder = torch.ones(batch_size, 1, device=device)
        
        reasoning_steps = []
        halt_probs = []
        n_updates = torch.zeros(batch_size, 1, device=device)
        
        for step in range(self.max_steps):
            # 推理一步
            reasoning_state, halt_prob, reasoning_contribution = self.reasoning_cell(hidden, reasoning_state)
            reasoning_steps.append(reasoning_state.clone())
            
            # 更新隐藏状态
            hidden = hidden + reasoning_contribution * 0.1  # 残差连接
            
            # 计算这一步的权重
            still_running = (accumulated_halt < threshold).float()
            
            # 最后一步：使用剩余概率
            if step == self.max_steps - 1:
                halt_weight = remainder
            else:
                halt_weight = halt_prob * still_running
            
            halt_probs.append(halt_weight.squeeze(-1))
            
            # 累积
            accumulated_hidden = accumulated_hidden + halt_weight * hidden
            accumulated_halt = accumulated_halt + halt_weight
            remainder = remainder - halt_weight
            n_updates = n_updates + still_running
        
        # 归一化
        final_hidden = accumulated_hidden / (accumulated_halt + 1e-8)
        ponder_cost = n_updates.squeeze(-1)
        halting_distribution = torch.stack(halt_probs, dim=1)  # [batch, max_steps]
        
        return final_hidden, reasoning_steps, ponder_cost, halting_distribution


# ==================== BrainNN v2.0 主模型 ====================

class BrainNNv2(nn.Module):
    """
    BrainNN v2.0 - Chain-of-Thought 多步推理
    
    架构：
    1. 输入融合层
    2. Transformer 编码器
    3. 自适应推理模块 (ACT) - v2.0 新增
    4. 多任务输出头
    
    推理过程：
    - 不是一次前向传播，而是迭代思考
    - 每步推理更新内部状态
    - 动态决定何时停止
    """
    def __init__(self):
        super().__init__()
        hidden_dim = CONFIG['HIDDEN_DIM']
        reasoning_dim = CONFIG['REASONING_HIDDEN_DIM']
        
        # 输入融合
        self.input_fusion = InputFusion(hidden_dim, CONFIG['EMBEDDING_DIM'])
        
        # Transformer 层
        self.transformers = nn.ModuleList([
            TransformerBlock(hidden_dim, CONFIG['NUM_HEADS'], CONFIG['FFN_DIM'])
            for _ in range(CONFIG['NUM_LAYERS'])
        ])
        
        # v2.0: 自适应推理模块
        self.act = AdaptiveComputationTime(
            hidden_dim, 
            reasoning_dim, 
            CONFIG['MAX_REASONING_STEPS']
        )
        
        # 输出头
        self.direction_head = nn.Linear(hidden_dim, CONFIG['NUM_DIRECTIONS'])
        self.emotion_head = nn.Linear(hidden_dim, CONFIG['NUM_EMOTIONS'])
        self.emotion_intensity_head = nn.Linear(hidden_dim, 1)
        self.strategy_head = nn.Linear(hidden_dim, CONFIG['NUM_STRATEGIES'])
        self.tone_head = nn.Linear(hidden_dim, CONFIG['NUM_TONES'])
        self.use_memory_head = nn.Linear(hidden_dim, 1)
        self.ask_back_head = nn.Linear(hidden_dim, 1)
        self.use_emoji_head = nn.Linear(hidden_dim, 1)
        
        # v2.0: 推理深度预测（用于监督学习）
        self.depth_predictor = nn.Linear(hidden_dim, 1)
    
    def forward(self, state, perc, msg_emb, mem_emb, use_act=True):
        """
        Args:
            use_act: 是否使用自适应推理（训练时 True，快速推理时可设为 False）
        """
        # 输入融合
        h = self.input_fusion(state, perc, msg_emb, mem_emb)
        
        # Transformer 编码
        for block in self.transformers:
            h = block(h)
        
        # v2.0: 自适应推理
        reasoning_steps = []
        ponder_cost = torch.zeros(h.size(0), device=h.device)
        halting_dist = None
        
        if use_act:
            h, reasoning_steps, ponder_cost, halting_dist = self.act(
                h, threshold=CONFIG['HALT_THRESHOLD']
            )
        
        # 输出
        return {
            'direction': self.direction_head(h),
            'emotion': self.emotion_head(h),
            'emotion_intensity': torch.sigmoid(self.emotion_intensity_head(h)),
            'strategy': self.strategy_head(h),
            'tone': self.tone_head(h),
            'use_memory': torch.sigmoid(self.use_memory_head(h)),
            'ask_back': torch.sigmoid(self.ask_back_head(h)),
            'use_emoji': torch.sigmoid(self.use_emoji_head(h)),
            'hidden': h,
            # v2.0 新增
            'reasoning_steps': reasoning_steps,
            'ponder_cost': ponder_cost,
            'halting_distribution': halting_dist,
            'predicted_depth': torch.sigmoid(self.depth_predictor(h)),
        }


# ==================== Focal Loss（处理极度不均衡数据）====================

class FocalLoss(nn.Module):
    """
    Focal Loss - 专门处理类别不均衡问题
    
    对于容易分类的样本（高置信度），降低其损失权重
    对于难分类的样本（低置信度），保持或增加其损失权重
    
    FL(p_t) = -alpha * (1 - p_t)^gamma * log(p_t)
    """
    def __init__(self, alpha=None, gamma=2.0, reduction='mean'):
        super().__init__()
        self.alpha = alpha  # 类别权重
        self.gamma = gamma  # 聚焦参数，越大越关注难样本
        self.reduction = reduction
    
    def forward(self, inputs, targets):
        ce_loss = F.cross_entropy(inputs, targets, reduction='none')
        pt = torch.exp(-ce_loss)  # p_t = softmax probability of correct class
        
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
    total = 10000
    
    # direction: answer=0, question=1, share=2, react=3, recall=4, ignore=5
    direction_counts = [6942, 1102, 1034, 844, 78, 1]
    # emotion: joy=0, curiosity=1, empathy=2, surprise=3, concern=4, playful=5, calm=6, annoyed=7
    emotion_counts = [1105, 1251, 174, 654, 250, 289, 6158, 119]
    # strategy: direct_answer=0, share_experience=1, ask_back=2, empathize=3, joke=4, deflect=5, silent=6
    strategy_counts = [7524, 242, 929, 195, 518, 6, 586]
    # tone: warm=0, playful=1, serious=2, curious=3, supportive=4, teasing=5
    tone_counts = [7437, 1011, 264, 1061, 186, 41]
    
    def calc_alpha(counts):
        # 使用 effective number of samples 方法
        beta = 0.9999
        effective_num = [1 - beta**c if c > 0 else 1e-8 for c in counts]
        weights = [(1 - beta) / en for en in effective_num]
        # 归一化
        total_w = sum(weights)
        return [w / total_w * len(counts) for w in weights]
    
    return {
        'direction': torch.tensor(calc_alpha(direction_counts), dtype=torch.float32),
        'emotion': torch.tensor(calc_alpha(emotion_counts), dtype=torch.float32),
        'strategy': torch.tensor(calc_alpha(strategy_counts), dtype=torch.float32),
        'tone': torch.tensor(calc_alpha(tone_counts), dtype=torch.float32),
    }

# 全局
CLASS_WEIGHTS = None
FOCAL_LOSSES = None

def init_class_weights():
    global CLASS_WEIGHTS, FOCAL_LOSSES
    CLASS_WEIGHTS = get_class_weights()
    for k, v in CLASS_WEIGHTS.items():
        CLASS_WEIGHTS[k] = v.to(DEVICE)
    
    # 创建 Focal Loss 实例
    FOCAL_LOSSES = {
        'direction': FocalLoss(alpha=CLASS_WEIGHTS['direction'], gamma=2.0),
        'emotion': FocalLoss(alpha=CLASS_WEIGHTS['emotion'], gamma=2.0),
        'strategy': FocalLoss(alpha=CLASS_WEIGHTS['strategy'], gamma=2.0),
        'tone': FocalLoss(alpha=CLASS_WEIGHTS['tone'], gamma=2.0),
    }
    
    print(f"[Focal Loss] gamma=2.0, 类别权重已初始化")


# ==================== 训练 ====================

def compute_loss(outputs, batch):
    """计算多任务损失 - 使用 Focal Loss 处理不均衡"""
    bce = nn.BCELoss()
    mse = nn.MSELoss()
    
    # 使用 Focal Loss（自动处理难样本）
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
    
    # v2.0: 推理深度损失（鼓励模型学习预测合适的推理深度）
    depth_loss = mse(outputs['predicted_depth'].squeeze(), batch['complexity'])
    
    # v2.0: 推理成本惩罚（鼓励高效推理）
    ponder_loss = outputs['ponder_cost'].mean() * CONFIG['PONDER_COST']
    
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
        depth_loss * 0.3 +      # v2.0
        ponder_loss             # v2.0
    )
    
    return total, {
        'direction': direction_loss.item(),
        'emotion': emotion_loss.item(),
        'strategy': strategy_loss.item(),
        'tone': tone_loss.item(),
        'ponder': ponder_loss.item(),
        'depth': depth_loss.item(),
    }


def compute_accuracy(outputs, batch):
    """计算准确率"""
    direction_acc = (outputs['direction'].argmax(dim=1) == batch['direction']).float().mean()
    emotion_acc = (outputs['emotion'].argmax(dim=1) == batch['emotion']).float().mean()
    strategy_acc = (outputs['strategy'].argmax(dim=1) == batch['strategy']).float().mean()
    tone_acc = (outputs['tone'].argmax(dim=1) == batch['tone']).float().mean()
    
    # v2.0: 平均推理步数
    avg_ponder = outputs['ponder_cost'].mean().item()
    
    return {
        'direction': direction_acc.item(),
        'emotion': emotion_acc.item(),
        'strategy': strategy_acc.item(),
        'tone': tone_acc.item(),
        'overall': (direction_acc + emotion_acc + strategy_acc + tone_acc).item() / 4,
        'avg_ponder': avg_ponder,
    }


def train_epoch(model, loader, optimizer, scheduler):
    model.train()
    total_loss = 0
    total_acc = {'direction': 0, 'emotion': 0, 'strategy': 0, 'tone': 0, 'overall': 0, 'avg_ponder': 0}
    
    for batch in loader:
        # 移到 GPU
        batch = {k: v.to(DEVICE) for k, v in batch.items()}
        
        optimizer.zero_grad()
        outputs = model(batch['state'], batch['perc'], batch['msg_emb'], batch['mem_emb'])
        
        loss, _ = compute_loss(outputs, batch)
        loss.backward()
        
        # 梯度裁剪
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
    total_acc = {'direction': 0, 'emotion': 0, 'strategy': 0, 'tone': 0, 'overall': 0, 'avg_ponder': 0}
    
    with torch.no_grad():
        for batch in loader:
            batch = {k: v.to(DEVICE) for k, v in batch.items()}
            outputs = model(batch['state'], batch['perc'], batch['msg_emb'], batch['mem_emb'])
            
            loss, _ = compute_loss(outputs, batch)
            total_loss += loss.item()
            
            acc = compute_accuracy(outputs, batch)
            for k in total_acc:
                total_acc[k] += acc[k]
    
    n = len(loader)
    return total_loss / n, {k: v / n for k, v in total_acc.items()}


# ==================== 权重导出 ====================

def export_weights(model, path):
    """导出权重为 JS 可读的 JSON 格式（v2.0 兼容）"""
    weights = {}
    hidden_dim = CONFIG['HIDDEN_DIM']
    reasoning_dim = CONFIG['REASONING_HIDDEN_DIM']
    
    def tensor_to_list(t):
        return t.detach().cpu().numpy().flatten().tolist()
    
    # 输入融合层
    weights['inputFusion'] = {
        'stateProj': {'W': tensor_to_list(model.input_fusion.state_proj.weight), 'b': tensor_to_list(model.input_fusion.state_proj.bias)},
        'percProj': {'W': tensor_to_list(model.input_fusion.perc_proj.weight), 'b': tensor_to_list(model.input_fusion.perc_proj.bias)},
        'msgProj': {'W': tensor_to_list(model.input_fusion.msg_proj.weight), 'b': tensor_to_list(model.input_fusion.msg_proj.bias)},
        'memProj': {'W': tensor_to_list(model.input_fusion.mem_proj.weight), 'b': tensor_to_list(model.input_fusion.mem_proj.bias)},
        'fusionProj': {'W': tensor_to_list(model.input_fusion.fusion.weight), 'b': tensor_to_list(model.input_fusion.fusion.bias)},
    }
    
    # Transformer 层
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
    
    # v2.0: 推理模块权重
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
    
    # 输出头
    weights['thinkingHead'] = {
        'directionProj': {'W': tensor_to_list(model.direction_head.weight), 'b': tensor_to_list(model.direction_head.bias)},
        'topicProj': {'W': tensor_to_list(model.direction_head.weight), 'b': tensor_to_list(model.direction_head.bias)},
        'keywordProj': {'W': tensor_to_list(model.direction_head.weight), 'b': tensor_to_list(model.direction_head.bias)},
        'depthProj': {'W': tensor_to_list(model.depth_predictor.weight), 'b': tensor_to_list(model.depth_predictor.bias)},
    }
    
    weights['emotionHead'] = {
        'primaryTypeProj': {'W': tensor_to_list(model.emotion_head.weight), 'b': tensor_to_list(model.emotion_head.bias)},
        'primaryIntensityProj': {'W': tensor_to_list(model.emotion_intensity_head.weight), 'b': tensor_to_list(model.emotion_intensity_head.bias)},
        'secondaryTypeProj': {'W': tensor_to_list(model.emotion_head.weight), 'b': tensor_to_list(model.emotion_head.bias)},
        'secondaryIntensityProj': {'W': tensor_to_list(model.emotion_intensity_head.weight), 'b': tensor_to_list(model.emotion_intensity_head.bias)},
        'trendProj': {'W': [0.0] * hidden_dim * 3, 'b': [0.0, 1.0, 0.0]},
        'expressProj': {'W': [0.0] * hidden_dim, 'b': [0.0]},
    }
    
    weights['strategyHead'] = {
        'typeProj': {'W': tensor_to_list(model.strategy_head.weight), 'b': tensor_to_list(model.strategy_head.bias)},
        'toneProj': {'W': tensor_to_list(model.tone_head.weight), 'b': tensor_to_list(model.tone_head.bias)},
        'lengthProj': {'W': [0.0] * hidden_dim, 'b': [0.0]},
        'useMemoryProj': {'W': tensor_to_list(model.use_memory_head.weight), 'b': tensor_to_list(model.use_memory_head.bias)},
        'askBackProj': {'W': tensor_to_list(model.ask_back_head.weight), 'b': tensor_to_list(model.ask_back_head.bias)},
        'useEmojiProj': {'W': tensor_to_list(model.use_emoji_head.weight), 'b': tensor_to_list(model.use_emoji_head.bias)},
        'openingProj': {'W': [0.0] * hidden_dim * 5, 'b': [0.0, 1.0, 0.0, 0.0, 0.0]},
        'closingProj': {'W': [0.0] * hidden_dim * 5, 'b': [0.0, 1.0, 0.0, 0.0, 0.0]},
        'keyPointsProj': {'W': [0.0] * hidden_dim * 64, 'b': [0.0] * 64},
    }
    
    weights['memoryHead'] = {
        'typeProj': {'W': [0.0] * hidden_dim * 6, 'b': [0.0] * 6},
        'strengthProj': {'W': [0.0] * hidden_dim * 5, 'b': [0.5] * 5},
        'reasonProj': {'W': [0.0] * hidden_dim * 5, 'b': [1.0, 0.0, 0.0, 0.0, 0.0]},
        'mentionProj': {'W': [0.0] * hidden_dim * 5, 'b': [0.0] * 5},
        'countProj': {'W': [0.0] * hidden_dim, 'b': [0.0]},
    }
    
    output = {
        'version': 'v2.0-brain-cot',
        'timestamp': int(time.time() * 1000),
        'config': {
            **CONFIG,
            'architecture': 'chain-of-thought',
        },
        'weights': weights
    }
    
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(output, f)
    
    print(f"✅ 权重已导出: {path}")


# ==================== 主流程 ====================

def main():
    print("\n" + "=" * 60)
    print("🧠 BrainNN v2.0 PyTorch 训练 (Chain-of-Thought)")
    print("=" * 60 + "\n")
    
    # 加载数据
    print("[数据] 加载训练数据...")
    data_path = Path(CONFIG['DATA_PATH'])
    if not data_path.exists():
        print(f"❌ 数据文件不存在: {data_path}")
        print("   请先运行: npm run train:brain-data")
        sys.exit(1)
    
    with open(data_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    samples = data['samples'] if 'samples' in data else data
    print(f"[数据] 总样本数: {len(samples):,}")
    
    # 划分数据集
    val_size = int(len(samples) * 0.15)
    train_samples = samples[val_size:]
    val_samples = samples[:val_size]
    
    print(f"[数据] 训练集: {len(train_samples):,}")
    print(f"[数据] 验证集: {len(val_samples):,}")
    
    train_dataset = BrainDataset(train_samples)
    val_dataset = BrainDataset(val_samples)
    
    train_loader = DataLoader(train_dataset, batch_size=CONFIG['BATCH_SIZE'], shuffle=True, num_workers=0, pin_memory=True)
    val_loader = DataLoader(val_dataset, batch_size=CONFIG['BATCH_SIZE'], shuffle=False, num_workers=0, pin_memory=True)
    
    # 创建模型
    print("\n[模型] 初始化 BrainNN v2.0...")
    model = BrainNNv2().to(DEVICE)
    
    # 初始化类别权重（处理不均衡数据）
    init_class_weights()
    
    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"[模型] 总参数: {total_params:,}")
    print(f"[模型] 可训练参数: {trainable_params:,}")
    print(f"[模型] 最大推理步数: {CONFIG['MAX_REASONING_STEPS']}")
    print(f"[模型] 推理状态维度: {CONFIG['REASONING_HIDDEN_DIM']}")
    
    # 优化器
    optimizer = torch.optim.AdamW(model.parameters(), lr=CONFIG['LR'], weight_decay=CONFIG['WEIGHT_DECAY'])
    
    # 学习率调度 - Cosine with Warmup + Restarts
    total_steps = len(train_loader) * CONFIG['EPOCHS']
    warmup_steps = CONFIG['WARMUP_STEPS']
    
    def lr_lambda(step):
        if step < warmup_steps:
            return step / warmup_steps
        # Cosine annealing with warm restarts every 50 epochs
        progress = (step - warmup_steps) / (total_steps - warmup_steps)
        return 0.5 * (1 + math.cos(math.pi * progress))
    
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_lambda)
    
    # 训练前评估
    print("\n[评估] 训练前...")
    val_loss, val_acc = evaluate(model, val_loader)
    print(f"  损失: {val_loss:.4f}")
    print(f"  准确率: 方向={val_acc['direction']*100:.1f}% 情绪={val_acc['emotion']*100:.1f}% 策略={val_acc['strategy']*100:.1f}% 语气={val_acc['tone']*100:.1f}%")
    print(f"  总体: {val_acc['overall']*100:.1f}%")
    print(f"  平均推理步数: {val_acc['avg_ponder']:.2f}")
    
    # 训练
    print(f"\n[训练] 开始 epochs={CONFIG['EPOCHS']} batch={CONFIG['BATCH_SIZE']} lr={CONFIG['LR']}")
    print(f"[训练] 早停耐心值: {CONFIG['PATIENCE']} epochs")
    
    best_acc = val_acc['overall']
    best_epoch = 0
    no_improve_count = 0
    
    for epoch in range(1, CONFIG['EPOCHS'] + 1):
        start_time = time.time()
        
        train_loss, train_acc = train_epoch(model, train_loader, optimizer, scheduler)
        val_loss, val_acc = evaluate(model, val_loader)
        
        elapsed = time.time() - start_time
        lr = optimizer.param_groups[0]['lr']
        
        # 详细日志每10轮输出一次
        if epoch % 10 == 0 or epoch <= 5:
            print(f"[Epoch {epoch:3d}/{CONFIG['EPOCHS']}] "
                  f"train_loss={train_loss:.4f} val_loss={val_loss:.4f} "
                  f"val_acc={val_acc['overall']*100:.1f}% "
                  f"(dir={val_acc['direction']*100:.0f}% emo={val_acc['emotion']*100:.0f}% str={val_acc['strategy']*100:.0f}% tone={val_acc['tone']*100:.0f}%) "
                  f"ponder={val_acc['avg_ponder']:.2f} "
                  f"lr={lr:.6f} "
                  f"time={elapsed:.1f}s")
        else:
            print(f"[Epoch {epoch:3d}/{CONFIG['EPOCHS']}] "
                  f"val_acc={val_acc['overall']*100:.1f}% "
                  f"ponder={val_acc['avg_ponder']:.2f} "
                  f"time={elapsed:.1f}s", end='')
        
        # 保存最佳模型
        if val_acc['overall'] > best_acc + 0.001:  # 至少提升 0.1%
            best_acc = val_acc['overall']
            best_epoch = epoch
            no_improve_count = 0
            torch.save({
                'epoch': epoch,
                'model_state_dict': model.state_dict(),
                'optimizer_state_dict': optimizer.state_dict(),
                'val_acc': val_acc,
                'val_loss': val_loss,
                'config': CONFIG,
            }, CONFIG['CHECKPOINT_PATH'])
            if epoch % 10 != 0 and epoch > 5:
                print(f" 💾 新最佳 {best_acc*100:.1f}%")
            else:
                print(f"  💾 保存最佳模型 (acc={best_acc*100:.1f}%)")
        else:
            no_improve_count += 1
            if epoch % 10 != 0 and epoch > 5:
                print()
            
            # 早停检查
            if no_improve_count >= CONFIG['PATIENCE']:
                print(f"\n[早停] {CONFIG['PATIENCE']} epochs 无提升，停止训练")
                break
    
    # 加载最佳模型
    print(f"\n[完成] 最佳 epoch: {best_epoch}, 准确率: {best_acc*100:.1f}%")
    
    checkpoint = torch.load(CONFIG['CHECKPOINT_PATH'])
    model.load_state_dict(checkpoint['model_state_dict'])
    
    # 最终评估
    print("\n[评估] 最终结果...")
    val_loss, val_acc = evaluate(model, val_loader)
    print(f"  损失: {val_loss:.4f}")
    print(f"  准确率: 方向={val_acc['direction']*100:.1f}% 情绪={val_acc['emotion']*100:.1f}% 策略={val_acc['strategy']*100:.1f}% 语气={val_acc['tone']*100:.1f}%")
    print(f"  总体: {val_acc['overall']*100:.1f}%")
    print(f"  平均推理步数: {val_acc['avg_ponder']:.2f}")
    
    # 导出权重
    print("\n[导出] 导出权重为 JSON...")
    os.makedirs(os.path.dirname(CONFIG['WEIGHTS_PATH']), exist_ok=True)
    export_weights(model, CONFIG['WEIGHTS_PATH'])
    
    print("\n" + "=" * 60)
    print("✅ BrainNN v2.0 训练完成！")
    print("   - Chain-of-Thought 多步推理已启用")
    print("   - 权重已导出，可被 JS 运行时加载")
    print("=" * 60 + "\n")


if __name__ == '__main__':
    main()
