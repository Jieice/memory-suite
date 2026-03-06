@echo off
chcp 65001 >nul
echo ========================================
echo  Edge TTS 训练数据生成器
echo  声音: 晓涵 (zh-CN-XiaohanNeural)
echo ========================================
echo.

:: 检查 edge-tts 是否安装
pip show edge-tts >nul 2>&1
if errorlevel 1 (
    echo 正在安装 edge-tts...
    pip install edge-tts
    echo.
)

:: 运行生成脚本
python "%~dp0generate-training-audio.py"

echo.
pause
