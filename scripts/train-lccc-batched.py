"""
LCCC 完整数据集分批处理脚本

功能：
1. 流式读取 889MB 的训练数据
2. 分批转换，每批 10000 条
3. 边处理边保存，避免内存爆

使用方法：
python scripts/train-lccc-batched.py
"""

import json
import os
import sys
from datetime import datetime

# 配置
TRAIN_FILE = '.cache/LCCC-base-split/LCCC-base_train.json'
OUTPUT_DIR = 'data/training'
BATCH_SIZE = 50000  # 每批处理数量
MAX_TOTAL = 0  # 最多处理多少条（设为 0 表示全部）

def main():
    print('🚀 LCCC 完整数据集分批处理')
    print('=' * 50)
    
    if not os.path.exists(TRAIN_FILE):
        print(f'❌ 找不到训练文件: {TRAIN_FILE}')
        sys.exit(1)
    
    file_size = os.path.getsize(TRAIN_FILE) / 1024 / 1024
    print(f'📁 训练文件: {TRAIN_FILE} ({file_size:.1f} MB)')
    print(f'⚙️ 每批: {BATCH_SIZE} 条')
    print(f'⚙️ 最大: {MAX_TOTAL if MAX_TOTAL > 0 else "全部"} 条')
    
    # 确保输出目录存在
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # 流式处理
    print('\n🔄 开始处理...')
    
    all_samples = []
    batch_num = 0
    total_processed = 0
    
    with open(TRAIN_FILE, 'r', encoding='utf-8') as f:
        # 跳过开头的 [
        f.read(1)
        
        buffer = ''
        bracket_count = 0
        in_string = False
        escape_next = False
        current_dialog = []
        
        while True:
            if MAX_TOTAL > 0 and total_processed >= MAX_TOTAL:
                break
            
            chunk = f.read(65536)  # 64KB chunks
            if not chunk:
                break
            
            for char in chunk:
                if MAX_TOTAL > 0 and total_processed >= MAX_TOTAL:
                    break
                
                if escape_next:
                    buffer += char
                    escape_next = False
                    continue
                
                if char == '\\':
                    buffer += char
                    escape_next = True
                    continue
                
                if char == '"':
                    in_string = not in_string
                    buffer += char
                    continue
                
                if in_string:
                    buffer += char
                    continue
                
                if char == '[':
                    bracket_count += 1
                    if bracket_count == 1:
                        buffer = '['
                    else:
                        buffer += char
                elif char == ']':
                    bracket_count -= 1
                    buffer += char
                    if bracket_count == 0 and buffer.strip():
                        # 完成一个对话
                        try:
                            dialog = json.loads(buffer)
                            samples = convert_dialog(dialog, total_processed)
                            all_samples.extend(samples)
                            total_processed += 1
                            
                            # 每批保存一次
                            if len(all_samples) >= BATCH_SIZE:
                                batch_num += 1
                                save_batch(all_samples[:BATCH_SIZE], batch_num)
                                all_samples = all_samples[BATCH_SIZE:]
                                print(f'   已处理 {total_processed} 条对话')
                        except json.JSONDecodeError:
                            pass
                        buffer = ''
                elif char == ',' and bracket_count == 0:
                    continue
                else:
                    buffer += char
    
    # 保存剩余的
    if all_samples:
        batch_num += 1
        save_batch(all_samples, batch_num)
    
    print(f'\n✅ 处理完成！')
    print(f'   总对话数: {total_processed}')
    print(f'   总批次: {batch_num}')
    
    # 合并所有批次
    print('\n🔗 合并所有批次...')
    merge_all_batches(batch_num)


def convert_dialog(dialog: list, dialog_id: int) -> list:
    """转换一个对话"""
    samples = []
    
    if not isinstance(dialog, list) or len(dialog) < 2:
        return samples
    
    for j in range(len(dialog) - 1):
        input_text = dialog[j]
        output_text = dialog[j + 1]
        
        if not isinstance(input_text, str) or not isinstance(output_text, str):
            continue
        if len(input_text) < 2 or len(output_text) < 2:
            continue
        if len(input_text) > 200 or len(output_text) > 500:
            continue
        
        # 简化的样本格式（节省空间）
        sample = {
            'id': f'lccc_{dialog_id}_{j}',
            'features': {
                'stateVector': [0.5] * 20,
                'perceptionVector': get_perception(input_text),
                'messageEmbedding': [0.0] * 32,
                'memoryContextEmbedding': [0.0] * 32
            },
            'label': {
                'selectedCandidate': get_behavior(input_text, output_text),
                'wasRejected': False,
                'userFeedback': 'positive'
            },
            'metadata': {
                'inputText': input_text,
                'outputText': output_text,
                'quality': 0.8,
                'source': 'LCCC'
            }
        }
        samples.append(sample)
    
    return samples


