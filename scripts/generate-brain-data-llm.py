"""
BrainNN 训练数据生成 - LLM 智能标注版

使用 GLM-4 对 LCCC 对话数据进行智能标注
生成高质量、标签均衡的训练数据
"""

import json
import os
import sys
import time
import random
import asyncio
import aiohttp
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from collections import Counter

# ==================== 配置 ====================

# API 配置（多个免费接口轮询）
API_CONFIGS = [
    {
        'name': 'siliconflow',
        'url': 'https://api.siliconflow.cn/v1/chat/completions',
        'key': 'sk-wjziyhbaktockvshknswwwomzqkwnrinrqwlkhcuttbytfnh',
        'model': 'Qwen/Qwen3-8B',
    },
    {
        'name': 'aiping',
        'url': 'https://aiping.cn/api/v1/chat/completions',
        'key': 'QC-4ac6a96c9e5078222f1c066fb67892ad-abffe173d55547eab2c2c9b0dc1e26b1',
        'model': 'glm-4.7',
    },
]

# 标签定义
DIRECTIONS = ['answer', 'question', 'share', 'react', 'recall', 'ignore']
EMOTIONS = ['joy', 'curiosity', 'empathy', 'surprise', 'concern', 'playful', 'calm', 'annoyed']
STRATEGIES = ['direct_answer', 'share_experience', 'ask_back', 'empathize', 'joke', 'deflect', 'silent']
TONES = ['warm', 'playful', 'serious', 'curious', 'supportive', 'teasing']

# 目标分布（更均衡）
TARGET_DISTRIBUTION = {
    'direction': {'answer': 0.25, 'question': 0.15, 'share': 0.20, 'react': 0.25, 'recall': 0.10, 'ignore': 0.05},
    'emotion': {'joy': 0.15, 'curiosity': 0.15, 'empathy': 0.12, 'surprise': 0.12, 'concern': 0.12, 'playful': 0.12, 'calm': 0.12, 'annoyed': 0.10},
    'strategy': {'direct_answer': 0.20, 'share_experience': 0.15, 'ask_back': 0.15, 'empathize': 0.15, 'joke': 0.15, 'deflect': 0.10, 'silent': 0.10},
    'tone': {'warm': 0.20, 'playful': 0.20, 'serious': 0.15, 'curious': 0.20, 'supportive': 0.15, 'teasing': 0.10},
}

# 生成配置
CONFIG = {
    'total_samples': 3000,      # 生成3000个样本
    'batch_size': 30,           # 每批处理数量
    'concurrency': 30,          # 并发数
    'max_retries': 3,           # 最大重试次数
    'request_delay': 0.05,      # 请求间隔（秒）
    'output_path': 'data/training/brain-training-data-llm.json',
    'lccc_path': '.cache/LCCC-base-split/LCCC-base_train.json',
}


# ==================== LLM 标注 Prompt ====================

LABELING_PROMPT = '''你是一个对话分析专家。分析以下对话，为AI虚拟主播的回复决策提供标签。

对话上下文：
{context}

当前用户消息：
{user_message}

AI的回复：
{ai_response}

请分析这个对话场景，输出以下标签（JSON格式）：

1. direction（回复方向）: answer/question/share/react/recall/ignore
2. emotion（情绪）: joy/curiosity/empathy/surprise/concern/playful/calm/annoyed
3. emotion_intensity（情绪强度）: 0.0-1.0
4. strategy（策略）: direct_answer/share_experience/ask_back/empathize/joke/deflect/silent
5. tone（语气）: warm/playful/serious/curious/supportive/teasing
6. use_memory: true/false
7. ask_back: true/false
8. use_emoji: true/false

只输出一行JSON，不要其他内容。'''


# ==================== API 调用 ====================

