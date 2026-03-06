@echo off
chcp 65001 >nul
title Memory Suite - 完整链路测试
color 0B

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║           Memory Suite - 完整链路测试                        ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

:: ============================================
:: 测试 1：服务健康检查
:: ============================================
echo [测试 1] 服务健康检查
echo ─────────────────────────────────────────

echo   Manager (8080)...
curl -s http://127.0.0.1:8080/health 2>nul | findstr "healthy" >nul
if errorlevel 1 (echo     ❌ 失败) else (echo     ✅ 正常)

echo   BrainNN (4007)...
curl -s http://127.0.0.1:4007/health 2>nul | findstr "healthy" >nul
if errorlevel 1 (echo     ❌ 失败) else (echo     ✅ 正常)

echo   Memory Universe (4005)...
curl -s http://127.0.0.1:4005/health 2>nul | findstr "healthy" >nul
if errorlevel 1 (echo     ❌ 失败) else (echo     ✅ 正常)

echo   TTS (4014)...
curl -s http://127.0.0.1:4014/health 2>nul | findstr "ok" >nul
if errorlevel 1 (echo     ❌ 失败) else (echo     ✅ 正常)

echo   SoVITS (9880)...
curl -s http://127.0.0.1:9880/set_gpt_weights 2>nul >nul
if errorlevel 1 (echo     ❌ 失败 - TTS 将无法工作！) else (echo     ✅ 正常)

echo   Live2D (4002)...
curl -s http://127.0.0.1:4002/health 2>nul | findstr "healthy" >nul
if errorlevel 1 (echo     ❌ 失败) else (echo     ✅ 正常)

echo   Danmaku (4003)...
curl -s http://127.0.0.1:4003/api/status 2>nul | findstr "ok" >nul
if errorlevel 1 (echo     ❌ 失败) else (echo     ✅ 正常)

echo   Local LLM (4008)...
curl -s http://127.0.0.1:4008/health 2>nul >nul
if errorlevel 1 (echo     ❌ 失败) else (echo     ✅ 正常)

:: ============================================
:: 测试 2：TTS 合成测试
:: ============================================
echo.
echo [测试 2] TTS 合成测试
echo ─────────────────────────────────────────

echo   发送 TTS 请求...
curl -s -X POST http://127.0.0.1:4014/api/tts -H "Content-Type: application/json" -d "{\"text\":\"测试语音合成\"}" > tts_result.tmp 2>nul

type tts_result.tmp | findstr "audioPath" >nul
if errorlevel 1 (
    echo     ❌ TTS 合成失败
    type tts_result.tmp
) else (
    echo     ✅ TTS 合成成功
    type tts_result.tmp | findstr "audioPath"
)
del tts_result.tmp 2>nul

:: ============================================
:: 测试 3：AI 对话测试
:: ============================================
echo.
echo [测试 3] AI 对话测试
echo ─────────────────────────────────────────

echo   发送聊天请求...
curl -s -X POST http://127.0.0.1:8080/api/chat -H "Content-Type: application/json" -d "{\"message\":\"你好\",\"userId\":\"test\"}" > chat_result.tmp 2>nul

type chat_result.tmp | findstr "text" >nul
if errorlevel 1 (
    echo     ❌ AI 对话失败
    type chat_result.tmp
) else (
    echo     ✅ AI 对话成功
    echo     回复内容：
    type chat_result.tmp
)
del chat_result.tmp 2>nul

:: ============================================
:: 测试 4：Live2D 字幕测试
:: ============================================
echo.
echo [测试 4] Live2D 字幕测试
echo ─────────────────────────────────────────

echo   发送字幕...
curl -s -X POST http://127.0.0.1:4002/api/subtitle -H "Content-Type: application/json" -d "{\"text\":\"测试字幕显示\",\"duration_ms\":3000}" > subtitle_result.tmp 2>nul

type subtitle_result.tmp | findstr "success" >nul
if errorlevel 1 (
    echo     ❌ 字幕发送失败
) else (
    echo     ✅ 字幕发送成功
    echo     请检查 Live2D 页面是否显示字幕
)
del subtitle_result.tmp 2>nul

:: ============================================
:: 完成
:: ============================================
echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║                      测试完成                                ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.
echo 如果有服务失败，请检查：
echo   1. 是否已运行 start-all.bat
echo   2. SoVITS 是否已启动（TTS 依赖它）
echo   3. 查看 Manager UI 中的服务日志
echo.
pause