def get_perception(text: str) -> list:
    """获取感知向量"""
    # 情感
    positive = ['好', '棒', '喜欢', '开心', '哈哈', '谢谢', '爱', '赞']
    negative = ['不', '没', '烦', '讨厌', '难过', '无聊', '差']
    pos = sum(1 for w in positive if w in text)
    neg = sum(1 for w in negative if w in text)
    sentiment = 0.5 + (pos - neg) * 0.1
    sentiment = max(0, min(1, sentiment))
    
    # 意图
    is_question = '?' in text or '？' in text or any(w in text for w in ['吗', '呢', '什么', '怎么'])
    is_greeting = any(w in text for w in ['你好', '早', '晚安', '嗨'])
    is_request = any(w in text for w in ['请', '能不能', '可以', '帮'])
    
    return [
        sentiment,  # sentiment
        0.1,        # risk
        0.8,        # confidence
        0.1,        # entities
        1 if is_question else 0,
        1 if not is_question and not is_greeting and not is_request else 0,
        1 if is_request else 0,
        1 if is_greeting else 0
    ]


def get_behavior(input_text: str, output_text: str) -> str:
    """推断行为类型"""
    if '?' in input_text or '？' in input_text:
        return 'clarify_question'
    if any(w in output_text for w in ['哈哈', '嘿嘿', '~', '！']):
        return 'reply_playful'
    return 'reply_friendly'


def save_batch(samples: list, batch_num: int):
    """保存一个批次"""
    output_file = os.path.join(OUTPUT_DIR, f'lccc-batch-{batch_num:03d}.json')
    
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump({'samples': samples}, f, ensure_ascii=False, separators=(',', ':'))
    
    size_mb = os.path.getsize(output_file) / 1024 / 1024
    print(f'   💾 保存批次 {batch_num}: {len(samples)} 条 ({size_mb:.1f} MB)')


def merge_all_batches(total_batches: int):
    """合并所有批次到 samples.json"""
    main_path = os.path.join(OUTPUT_DIR, 'samples.json')
    
    # 读取现有样本
    existing = []
    try:
        with open(main_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            existing = [s for s in data.get('samples', []) if s.get('metadata', {}).get('source') != 'LCCC']
    except:
        pass
    
    print(f'   现有非 LCCC 样本: {len(existing)}')
    
    # 合并所有批次
    all_lccc = []
    for i in range(1, total_batches + 1):
        batch_file = os.path.join(OUTPUT_DIR, f'lccc-batch-{i:03d}.json')
        if os.path.exists(batch_file):
            with open(batch_file, 'r', encoding='utf-8') as f:
                batch_data = json.load(f)
                all_lccc.extend(batch_data.get('samples', []))
    
    print(f'   LCCC 样本: {len(all_lccc)}')
    
    # 合并
    merged = existing + all_lccc
    
    output_data = {
        'samples': merged,
        'metadata': {
            'exportedAt': int(datetime.now().timestamp() * 1000),
            'totalSamples': len(merged),
            'lcccSamples': len(all_lccc)
        }
    }
    
    with open(main_path, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, separators=(',', ':'))
    
    size_mb = os.path.getsize(main_path) / 1024 / 1024
    print(f'   ✅ 合并完成: {len(merged)} 条 ({size_mb:.1f} MB)')
    
    # 清理批次文件
    print('   🧹 清理批次文件...')
    for i in range(1, total_batches + 1):
        batch_file = os.path.join(OUTPUT_DIR, f'lccc-batch-{i:03d}.json')
        if os.path.exists(batch_file):
            os.remove(batch_file)
    
    # 估算 NN 权重
    if len(merged) >= 5000:
        weight = '0.9 (NN 主导)'
    elif len(merged) >= 2000:
        weight = '0.8'
    elif len(merged) >= 1000:
        weight = '0.7'
    else:
        weight = '0.6'
    
    print(f'\n🧠 预计 NN 权重: {weight}')


if __name__ == '__main__':
    main()
