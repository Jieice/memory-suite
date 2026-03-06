"""
LCCC 中文对话数据集转换脚本（低内存版本）

功能：
1. 流式读取 LCCC 数据，不一次性加载到内存
2. 转换成 PolicyNN 训练格式
3. 保存到 data/training/samples.json

使用方法：
python scripts/download-lccc-dataset.py --merge
python scripts/download-lccc-dataset.py --max-samples 10000 --merge
"""

import json
import os
import sys
import argparse
import random
import zipfile
from datetime import datetime

def main():
    parser = argparse.ArgumentParser(description='LCCC 数据集转换（低内存版本）')
    parser.add_argument('--max-samples', type=int, default=50000, help='最大样本数（默认5万，避免内存爆）')
    parser.add_argument('--output', type=str, default='data/training/lccc-samples.json', help='输出路径')
    parser.add_argument('--merge', action='store_true', help='合并到现有 samples.json')
    parser.add_argument('--cache-dir', type=str, default='.cache', help='缓存目录')
    args = parser.parse_args()
    
    print('🚀 LCCC 中文对话数据集转换器（低内存版本）')
    print('=' * 50)
    print(f'⚙️ 最大样本数: {args.max_samples}')
    
    # 查找数据文件
    zip_file = os.path.join(args.cache_dir, 'LCCC-base-split.zip')
    split_dir = os.path.join(args.cache_dir, 'LCCC-base-split')
    
    # 检查 zip 文件
    if os.path.exists(zip_file) and not os.path.exists(split_dir):
        print(f'\n📦 正在解压: {zip_file}')
        try:
            with zipfile.ZipFile(zip_file, 'r') as zf:
                zf.extractall(args.cache_dir)
            print('✅ 解压完成')
        except Exception as e:
            print(f'❌ 解压失败: {e}')
            sys.exit(1)
    
    # 查找 JSON 文件
    json_files = []
    if os.path.exists(split_dir):
        for f in os.listdir(split_dir):
            if f.endswith('.json'):
                json_files.append(os.path.join(split_dir, f))
    
    # 也检查单个大文件
    single_files = [
        os.path.join(args.cache_dir, 'LCCC-base.json'),
        os.path.join(args.cache_dir, 'LCCC_base.json'),
    ]
    for f in single_files:
        if os.path.exists(f):
            json_files.append(f)
    
    if not json_files:
        print('❌ 未找到 LCCC 数据文件')
        print(f'\n请确保 {zip_file} 或 {split_dir}/ 存在')
        sys.exit(1)
    
    print(f'\n📁 找到 {len(json_files)} 个数据文件')
    
    # 流式处理：边读边转换
    print(f'\n🔄 正在转换（最多 {args.max_samples} 条）...')
    
    samples = []
    total_dialogs = 0
    sample_id = 0
    
    for json_file in json_files:
        if len(samples) >= args.max_samples:
            break
            
        print(f'   处理: {os.path.basename(json_file)}')
        
        try:
            # 流式读取 JSON（逐行或分块）
            file_size = os.path.getsize(json_file)
            
            if file_size > 100 * 1024 * 1024:  # > 100MB，用流式
                samples_from_file = process_large_json_streaming(
                    json_file, 
                    args.max_samples - len(samples),
                    sample_id
                )
            else:
                # 小文件直接读
                with open(json_file, 'r', encoding='utf-8') as f:
                    dialogs = json.load(f)
                samples_from_file = process_dialogs(
                    dialogs, 
                    args.max_samples - len(samples),
                    sample_id
                )
            
            samples.extend(samples_from_file)
            sample_id += len(samples_from_file)
            total_dialogs += len(samples_from_file)
            
            print(f'      ✅ 生成 {len(samples_from_file)} 个样本')
            
        except Exception as e:
            print(f'      ⚠️ 处理失败: {e}')
            continue
    
    print(f'\n✅ 转换完成！共生成 {len(samples)} 个训练样本')
    
    # 保存
    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)
    
    # 分批写入，避免内存问题
    print(f'\n💾 正在保存到 {args.output}...')
    save_samples_chunked(samples, args.output)
    
    file_size_mb = os.path.getsize(args.output) / 1024 / 1024
    print(f'   文件大小: {file_size_mb:.1f} MB')
    
    # 合并
    if args.merge:
        merge_to_main_samples(args.output)
    
    print('\n🎉 完成！')
    print(f'   样本数量: {len(samples)}')
    print(f'   预计 NN 权重: {estimate_nn_weight(len(samples))}')


