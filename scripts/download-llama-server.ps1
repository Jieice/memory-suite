# llama-server 下载脚本
$ErrorActionPreference = "Stop"

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "           下载 llama-server.exe (本地 LLM)" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# 配置
$downloadUrl = "https://github.com/ggerganov/llama.cpp/releases/download/b4246/llama-b4246-bin-win-avx2-x64.zip"
$zipFile = "llama-server.zip"
$extractDir = "llama-server-temp"
$targetDir = "..\models\local-llm"

# 1. 下载
Write-Host "[1/4] 下载 llama-server..." -ForegroundColor Yellow
if (-not (Test-Path $zipFile)) {
    try {
        Write-Host "   正在从 GitHub 下载..." -ForegroundColor Gray
        Invoke-WebRequest -Uri $downloadUrl -OutFile $zipFile -UseBasicParsing
        Write-Host "   [OK] 下载完成" -ForegroundColor Green
    } catch {
        Write-Host "   [ERROR] 下载失败: $_" -ForegroundColor Red
        Read-Host "按任意键退出..."
        exit 1
    }
} else {
    Write-Host "   [SKIP] 文件已存在" -ForegroundColor Yellow
}

# 2. 解压
Write-Host ""
Write-Host "[2/4] 解压文件..." -ForegroundColor Yellow
if (-not (Test-Path $extractDir)) {
    try {
        Write-Host "   正在解压..." -ForegroundColor Gray
        Expand-Archive -Path $zipFile -DestinationPath $extractDir -Force
        Write-Host "   [OK] 解压完成" -ForegroundColor Green
    } catch {
        Write-Host "   [ERROR] 解压失败: $_" -ForegroundColor Red
        Read-Host "按任意键退出..."
        exit 1
    }
} else {
    Write-Host "   [SKIP] 已解压" -ForegroundColor Yellow
}

# 3. 复制到目标目录
Write-Host ""
Write-Host "[3/4] 复制到目标目录..." -ForegroundColor Yellow
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

try {
    Copy-Item -Path "$extractDir\*.exe" -Destination $targetDir -Force
    Write-Host "   [OK] 复制完成" -ForegroundColor Green
} catch {
    Write-Host "   [ERROR] 复制失败: $_" -ForegroundColor Red
    Read-Host "按任意键退出..."
    exit 1
}

# 4. 清理临时文件
Write-Host ""
Write-Host "[4/4] 清理临时文件..." -ForegroundColor Yellow
try {
    Remove-Item $zipFile -Force -ErrorAction SilentlyContinue
    Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "   [OK] 清理完成" -ForegroundColor Green
} catch {
    Write-Host "   [WARN] 清理失败（可忽略）" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "           llama-server.exe 安装完成！" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "   位置: $targetDir\llama-server.exe" -ForegroundColor White
Write-Host "   模型: $targetDir\..\qwen3-0.6b\Qwen3-0.6B-Q8_0.gguf" -ForegroundColor White
Write-Host ""
Write-Host "   现在可以在 Manager 中启动 Local LLM 了！" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "按任意键退出..."
