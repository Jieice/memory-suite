@echo off
chcp 65001 >nul
echo 正在获取 Common Voice 中文语音样本...
echo.

set PYTHON_PATH=C:\Users\Jieice\AppData\Local\Programs\Python\Python310\python.exe

if exist "%PYTHON_PATH%" (
    "%PYTHON_PATH%" "%~dp0fetch-common-voice-samples.py"
) else (
    echo Python 未找到: %PYTHON_PATH%
    echo 请手动运行: python scripts/fetch-common-voice-samples.py
)

pause