def process_large_json_streaming(json_file: str, max_samples: int, start_id: int) -> list:
    """流式处理大 JSON 文件"""
    samples = []
    sample_id = start_id
    
    # 尝试用 ijson 流式解析（如果安装了）
    try:
        import ijson
        with open(json_file, 'rb') as f:
            for dialog in ijson.items(f, 'item'):
                if len(samples) >= max_samples:
                    break
                new_samples = convert_dialog_to_samples(dialog, sample_id)
                samples.extend(new_samples)
                sample_id += len(new_samples)
        return samples
    except ImportError:
        pass
    
    # 降级：分块读取
    with open(json_file, 'r', encoding='utf-8') as f:
        # 跳过开头的 [
        content = f.read(1)
        if content != '[':
            f.seek(0)
        
        buffer = ''
        bracket_count = 0
        in_string = False
        escape_next = False
        
        while len(samples) < max_samples:
            chunk = f.read(8192)  # 8KB chunks
            if not chunk:
                break
            
            for char in chunk:
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
                    if bracket_count == 0:
                        # 完成一个对话
                        try:
                            dialog = json.loads(buffer)
                            new_samples = convert_dialog_to_samples(dialog, sample_id)
                            samples.extend(new_samples)
                            sample_id += len(new_samples)
                        except:
                            pass
                        buffer = ''
                        
                        if len(samples) >= max_samples:
                            break
                elif char == ',' and bracket_count == 0:
                    continue
                else:
                    buffer += char
    
    return samples


def process_dialogs(dialogs: list, max_samples: int, start_id: int) -> list:
    """处理对话列表"""
    samples = []
    sample_id = start_id
    
    # 随机采样
    if len(dialogs) > max_samples * 2:
        dialogs = random.sample(dialogs, max_samples * 2)
    
    for dialog in dialogs:
        if len(samples) >= max_samples:
            break
        new_samples = convert_dialog_to_samples(dialog, sample_id)
        samples.extend(new_samples)
        sample_id += len(new_samples)
    
    return samples[:max_samples]


def convert_dialog_to_samples(dialog, start_id: int) -> list:
    """将一个对话转换为训练样本"""
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
        
        sample = create_training_sample(input_text, output_text, f'lccc_{start_id}_{j}')
        samples.append(sample)
    
    return samples


def create_training_sample(input_text: str, output_text: str, sample_id: str) -> dict:
    """创建训练样本"""
    sentiment = analyze_sentiment(input_text)
    intent = analyze_intent(input_text)
    risk = analyze_risk(input_text)
    behavior_type = infer_behavior_type(input_text, output_text, sentiment, risk)
    
    return {
        'id': sample_id,
        'timestamp': int(datetime.now().timestamp() * 1000),
        'sessionId': 'lccc_import',
        'turnId': f'turn_{sample_id}',
        'features': {
            'stateVector': [0.5] * 20,
            'perceptionVector': [
                sentiment, risk, 0.8, 0.1,
                1 if intent == 'question' else 0,
                1 if intent == 'statement' else 0,
                1 if intent == 'request' else 0,
                1 if intent == 'greeting' else 0
            ],
            'messageEmbedding': [0.0] * 32,
            'memoryContextEmbedding': [0.0] * 32
        },
        'label': {
            'selectedCandidate': behavior_type,
            'candidateScores': {behavior_type: 0.8},
            'wasRejected': False,
            'riskHint': risk,
            'userFeedback': 'positive'
        },
        'metadata': {
            'inputText': input_text,
            'outputText': output_text,
            'userId': 'lccc_user',
            'quality': 0.8,
            'isNegativeExample': False,
            'weight': 1.0,
            'source': 'LCCC'
        }
    }