class APIClient:
    def __init__(self):
        self.api_index = 0
        self.request_count = 0
        self.error_count = Counter()
    
    def get_next_api(self) -> dict:
        """轮询获取下一个 API"""
        api = API_CONFIGS[self.api_index]
        self.api_index = (self.api_index + 1) % len(API_CONFIGS)
        return api
    
    async def call_llm(self, session: aiohttp.ClientSession, prompt: str) -> Optional[str]:
        """调用 LLM API"""
        for retry in range(CONFIG['max_retries']):
            api = self.get_next_api()
            
            try:
                headers = {
                    'Content-Type': 'application/json',
                    'Authorization': f"Bearer {api['key']}"
                }
                
                payload = {
                    'model': api['model'],
                    'messages': [{'role': 'user', 'content': prompt}],
                    'temperature': 0.3,
                    'max_tokens': 500,
                }
                
                async with session.post(api['url'], headers=headers, json=payload, timeout=30) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        content = data['choices'][0]['message']['content']
                        self.request_count += 1
                        return content
                    else:
                        self.error_count[f"{api['name']}_{resp.status}"] += 1
                        if retry < CONFIG['max_retries'] - 1:
                            await asyncio.sleep(1)
                            
            except Exception as e:
                self.error_count[f"{api['name']}_error"] += 1
                if retry < CONFIG['max_retries'] - 1:
                    await asyncio.sleep(1)
        
        return None
    
    def get_stats(self) -> dict:
        return {
            'requests': self.request_count,
            'errors': dict(self.error_count)
        }


