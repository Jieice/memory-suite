#!/usr/bin/env bash
# export_gguf.sh — 将合并后的 HF 模型转为 GGUF (Q4_K_M)
#
# 用法: bash export_gguf.sh <merged_model_dir> <output_dir>
# 示例: bash export_gguf.sh output/yuanying-lora-merged output/gguf

set -euo pipefail

MERGED_DIR="${1:?用法: bash export_gguf.sh <merged_model_dir> <output_dir>}"
OUTPUT_DIR="${2:-output/gguf}"
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-$(pwd)/llama.cpp}"
QUANT_TYPE="${QUANT_TYPE:-Q4_K_M}"

echo "═══════════════════════════════════════════════"
echo "  LoRA → GGUF 导出工具"
echo "═══════════════════════════════════════════════"
echo "  合并模型: $MERGED_DIR"
echo "  输出目录: $OUTPUT_DIR"
echo "  量化类型: $QUANT_TYPE"
echo "  llama.cpp: $LLAMA_CPP_DIR"
echo "═══════════════════════════════════════════════"

# 检查合并模型是否存在
if [ ! -d "$MERGED_DIR" ]; then
    echo "❌ 合并模型目录不存在: $MERGED_DIR"
    echo "   请先运行 train_lora.py（不加 --no-merge）"
    exit 1
fi

# 克隆 llama.cpp（如果不存在）
if [ ! -d "$LLAMA_CPP_DIR" ]; then
    echo "📥 克隆 llama.cpp..."
    git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_CPP_DIR"
fi

# 安装 Python 依赖
echo "📦 安装转换依赖..."
pip install -q sentencepiece protobuf gguf

mkdir -p "$OUTPUT_DIR"

# Step 1: HF → GGUF (FP16)
FP16_GGUF="$OUTPUT_DIR/Qwen3-4B-Instruct-YuanYing-f16.gguf"
echo ""
echo "🔄 Step 1/2: 转换 HF → GGUF (FP16)..."
python "$LLAMA_CPP_DIR/convert_hf_to_gguf.py" \
    "$MERGED_DIR" \
    --outfile "$FP16_GGUF" \
    --outtype f16

echo "✅ FP16 GGUF: $FP16_GGUF"

# Step 2: 量化
QUANT_GGUF="$OUTPUT_DIR/Qwen3-4B-Instruct-YuanYing-${QUANT_TYPE}.gguf"
echo ""
echo "🔄 Step 2/2: 量化 FP16 → $QUANT_TYPE..."

# 尝试使用预编译的 llama-quantize
QUANTIZE_BIN=""
if [ -f "$LLAMA_CPP_DIR/build/bin/llama-quantize" ]; then
    QUANTIZE_BIN="$LLAMA_CPP_DIR/build/bin/llama-quantize"
elif [ -f "$LLAMA_CPP_DIR/llama-quantize" ]; then
    QUANTIZE_BIN="$LLAMA_CPP_DIR/llama-quantize"
elif command -v llama-quantize &> /dev/null; then
    QUANTIZE_BIN="llama-quantize"
else
    echo "⚠️  llama-quantize 未找到，尝试编译..."
    pushd "$LLAMA_CPP_DIR"
    cmake -B build
    cmake --build build --target llama-quantize -j$(nproc)
    popd
    QUANTIZE_BIN="$LLAMA_CPP_DIR/build/bin/llama-quantize"
fi

"$QUANTIZE_BIN" "$FP16_GGUF" "$QUANT_GGUF" "$QUANT_TYPE"

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ 导出完成!"
echo "  GGUF 文件: $QUANT_GGUF"
echo ""
echo "  下一步:"
echo "  1. 复制到模型目录:"
echo "     cp $QUANT_GGUF ../models/Qwen3-4B-Instruct/"
echo "  2. 更新 .env:"
echo "     LOCAL_LLM_MODEL_PATH=models/Qwen3-4B-Instruct/Qwen3-4B-Instruct-YuanYing-${QUANT_TYPE}.gguf"
echo "  3. 重启 start-unified.bat"
echo "═══════════════════════════════════════════════"

# 清理 FP16 中间文件（可选）
read -p "删除 FP16 中间文件 ($FP16_GGUF)? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -f "$FP16_GGUF"
    echo "🗑️  已删除 FP16 中间文件"
fi
