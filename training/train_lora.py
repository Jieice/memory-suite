#!/usr/bin/env python3
"""
train_lora.py — 使用 unsloth 对 Qwen3-4B-Instruct 进行 LoRA 微调

用法:
  python train_lora.py \
    --data data/train.jsonl \
    --base-model Qwen/Qwen3-4B-Instruct \
    --output output/yuanying-lora \
    --epochs 3
"""

import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="月影 LoRA 微调 (unsloth)")
    parser.add_argument("--data", required=True, help="训练数据 JSONL 路径")
    parser.add_argument("--base-model", default="Qwen/Qwen3-4B-Instruct",
                        help="HuggingFace 基座模型名或本地路径")
    parser.add_argument("--output", default="output/yuanying-lora",
                        help="LoRA 适配器输出目录")
    parser.add_argument("--merged-output", default=None,
                        help="合并后完整模型输出目录（默认: <output>-merged）")
    parser.add_argument("--epochs", type=int, default=3, help="训练轮数")
    parser.add_argument("--lr", type=float, default=2e-4, help="学习率")
    parser.add_argument("--batch-size", type=int, default=4, help="批次大小")
    parser.add_argument("--grad-accum", type=int, default=2,
                        help="梯度累积步数")
    parser.add_argument("--lora-r", type=int, default=16, help="LoRA rank")
    parser.add_argument("--lora-alpha", type=int, default=32,
                        help="LoRA alpha")
    parser.add_argument("--max-seq-len", type=int, default=2048,
                        help="最大序列长度")
    parser.add_argument("--warmup-ratio", type=float, default=0.05,
                        help="Warmup 比例")
    parser.add_argument("--save-steps", type=int, default=50,
                        help="每 N 步保存 checkpoint")
    parser.add_argument("--no-merge", action="store_true",
                        help="训练后不自动合并 LoRA")
    parser.add_argument("--bf16", action="store_true", default=True,
                        help="使用 BF16 精度（默认开启）")

    args = parser.parse_args()

    # ─── 检查依赖 ────────────────────────────────────────
    try:
        from unsloth import FastLanguageModel
    except ImportError:
        print("❌ unsloth 未安装。请运行:")
        print('  pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"')
        sys.exit(1)

    try:
        from trl import SFTTrainer
        from transformers import TrainingArguments
        from datasets import Dataset
    except ImportError:
        print("❌ 缺少依赖。请运行:")
        print("  pip install transformers datasets peft trl accelerate")
        sys.exit(1)

    # ─── 加载数据 ────────────────────────────────────────
    if not os.path.exists(args.data):
        print(f"❌ 训练数据不存在: {args.data}")
        sys.exit(1)

    samples = []
    with open(args.data, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if "messages" in entry:
                    samples.append(entry)
            except json.JSONDecodeError:
                continue

    print(f"📊 加载 {len(samples)} 条训练样本")
    if len(samples) < 10:
        print("⚠️  样本太少，建议至少 50 条以上")

    # ─── 加载模型 ────────────────────────────────────────
    print(f"\n🔄 加载基座模型: {args.base_model}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base_model,
        max_seq_length=args.max_seq_len,
        dtype=None,  # auto detect
        load_in_4bit=True,
    )

    # ─── 配置 LoRA ──────────────────────────────────────
    print(f"🔧 配置 LoRA: r={args.lora_r}, alpha={args.lora_alpha}")
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_r,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=42,
    )

    # ─── 格式化数据 ──────────────────────────────────────
    def format_chatml(sample):
        """将 ChatML 格式转为训练文本"""
        messages = sample["messages"]
        text = ""
        for msg in messages:
            role = msg["role"]
            content = msg["content"]
            if role == "system":
                text += f"<|im_start|>system\n{content}<|im_end|>\n"
            elif role == "user":
                text += f"<|im_start|>user\n{content}<|im_end|>\n"
            elif role == "assistant":
                text += f"<|im_start|>assistant\n{content}<|im_end|>\n"
        return {"text": text}

    formatted = [format_chatml(s) for s in samples]
    dataset = Dataset.from_list(formatted)

    print(f"📝 数据集大小: {len(dataset)} 条")

    # ─── 训练 ────────────────────────────────────────────
    print(f"\n🚀 开始训练: {args.epochs} epochs, lr={args.lr}, batch={args.batch_size}")

    os.makedirs(args.output, exist_ok=True)

    training_args = TrainingArguments(
        output_dir=args.output,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=args.warmup_ratio,
        bf16=args.bf16,
        logging_steps=10,
        save_steps=args.save_steps,
        save_total_limit=3,
        optim="adamw_8bit",
        seed=42,
        report_to="none",
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=args.max_seq_len,
        packing=True,
        args=training_args,
    )

    stats = trainer.train()
    print(f"\n✅ 训练完成!")
    print(f"   Loss: {stats.training_loss:.4f}")
    print(f"   Steps: {stats.global_step}")

    # 保存 LoRA 适配器
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)
    print(f"💾 LoRA 适配器已保存: {args.output}")

    # ─── 合并 LoRA ───────────────────────────────────────
    if not args.no_merge:
        merged_dir = args.merged_output or f"{args.output}-merged"
        print(f"\n🔀 合并 LoRA 权重到基座...")
        merged_model = model.merge_and_unload()
        merged_model.save_pretrained(merged_dir)
        tokenizer.save_pretrained(merged_dir)
        print(f"💾 合并模型已保存: {merged_dir}")
        print(f"\n下一步: 运行 export_gguf 脚本将合并模型转为 GGUF 格式")
    else:
        print(f"\n跳过合并。手动合并请使用 --merged-output 参数")


if __name__ == "__main__":
    main()
