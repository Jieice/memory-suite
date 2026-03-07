@echo off
chcp 65001 >nul
title 安装 CosyVoice

echo.
echo ================================================================
echo           安装 CosyVoice (TTS 引擎)
echo ================================================================
echo.

set COSYVOICE_DIR=python\tts\cosyvoice
set REQUIREMENTS_FILE=%COSYVOICE_DIR%\requirements.txt

echo [1/3] 检查目录...
if not exist "%COSYVOICE_DIR%" (
    mkdir "%COSYVOICE_DIR%"
    echo   [OK] 目录已创建
) else (
    echo   [OK] 目录已存在
)

echo.
echo [2/3] 安装依赖...
cd /d "%~dp0%COSYVOICE_DIR%"

if not exist "requirements.txt" (
    echo   创建 requirements.txt...
    echo cosyvoice>=0.1.0 > requirements.txt
    echo fastapi>=0.104.0 >> requirements.txt
    echo uvicorn[standard]>=0.24.0 >> requirements.txt
    echo torch>=2.0.0 >> requirements.txt
    echo torchaudio>=2.0.0 >> requirements.txt
    echo numpy>=1.24.0 >> requirements.txt
)

echo   正在安装 Python 依赖...
python -m pip install -r requirements.txt -q
if errorlevel 1 (
    echo   [ERROR] 依赖安装失败！
    pause
    exit /b 1
)
echo   [OK] 依赖安装完成

echo.
echo [3/3] 验证安装...
python -c "import cosyvoice; print('CosyVoice 安装成功！')" 2>nul
if errorlevel 1 (
    echo   [ERROR] CosyVoice 安装验证失败！
    pause
    exit /b 1
)
echo   [OK] CosyVoice 安装成功！

echo.
echo ================================================================
echo           CosyVoice 安装完成！
echo ================================================================
echo.
echo   API 文件: %COSYVOICE_DIR%\api.py
echo   现在可以在 Manager 中启动 CosyVoice 了
echo ================================================================
echo.
pause
