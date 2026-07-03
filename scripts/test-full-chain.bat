@echo off
chcp 65001 >nul
title Memory Suite - Unified Runtime Flow Test
color 0B

echo.
echo ========================================
echo   Memory Suite - Unified Runtime Flow Test
echo ========================================
echo.

echo [1/4] Runtime health
curl -s http://127.0.0.1:8080/api/health > health_result.tmp 2>nul
type health_result.tmp | findstr "\"status\":\"ok\"" >nul
if errorlevel 1 (
    echo   FAIL runtime health
    type health_result.tmp
) else (
    echo   OK runtime health
)
del health_result.tmp 2>nul

echo.
echo [2/4] Chat flow
curl -s -X POST http://127.0.0.1:8080/api/chat -H "Content-Type: application/json" -d "{\"text\":\"full chain test\",\"user_id\":\"test-full-chain\"}" > chat_result.tmp 2>nul
type chat_result.tmp | findstr "\"assistant_text\"" >nul
if errorlevel 1 (
    echo   FAIL chat flow
    type chat_result.tmp
) else (
    echo   OK chat flow
)
del chat_result.tmp 2>nul

echo.
echo [3/4] Live2D state update
curl -s -X POST http://127.0.0.1:8080/api/live2d/subtitle -H "Content-Type: application/json" -d "{\"text\":\"unified subtitle test\",\"duration_ms\":3000}" > live2d_result.tmp 2>nul
type live2d_result.tmp | findstr "\"subtitle\":\"unified subtitle test\"" >nul
if errorlevel 1 (
    echo   FAIL live2d subtitle update
    type live2d_result.tmp
) else (
    echo   OK live2d subtitle update
)
del live2d_result.tmp 2>nul

echo.
echo [4/4] Danmaku state readback
curl -s http://127.0.0.1:8080/api/danmaku/state > danmaku_result.tmp 2>nul
type danmaku_result.tmp | findstr "\"status\"" >nul
if errorlevel 1 (
    echo   FAIL danmaku state readback
    type danmaku_result.tmp
) else (
    echo   OK danmaku state readback
)
del danmaku_result.tmp 2>nul

echo.
echo ========================================
echo Unified runtime flow test complete.
echo ========================================
pause
