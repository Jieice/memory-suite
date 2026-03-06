@echo off
chcp 65001 >nul
cd /d "%~dp0..\manager"
echo.
echo ========================================
echo  Common Voice 中文语音样本获取工具
echo ========================================
echo.
echo 正在使用 npm 运行脚本...
echo.
call npm exec -- node ../scripts/fetch-common-voice-samples.mjs
echo.
pause
