/**
 * M4 QLoRA 离线训练脚本
 * 
 * 硬件约束: RTX 2070 Super 8GB
 * - 仅使用 LoRA/QLoRA
 * - 低序列长度 (max 512)
 * - 小批次 (batch_size 1-2)
 * - 仅在非直播时段运行
 */

import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';

const CONFIG = {
    baseModel: process.env.QLORA_BASE_MODEL || 'Qwen/Qwen2-1.5B-Instruct',
    adapterOutputDir: process.env.QLORA_ADAPTER_DIR || path.resolve(process.cwd(), 'data/adapters'),
    trainingDataPath: process.env.QLORA_TRAIN_DATA || path.resolve(process.cwd(), 'data/training/anime_sft.jsonl'),
    maxSeqLength: parseInt(process.env.QLORA_MAX_SEQ || '256', 10),
    batchSize: parseInt(process.env.QLORA_BATCH_SIZE || '1', 10),
    gradientAccumulation: parseInt(process.env.QLORA_GRAD_ACCUM || '8', 10),
    learningRate: parseFloat(process.env.QLORA_LR || '2e-4'),
    epochs: parseInt(process.env.QLORA_EPOCHS || '1', 10),
    loraRank: parseInt(process.env.QLORA_RANK || '8', 10),
    loraAlpha: parseInt(process.env.QLORA_ALPHA || '16', 10),
    loraDropout: parseFloat(process.env.QLORA_DROPOUT || '0.05'),
    quantization: process.env.QLORA_QUANT || '4bit',
    gpuMemoryUtilization: parseFloat(process.env.QLORA_GPU_MEM || '0.7'),
};

interface TrainingConfig {
    base_model: string;
    output_dir: string;
    train_data: string;
    max_seq_length: number;
    batch_size: number;
    gradient_accumulation_steps: number;
    learning_rate: number;
    num_train_epochs: number;
    lora_rank: number;
    lora_alpha: number;
    lora_dropout: number;
    quantization: string;
    gpu_memory_utilization: number;
}

interface TrainingResult {
    success: boolean;
    adapterPath: string | null;
    trainingTime: number;
    finalLoss: number | null;
    error?: string;
}

function checkPrerequisites(): { ok: boolean; issues: string[] } {
    const issues: string[] = [];

    if (!fs.existsSync(CONFIG.trainingDataPath)) {
        issues.push(`训练数据不存在: ${CONFIG.trainingDataPath}`);
    }

    try {
        execSync('python --version', { stdio: 'pipe' });
    } catch {
        issues.push('Python 未安装或不在 PATH 中');
    }

    try {
        const result = execSync('python -c "import torch; print(torch.cuda.is_available())"', { encoding: 'utf-8' });
        if (!result.includes('True')) {
            issues.push('CUDA 不可用，无法进行 GPU 训练');
        }
    } catch {
        issues.push('PyTorch 未安装');
    }

    try {
        execSync('python -c "import transformers; import peft; import bitsandbytes"', { stdio: 'pipe' });
    } catch {
        issues.push('缺少必要的 Python 包: transformers, peft, bitsandbytes');
    }

    return { ok: issues.length === 0, issues };
}

function generateTrainingScript(config: TrainingConfig): string {
    return `
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer
import json
import sys

def load_dataset(path):
    data = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                data.append(json.loads(line))
    return data

def main():
    print("[QLoRA] Loading base model...")
    
    tokenizer = AutoTokenizer.from_pretrained("${config.base_model}", trust_remote_code=True)
    tokenizer.pad_token = tokenizer.eos_token
    
    model_kwargs = {
        "pretrained_model_name_or_path": "${config.base_model}",
        "torch_dtype": torch.float16,
        "device_map": "auto",
        "trust_remote_code": True,
    }
    
    if "${config.quantization}" == "4bit":
        from transformers import BitsAndBytesConfig
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_use_double_quant=True,
        )
    
    model = AutoModelForCausalLM.from_pretrained(**model_kwargs)
    model = prepare_model_for_kbit_training(model)
    
    print("[QLoRA] Configuring LoRA...")
    lora_config = LoraConfig(
        r=${config.lora_rank},
        lora_alpha=${config.lora_alpha},
        lora_dropout=${config.lora_dropout},
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"]
    )
    
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()
    
    print("[QLoRA] Loading training data...")
    train_data = load_dataset("${config.train_data}")
    print(f"[QLoRA] Loaded {len(train_data)} samples")
    
    def format_sample(sample):
        if "text" in sample:
            return sample["text"]
        if "instruction" in sample and "output" in sample:
            return f"<|im_start|>user\\n{sample['instruction']}<|im_end|>\\n<|im_start|>assistant\\n{sample['output']}<|im_end|>"
        return sample.get("content", "")
    
    training_args = TrainingArguments(
        output_dir="${config.output_dir}",
        num_train_epochs=${config.num_train_epochs},
        per_device_train_batch_size=${config.batch_size},
        gradient_accumulation_steps=${config.gradient_accumulation_steps},
        learning_rate=${config.learning_rate},
        fp16=True,
        logging_steps=10,
        save_strategy="epoch",
        save_total_limit=2,
        report_to="none",
        max_grad_norm=1.0,
        warmup_ratio=0.1,
    )
    
    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=train_data,
        tokenizer=tokenizer,
        max_seq_length=${config.max_seq_length},
        formatting_func=format_sample,
    )
    
    print("[QLoRA] Starting training...")
    trainer.train()
    
    print("[QLoRA] Saving adapter...")
    trainer.model.save_pretrained("${config.output_dir}")
    tokenizer.save_pretrained("${config.output_dir}")
    
    print("[QLoRA] Training complete!")
    print(f"[QLoRA] Adapter saved to: ${config.output_dir}")

if __name__ == "__main__":
    main()
`;
}

function generateTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function runTraining(config: TrainingConfig): Promise<TrainingResult> {
    const startTime = Date.now();
    const timestamp = generateTimestamp();
    const adapterDir = path.join(config.output_dir, `adapter-${timestamp}`);

    if (!fs.existsSync(adapterDir)) {
        fs.mkdirSync(adapterDir, { recursive: true });
    }

    const trainingScript = generateTrainingScript({ ...config, output_dir: adapterDir });
    const scriptPath = path.join(adapterDir, 'train.py');
    fs.writeFileSync(scriptPath, trainingScript, 'utf-8');

    console.log(`[QLoRA] Training script: ${scriptPath}`);
    console.log(`[QLoRA] Adapter output: ${adapterDir}`);
    console.log(`[QLoRA] Config:`, JSON.stringify(config, null, 2));

    return new Promise((resolve) => {
        try {
            const process = spawn('python', [scriptPath], {
                stdio: 'inherit',
                cwd: adapterDir,
            });

            process.on('close', (code) => {
                const elapsed = Date.now() - startTime;
                if (code === 0) {
                    resolve({
                        success: true,
                        adapterPath: adapterDir,
                        trainingTime: elapsed,
                        finalLoss: null,
                    });
                } else {
                    resolve({
                        success: false,
                        adapterPath: null,
                        trainingTime: elapsed,
                        finalLoss: null,
                        error: `Training exited with code ${code}`,
                    });
                }
            });

            process.on('error', (err) => {
                resolve({
                    success: false,
                    adapterPath: null,
                    trainingTime: Date.now() - startTime,
                    finalLoss: null,
                    error: err.message,
                });
            });
        } catch (err: any) {
            resolve({
                success: false,
                adapterPath: null,
                trainingTime: Date.now() - startTime,
                finalLoss: null,
                error: err.message,
            });
        }
    });
}

async function main(): Promise<void> {
    console.log('=== M4 QLoRA 离线训练 ===\n');

    console.log('[QLoRA] 检查前置条件...');
    const prereq = checkPrerequisites();
    if (!prereq.ok) {
        console.error('[QLoRA] 前置条件不满足:');
        prereq.issues.forEach((issue) => console.error(`  - ${issue}`));
        process.exit(1);
    }
    console.log('[QLoRA] 前置条件检查通过\n');

    const config: TrainingConfig = {
        base_model: CONFIG.baseModel,
        output_dir: CONFIG.adapterOutputDir,
        train_data: CONFIG.trainingDataPath,
        max_seq_length: CONFIG.maxSeqLength,
        batch_size: CONFIG.batchSize,
        gradient_accumulation_steps: CONFIG.gradientAccumulation,
        learning_rate: CONFIG.learningRate,
        num_train_epochs: CONFIG.epochs,
        lora_rank: CONFIG.loraRank,
        lora_alpha: CONFIG.loraAlpha,
        lora_dropout: CONFIG.loraDropout,
        quantization: CONFIG.quantization,
        gpu_memory_utilization: CONFIG.gpuMemoryUtilization,
    };

    const result = await runTraining(config);

    console.log('\n=== 训练结果 ===');
    console.log(`成功: ${result.success}`);
    console.log(`耗时: ${(result.trainingTime / 1000 / 60).toFixed(1)} 分钟`);
    if (result.adapterPath) {
        console.log(`适配器路径: ${result.adapterPath}`);
    }
    if (result.error) {
        console.error(`错误: ${result.error}`);
        process.exit(1);
    }

    const manifestPath = path.join(CONFIG.adapterOutputDir, 'latest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        adapterPath: result.adapterPath,
        config,
        result: {
            success: result.success,
            trainingTime: result.trainingTime,
        },
    }, null, 2), 'utf-8');

    console.log(`\n[QLoRA] 清单文件: ${manifestPath}`);
}

main().catch(console.error);