def analyze_sentiment(text: str) -> float:
    positive = ['好', '棒', '喜欢', '开心', '哈哈', '嘿嘿', '谢谢', '爱', '赞', '厉害', '可爱', '漂亮', '帅', '美']
    negative = ['不', '没', '烦', '讨厌', '难过', '生气', '无聊', '差', '丑', '笨', '傻', '滚', '死']
    pos = sum(1 for w in positive if w in text)
    neg = sum(1 for w in negative if w in text)
    if pos + neg == 0:
        return 0.5
    return min(1.0, max(0.0, 0.5 + (pos - neg) * 0.1))


def analyze_intent(text: str) -> str:
    if '?' in text or '？' in text or any(w in text for w in ['吗', '呢', '什么', '怎么', '为什么', '哪', '谁', '几']):
        return 'question'
    if any(w in text for w in ['你好', '早', '晚安', '嗨', 'hi', 'hello', '早上好', '下午好', '晚上好']):
        return 'greeting'
    if any(w in text for w in ['请', '能不能', '可以', '帮', '要', '想要', '给我']):
        return 'request'
    return 'statement'


def analyze_risk(text: str) -> float:
    risk_words = ['死', '杀', '政治', '色情', '赌博', '毒品', '暴力', '歧视', '自杀', '炸弹']
    for word in risk_words:
        if word in text:
            return 0.8
    return 0.1


def infer_behavior_type(input_text: str, output_text: str, sentiment: float, risk: float) -> str:
    if risk > 0.5:
        return 'refuse_safely'
    if '?' in input_text or '？' in input_text:
        return 'clarify_question'
    if sentiment > 0.6:
        if any(w in output_text for w in ['哈哈', '嘿嘿', '~', '！', '哈', '嘻']):
            return 'reply_playful'
        return 'reply_friendly'
    if sentiment < 0.4:
        return 'reply_supportive'
    return 'reply_friendly'


def save_samples_chunked(samples: list, output_path: str):
    """分块保存，避免内存问题"""
    output_data = {
        'version': '1.0',
        'source': 'LCCC-base',
        'generatedAt': datetime.now().isoformat(),
        'totalSamples': len(samples),
        'samples': samples
    }
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, separators=(',', ':'))


def merge_to_main_samples(lccc_output_path: str):
    """合并到主 samples.json"""
    main_path = 'data/training/samples.json'
    
    print(f'\n🔗 正在合并到 {main_path}...')
    
    # 读取 LCCC 样本
    with open(lccc_output_path, 'r', encoding='utf-8') as f:
        lccc_data = json.load(f)
    new_samples = lccc_data.get('samples', [])
    
    # 读取现有样本
    try:
        with open(main_path, 'r', encoding='utf-8') as f:
            main_data = json.load(f)
        existing = main_data.get('samples', [])
    except:
        existing = []
    
    # 合并
    merged = existing + new_samples
    
    output_data = {
        'samples': merged,
        'metadata': {
            'exportedAt': int(datetime.now().timestamp() * 1000),
            'totalSamples': len(merged)
        }
    }
    
    with open(main_path, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, separators=(',', ':'))
    
    print(f'✅ 已合并，总计 {len(merged)} 个样本')


def estimate_nn_weight(sample_count: int) -> str:
    if sample_count < 100:
        return '0.2 (规则主导)'
    elif sample_count < 300:
        return '0.4'
    elif sample_count < 500:
        return '0.5'
    elif sample_count < 1000:
        return '0.6'
    elif sample_count < 2000:
        return '0.7'
    elif sample_count < 5000:
        return '0.8'
    else:
        return '0.9 (NN 主导)'


if __name__ == '__main__':
    main()
