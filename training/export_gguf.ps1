<#
.SYNOPSIS
    将合并后的 HF 模型转为 GGUF (Q4_K_M)
.PARAMETER LoraPath
    合并后的模型目录路径
.PARAMETER OutputDir
    GGUF 输出目录
.PARAMETER QuantType
    量化类型 (默认 Q4_K_M)
.EXAMPLE
    .\export_gguf.ps1 -LoraPath output\yuanying-lora-merged -OutputDir output\gguf
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$LoraPath,

    [string]$OutputDir = "output\gguf",
    [string]$QuantType = "Q4_K_M",
    [string]$LlamaCppDir = ""
)

$ErrorActionPreference = "Stop"

Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  LoRA -> GGUF Export Tool (Windows)" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Merged model: $LoraPath"
Write-Host "  Output dir:   $OutputDir"
Write-Host "  Quant type:   $QuantType"
Write-Host "=======================================" -ForegroundColor Cyan

# Validate merged model directory
if (-not (Test-Path $LoraPath)) {
    Write-Host "ERROR: Merged model directory not found: $LoraPath" -ForegroundColor Red
    Write-Host "  Run train_lora.py first (without --no-merge)" -ForegroundColor Yellow
    exit 1
}

# Find llama.cpp
if (-not $LlamaCppDir) {
    $LlamaCppDir = Join-Path (Get-Location) "llama.cpp"
}

if (-not (Test-Path $LlamaCppDir)) {
    Write-Host "Cloning llama.cpp..." -ForegroundColor Yellow
    git clone --depth 1 https://github.com/ggerganov/llama.cpp $LlamaCppDir
}

# Install Python deps
Write-Host "`nInstalling conversion dependencies..." -ForegroundColor Yellow
pip install -q sentencepiece protobuf gguf

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

# Step 1: HF -> GGUF (FP16)
$fp16Gguf = Join-Path $OutputDir "Qwen3-4B-Instruct-YuanYing-f16.gguf"
Write-Host "`nStep 1/2: Converting HF -> GGUF (FP16)..." -ForegroundColor Green

$convertScript = Join-Path $LlamaCppDir "convert_hf_to_gguf.py"
python $convertScript $LoraPath --outfile $fp16Gguf --outtype f16

if (-not (Test-Path $fp16Gguf)) {
    Write-Host "ERROR: FP16 GGUF conversion failed" -ForegroundColor Red
    exit 1
}
Write-Host "FP16 GGUF created: $fp16Gguf" -ForegroundColor Green

# Step 2: Quantize
$quantGguf = Join-Path $OutputDir "Qwen3-4B-Instruct-YuanYing-$QuantType.gguf"
Write-Host "`nStep 2/2: Quantizing FP16 -> $QuantType..." -ForegroundColor Green

# Find llama-quantize binary
$quantizeBin = ""
$candidates = @(
    (Join-Path $LlamaCppDir "build\bin\Release\llama-quantize.exe"),
    (Join-Path $LlamaCppDir "build\bin\llama-quantize.exe"),
    (Join-Path $LlamaCppDir "llama-quantize.exe")
)
foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
        $quantizeBin = $candidate
        break
    }
}

if (-not $quantizeBin) {
    # Try system PATH
    $found = Get-Command llama-quantize -ErrorAction SilentlyContinue
    if ($found) {
        $quantizeBin = $found.Source
    } else {
        Write-Host "WARNING: llama-quantize not found. Building from source..." -ForegroundColor Yellow
        Push-Location $LlamaCppDir
        cmake -B build
        cmake --build build --config Release --target llama-quantize
        Pop-Location
        $quantizeBin = Join-Path $LlamaCppDir "build\bin\Release\llama-quantize.exe"
    }
}

& $quantizeBin $fp16Gguf $quantGguf $QuantType

Write-Host "`n=======================================" -ForegroundColor Cyan
Write-Host "  Export complete!" -ForegroundColor Green
Write-Host "  GGUF file: $quantGguf" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Yellow
Write-Host "  1. Copy to model dir:"
Write-Host "     Copy-Item '$quantGguf' '..\models\Qwen3-4B-Instruct\'"
Write-Host "  2. Update .env:"
Write-Host "     LOCAL_LLM_MODEL_PATH=models\Qwen3-4B-Instruct\Qwen3-4B-Instruct-YuanYing-$QuantType.gguf"
Write-Host "  3. Restart start-unified.bat"
Write-Host "=======================================" -ForegroundColor Cyan

# Optionally clean up FP16 intermediate
$cleanup = Read-Host "Delete FP16 intermediate file? [y/N]"
if ($cleanup -eq 'y' -or $cleanup -eq 'Y') {
    Remove-Item $fp16Gguf -Force
    Write-Host "Deleted FP16 intermediate file" -ForegroundColor Yellow
}
