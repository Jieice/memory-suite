import json
import os
import time
import subprocess
from datetime import datetime

# 閰嶇疆璺緞
DPO_PAIRS_PATH = "../data/dpo/online_pairs.jsonl"
MODEL_PATH = "../models/qwen3-4b" # 鍘熷妯″瀷璺緞
OUTPUT_DIR = "../models/qwen3-4b-evolved"
MIN_SCORE_THRESHOLD = 0.8
MIN_PAIRS_REQUIRED = 50

def extract_high_quality_pairs():
    """浠?online_pairs.jsonl 涓彁鍙栭珮璐ㄩ噺鏁版嵁鐢ㄤ簬寰皟"""
    if not os.path.exists(DPO_PAIRS_PATH):
        print(f"[Self-Evolution] No DPO data found at {DPO_PAIRS_PATH}")
        return []

    high_quality_data = []
    with open(DPO_PAIRS_PATH, 'r', encoding='utf-8') as f:
        for line in f:
            try:
                item = json.loads(line)
                # 妫€鏌ヨ瘎鍒嗘槸鍚﹁揪鏍?
                fg_score = item.get('metadata', {}).get('fgScore', 0)
                bg_score = item.get('metadata', {}).get('bgScore', 0)
                if max(fg_score, bg_score) >= MIN_SCORE_THRESHOLD:
                    high_quality_data.append({
                        "instruction": item['prompt'],
                        "input": "",
                        "output": item['chosen']
                    })
            except Exception as e:
                print(f"[Self-Evolution] Error parsing line: {e}")
    
    return high_quality_data

def run_unsloth_finetune(train_data_path):
    """
    璋冪敤 Unsloth 杩涜杞婚噺鍖?LoRA 寰皟
    娉ㄦ剰锛氳繖闇€瑕佹湰鍦版湁 GPU 鐜鍜屽畨瑁呬簡 unsloth
    """
    print(f"[Self-Evolution] Starting Unsloth fine-tuning with {train_data_path}...")
    
    # 杩欓噷鎴戜滑鐢熸垚涓€涓复鏃跺井璋冭剼鏈苟鎵ц
    # 瀹為檯鐢熶骇涓缓璁娇鐢ㄩ瀹氫箟鐨?train.py
    finetune_script = f"""
from unsloth import FastLanguageModel
import torch
from datasets import load_dataset
from trl import SFTTrainer
from transformers import TrainingArguments

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name = "{MODEL_PATH}",
    max_seq_length = 2048,
    load_in_4bit = True,
)

model = FastLanguageModel.get_peft_model(
    model,
    r = 16,
    target_modules = ["q_proj", "k_proj", "v_proj", "o_proj"],
    lora_alpha = 16,
    lora_dropout = 0,
    bias = "none",
)

dataset = load_dataset("json", data_files="{train_data_path}", split="train")

trainer = SFTTrainer(
    model = model,
    train_dataset = dataset,
    dataset_text_field = "output",
    max_seq_length = 2048,
    args = TrainingArguments(
        per_device_train_batch_size = 2,
        gradient_accumulation_steps = 4,
        warmup_steps = 5,
        max_steps = 60,
        learning_rate = 2e-4,
        fp16 = not torch.cuda.is_bf16_supported(),
        bf16 = torch.cuda.is_bf16_supported(),
        logging_steps = 1,
        output_dir = "outputs",
    ),
)

trainer.train()
model.save_pretrained_gguf("{OUTPUT_DIR}", tokenizer, quantization_method = "q4_k_m")
"""
    with open("temp_finetune.py", "w", encoding="utf-8") as f:
        f.write(finetune_script)
    
    try:
        subprocess.run(["python", "temp_finetune.py"], check=True)
        return True
    except Exception as e:
        print(f"[Self-Evolution] Fine-tuning failed: {e}")
        return False

def main():
    print(f"--- [Self-Evolution Loop] {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ---")
    
    # 1. 鎻愬彇鏁版嵁
    data = extract_high_quality_pairs()
    print(f"[Self-Evolution] Extracted {len(data)} high quality pairs.")
    
    if len(data) < MIN_PAIRS_REQUIRED:
        print(f"[Self-Evolution] Not enough data to start evolution. Need {MIN_PAIRS_REQUIRED}.")
        return

    # 2. 淇濆瓨涓存椂璁粌鏂囦欢
    train_data_path = "temp_train_data.json"
    with open(train_data_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # 3. 瑙﹀彂寰皟
    success = run_unsloth_finetune(train_data_path)
    
    if success:
        print("[Self-Evolution] Evolution completed successfully! New model saved to {OUTPUT_DIR}")
        # 4. 杩欓噷鍙互鍔犲叆鑷姩閲嶅惎 unified runtime 鐨勯€昏緫
    else:
        print("[Self-Evolution] Evolution failed.")

if __name__ == "__main__":
    main()

