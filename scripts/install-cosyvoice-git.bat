@echo off
chcp 65001 >nul
title 安装 CosyVoice

echo.
echo ================================================================
echo           安装 CosyVoice (TTS 引擎)
echo ================================================================
echo.

set COSYVOICE_DIR=python\tts\cosyvoice
set TEMP_DIR=temp_cosyvoice

echo [1/5] 创建临时目录...
if exist "%TEMP_DIR%" (
    echo   [SKIP] 临时目录已存在
) else (
    mkdir "%TEMP_DIR%"
    echo   [OK] 临时目录已创建
)

echo.
echo [2/5] 克隆 CosyVoice 仓库...
cd /d "%TEMP_DIR%"
if exist "CosyVoice" (
    echo   [SKIP] 仓库已存在
) else (
    echo   正在克隆...
    git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git
    if errorlevel 1 (
        echo   [ERROR] 克隆失败！
        pause
        exit /b 1
    )
    echo   [OK] 克隆完成
)

echo.
echo [3/5] 安装 CosyVoice...
cd CosyVoice
pip install -r requirements.txt
if errorlevel 1 (
    echo   [WARN] requirements.txt 安装失败，尝试手动安装...
    pip install torch torchaudio fastapi uvicorn numpy
)

echo.
echo [4/5] 复制 API 文件...
cd /d "%~dp0"
copy /Y "%COSYVOICE_DIR%\api.py" "%TEMP_DIR%\CosyVoice\" >nul 2>&1
if errorlevel 1 (
    echo   [WARN] API 文件复制失败
) else (
    echo   [OK] API 文件已复制
)

echo.
echo [5/5] 验证安装...
python -c "import cosyvoice; print('CosyVoice 安装成功！')" 2>nul
if errorlevel 1 (
    echo   [ERROR] CosyVoice 安装验证失败！
    echo   可能原因：
    echo   1. Python 版本不兼容（建议使用 Python 3.10 或 3.11）
    echo   2. 依赖包安装失败
    echo   3. 网络连接问题
    echo.
    pause
    exit /b 1
)
echo   [OK] CosyVoice 安装成功！

echo.
echo ================================================================
echo           CosyVoice 安装完成！
echo ================================================================
echo.
echo   API 文件: %TEMP_DIR%\CosyVoice\api.py
echo   启动命令: cd %TEMP_DIR%\CosyVoice ^&^& python api.py --port 9933
echo.
echo   现在可以在 Manager 中启动 CosyVoice 了
echo ================================================================
echo.
pause