def parse_llm_response(response: str) -> Optional[dict]:
    """解析 LLM 返回的 JSON"""
    if not response:
        return None
    
    try:
        # 尝试直接解析
        return json.loads(response.strip())
    except:
        pass
    
    # 尝试提取 JSON
    import re
    match = re.search(r'\{[^{}]+\}', response, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except:
            pass
    
    return None


def validate_labels(labels: dict) -> bool:
    """验证标签是否有效"""
    if not labels:
        return False
    
    required = ['direction', 'emotion', 'strategy', 'tone']
    for key in required:
        if key not in labels:
            return False
    
    if labels.get('direction') not in DIRECTIONS:
        return False
    if labels.get('emotion') not in EMOTIONS:
        return False
    if labels.get('strategy') not in STRATEGIES:
        return False
    if labels.get('tone') not in TONES:
        return False
    
    return True


# ==================== 数据加载 ====================

def load_lccc_data() -> List[List[str]]:
    """加载 LCCC 对话数据"""
    lccc_path = Path(CONFIG['lccc_path'])
    
    if not lccc_path.exists():
        # 尝试备用路径
        alt_path = Path('E:/memory-suite-data/lccc/LCCC-base_train.json')
        if alt_path.exists():
            lccc_path = alt_path
        else:
            print(f"❌ LCCC 数据不存在: {lccc_path}")
            sys.exit(1)
    
    print(f"[数据] 加载 LCCC: {lccc_path}")
    print(f"[数据] 读取中（文件较大，请稍候）...")
    with open(lccc_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    print(f"[数据] 总对话数: {len(data)}")
    
    # 只取前 50000 条，够用了
    data = data[:50000]
    
    # 过滤有效对话（至少2轮）
    valid_dialogs = [d for d in data if len(d) >= 2]
    print(f"[数据] 使用对话数: {len(valid_dialogs)}")
    
    return valid_dialogs


def prepare_dialog_samples(dialogs: List[List[str]], count: int) -> List[dict]:
    """准备对话样本"""
    samples = []
    
    for dialog in dialogs:
        if len(dialog) < 2:
            continue
        
        # 从对话中提取多个样本
        for i in range(1, len(dialog)):
            context = dialog[:i]
            user_msg = dialog[i-1] if i > 0 else ""
            ai_response = dialog[i]
            
            # 简单过滤
            if len(user_msg) < 2 or len(ai_response) < 2:
                continue
            if len(user_msg) > 200 or len(ai_response) > 200:
                continue
            
            samples.append({
                'context': ' | '.join(context[-3:]),  # 最近3轮上下文
                'user_message': user_msg,
                'ai_response': ai_response,
            })
        
        if len(samples) >= count * 2:  # 多准备一些
            break
    
    # 随机打乱并截取
    random.shuffle(samples)
    return samples[:count * 2]


# ==================== 嵌入生成 ====================

async def get_embedding(session: aiohttp.ClientSession, text: str) -> List[float]:
    """获取文本嵌入"""
    # 使用 SiliconFlow API
    api_key = os.environ.get('EMBEDDING_API_KEY', '')
    if not api_key:
        # 返回随机向量
        return [random.gauss(0, 0.1) for _ in range(1024)]
    
    try:
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {api_key}'
        }
        payload = {
            'model': 'BAAI/bge-m3',
            'input': [text],
            'encoding_format': 'float'
        }
        
        async with session.post(
            'https://api.siliconflow.cn/v1/embeddings',
            headers=headers,
            json=payload,
            timeout=30
        ) as resp:
            if resp.status == 200:
                data = await resp.json()
                return data['data'][0]['embedding']
    except:
        pass
    
    return [random.gauss(0, 0.1) for _ in range(1024)]


# ==================== 主流程 ====================

async def process_batch(
    session: aiohttp.ClientSession,
    client: APIClient,
    samples: List[dict],
    current_distribution: dict
) -> List[dict]:
    """并发处理一批样本"""
    
    async def process_one(sample):
        """处理单个样本"""
        prompt = LABELING_PROMPT.format(
            context=sample['context'],
            user_message=sample['user_message'],
            ai_response=sample['ai_response']
        )
        
        response = await client.call_llm(session, prompt)
        labels = parse_llm_response(response)
        
        if not validate_labels(labels):
            return None
        
        return {'labels': labels, 'sample': sample}
    
    # 并发执行所有样本
    tasks = [process_one(s) for s in samples]
    results_raw = await asyncio.gather(*tasks, return_exceptions=True)
    
    results = []
    for r in results_raw:
        if r is None or isinstance(r, Exception):
            continue
        
        labels = r['labels']
        sample = r['sample']
        direction = labels['direction']
        
        if should_include(direction, 'direction', current_distribution):
            result = {
                'id': f"llm_{len(results)}_{int(time.time()*1000)}",
                'input': {
                    'stateVector': generate_state_vector(),
                    'perceptionVector': generate_perception_vector(sample['user_message']),
                    'messageEmbedding': [random.gauss(0, 0.1) for _ in range(1024)],
                    'memoryEmbedding': [0.0] * 1024,
                },
                'target': {
                    'direction': labels['direction'],
                    'emotionType': labels['emotion'],
                    'emotionIntensity': labels.get('emotion_intensity', 0.5),
                    'strategyType': labels['strategy'],
                    'tone': labels['tone'],
                    'useMemory': labels.get('use_memory', False),
                    'askBack': labels.get('ask_back', False),
                    'useEmoji': labels.get('use_emoji', False),
                },
                'metadata': {
                    'source': 'lccc_llm',
                    'inputText': sample['user_message'],
                    'outputText': sample['ai_response'],
                }
            }
            results.append(result)
            update_distribution(current_distribution, labels)
    
    return results


def should_include(value: str, category: str, current_dist: dict) -> bool:
    """检查是否应该包含这个样本（平衡分布）"""
    target = TARGET_DISTRIBUTION[category].get(value, 0.1)
    current = current_dist[category].get(value, 0)
    total = sum(current_dist[category].values()) or 1
    current_ratio = current / total
    
    # 如果当前比例低于目标，更可能包含
    if current_ratio < target:
        return True
    # 如果超过目标太多，拒绝
    if current_ratio > target * 1.5:
        return random.random() < 0.3
    return random.random() < 0.7


def update_distribution(dist: dict, labels: dict):
    """更新分布统计"""
    dist['direction'][labels['direction']] = dist['direction'].get(labels['direction'], 0) + 1
    dist['emotion'][labels['emotion']] = dist['emotion'].get(labels['emotion'], 0) + 1
    dist['strategy'][labels['strategy']] = dist['strategy'].get(labels['strategy'], 0) + 1
    dist['tone'][labels['tone']] = dist['tone'].get(labels['tone'], 0) + 1


def generate_state_vector() -> List[float]:
    """生成状态向量"""
    return [
        random.uniform(0.4, 0.8),  # energy
        random.uniform(0.5, 0.9),  # mood
        random.uniform(0.3, 0.7),  # engagement
        random.uniform(0.2, 0.6),  # stress
        random.uniform(0.4, 0.8),  # confidence
        random.uniform(0.5, 0.8),  # sociability
    ] + [random.uniform(0.3, 0.7) for _ in range(21)]  # 其他状态


def generate_perception_vector(text: str) -> List[float]:
    """生成感知向量"""
    positive_words = ['好', '棒', '喜欢', '开心', '谢谢', '哈哈', '爱', '赞']
    negative_words = ['不', '烦', '讨厌', '差', '难过', '累', '无聊', '讨厌']
    question_words = ['吗', '？', '什么', '怎么', '为什么', '哪']
    
    pos_score = sum(1 for w in positive_words if w in text) / len(positive_words)
    neg_score = sum(1 for w in negative_words if w in text) / len(negative_words)
    q_score = sum(1 for w in question_words if w in text) / len(question_words)
    
    sentiment = 0.5 + pos_score * 0.3 - neg_score * 0.3
    
    return [
        sentiment,
        q_score,
        min(1.0, len(text) / 50),  # 长度
        0.0, 0.0, 0.0, 0.0, 0.0
    ]


async def main():
    print("\n" + "=" * 60)
    print("🧠 BrainNN 训练数据生成 - LLM 智能标注")
    print("=" * 60 + "\n")
    
    # 加载 LCCC 数据
    dialogs = load_lccc_data()
    
    # 准备样本
    print(f"[准备] 准备 {CONFIG['total_samples']} 个样本...")
    raw_samples = prepare_dialog_samples(dialogs, CONFIG['total_samples'])
    print(f"[准备] 候选样本: {len(raw_samples)}")
    
    # 初始化
    client = APIClient()
    current_distribution = {
        'direction': {},
        'emotion': {},
        'strategy': {},
        'tone': {},
    }
    
    all_results = []
    
    # 分批处理
    connector = aiohttp.TCPConnector(limit=100)  # 增加并发连接数
    async with aiohttp.ClientSession(connector=connector) as session:
        batch_num = 0
        sample_idx = 0
        
        while len(all_results) < CONFIG['total_samples'] and sample_idx < len(raw_samples):
            batch_num += 1
            batch = raw_samples[sample_idx:sample_idx + CONFIG['batch_size']]
            sample_idx += CONFIG['batch_size']
            
            print(f"[批次 {batch_num}] 处理 {len(batch)} 个样本...", end=' ', flush=True)
            
            results = await process_batch(session, client, batch, current_distribution)
            all_results.extend(results)
            
            print(f"成功 {len(results)} 个, 总计 {len(all_results)}/{CONFIG['total_samples']}", flush=True)
            
            # 每 10 批显示分布
            if batch_num % 10 == 0:
                print_distribution(current_distribution)
            
            # 检查是否足够
            if len(all_results) >= CONFIG['total_samples']:
                break
    
    # 截取到目标数量
    all_results = all_results[:CONFIG['total_samples']]
    
    # 保存结果
    print(f"\n[保存] 保存 {len(all_results)} 个样本...")
    output_path = Path(CONFIG['output_path'])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    output_data = {
        'samples': all_results,
        'metadata': {
            'createdAt': int(time.time() * 1000),
            'version': '2.0-llm',
            'description': 'BrainNN training data with LLM labeling',
            'stats': current_distribution,
            'api_stats': client.get_stats(),
        }
    }
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)
    
    print(f"✅ 保存完成: {output_path}")
    
    # 最终统计
    print("\n" + "=" * 60)
    print("📊 最终分布统计")
    print("=" * 60)
    print_distribution(current_distribution)
    
    print(f"\n[API] 请求统计: {client.get_stats()}")
    print("\n✅ 数据生成完成！")


def print_distribution(dist: dict):
    """打印分布统计"""
    for category, counts in dist.items():
        total = sum(counts.values()) or 1
        print(f"\n  {category}:")
        for label, count in sorted(counts.items(), key=lambda x: -x[1]):
            pct = count / total * 100
            target_pct = TARGET_DISTRIBUTION[category].get(label, 0) * 100
            bar = '█' * int(pct / 5)
            print(f"    {label:20s}: {count:4d} ({pct:5.1f}%) [目标:{target_pct:.0f}%] {bar}")


if __name__ == '__main__':
    asyncio.run(main())
