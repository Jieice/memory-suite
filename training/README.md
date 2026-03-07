# LoRA 微调管线 — 月影人格训练

## 目标
用 LoRA 微调 Qwen3-4B-Instruct，让模型内化月影的人格、语气和常见场景回复，
减少对 system prompt 的依赖，提升一致性和响应速度。

## 前置要求
- Python 3.10+
- CUDA 11.8+ / cuDNN
- GPU VRAM ≥ 8GB（推荐 12GB+）
- 已安装 `unsloth`、`transformers`、`datasets`、`peft`

```bash
pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
pip install transformers datasets peft trl accelerate bitsandbytes
```

## 数据准备

### 1. 从现有对话日志提取
```bash
python prepare_data.py --source logs --output data/from_logs.jsonl
```

### 2. 从 SQLite 数据库提取
```bash
python prepare_data.py --source db --db-path ../data/memory_universe.db --output data/from_db.jsonl
```

### 3. 从 evo_memory 提取
```bash
python prepare_data.py --source evo --output data/from_evo.jsonl
```

### 4. 合并所有数据
```bash
python prepare_data.py --merge data/from_logs.jsonl data/from_evo.jsonl data/seed_conversations.jsonl --output data/train.jsonl
```

### 数据格式 (ChatML JSONL)
每行一个 JSON 对象：
```json
{"messages": [{"role": "system", "content": "你是月影..."}, {"role": "user", "content": "你好呀"}, {"role": "assistant", "content": "哼，又来找我了~"}]}
```

## 训练

```bash
python train_lora.py \
  --data data/train.jsonl \
  --base-model Qwen/Qwen3-4B-Instruct \
  --output output/yuanying-lora \
  --epochs 3 \
  --lr 2e-4 \
  --batch-size 4 \
  --lora-r 16 \
  --lora-alpha 32
```

### LoRA 参数说明
- `r=16`: LoRA 秩，越大拟合能力越强但越易过拟合
- `alpha=32`: 缩放因子，一般设为 2×r
- `target_modules`: q_proj, k_proj, v_proj, o_proj
- `epochs`: 3-5 个 epoch，小数据集用 3
- `lr`: 2e-4，可根据 loss 曲线调整

## 导出 GGUF

训练完成后，合并 LoRA 权重并转为 GGUF 量化格式：

### Windows (PowerShell)
```powershell
.\export_gguf.ps1 -LoraPath output/yuanying-lora -OutputDir output/gguf
```

### Linux/WSL
```bash
bash export_gguf.sh output/yuanying-lora output/gguf
```

导出后将 `output/gguf/Qwen3-4B-Instruct-YuanYing-Q4_K_M.gguf` 复制到
`models/Qwen3-4B-Instruct/` 并更新 `.env` 中的 `LOCAL_LLM_MODEL_PATH`。

## 验证
1. 替换模型文件后重启 unified runtime (`start-unified.bat`)
2. 发送测试消息，检查人格一致性
3. 观察 Race Mode 下本地 vs DeepSeek 的竞争表现
4. 如果本地模型回复质量下降，考虑回退到原始模型

## 目录结构
```
training/
├── README.md                 # 本文件
├── prepare_data.py           # 数据提取+格式转换
├── train_lora.py             # unsloth LoRA 训练脚本
├── export_gguf.sh            # Linux 导出脚本
├── export_gguf.ps1           # Windows 导出脚本
└── data/
    └── seed_conversations.jsonl  # 种子对话（手工精编）
```
