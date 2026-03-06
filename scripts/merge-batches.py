"""合并批次文件"""
import json
import os
from datetime import datetime

OUTPUT_DIR = 'data/training'
MAIN_FILE = os.path.join(OUTPUT_DIR, 'samples.json')

# 读取所有批次
batches = sorted([f for f in os.listdir(OUTPUT_DIR) if f.startswith('lccc-batch-')])
print(f'找到 {len(batches)} 个批次文件')

all_samples = []
for batch_file in batches:
    path = os.path.join(OUTPUT_DIR, batch_file)
    print(f'  读取: {batch_file}')
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
        all_samples.extend(data.get('samples', []))

print(f'\n总样本数: {len(all_samples)}')

# 读取现有非 LCCC 样本
existing = []
try:
    with open(MAIN_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
        existing = [s for s in data.get('samples', []) if s.get('metadata', {}).get('source') != 'LCCC']
except:
    pass

print(f'现有非 LCCC 样本: {len(existing)}')

# 合并
merged = existing + all_samples
print(f'合并后总数: {len(merged)}')

# 保存
output_data = {
    'samples': merged,
    'metadata': {
        'exportedAt': int(datetime.now().timestamp() * 1000),
        'totalSamples': len(merged),
        'lcccSamples': len(all_samples)
    }
}

with open(MAIN_FILE, 'w', encoding='utf-8') as f:
    json.dump(output_data, f, ensure_ascii=False, separators=(',', ':'))

size_mb = os.path.getsize(MAIN_FILE) / 1024 / 1024
print(f'\n✅ 保存到 {MAIN_FILE} ({size_mb:.1f} MB)')

# 清理批次文件
print('\n🧹 清理批次文件...')
for batch_file in batches:
    os.remove(os.path.join(OUTPUT_DIR, batch_file))
print('✅ 清理完成')
