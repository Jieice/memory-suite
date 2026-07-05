@echo off
chcp 65001 >nul
echo ========================================
echo   Memory Suite Unified Runtime Diagnostic
echo ========================================
echo.

echo [1/4] Checking primary ports...
echo.
echo Port 8080 (Unified daemon):
netstat -ano | findstr ":8080.*LISTENING"
if errorlevel 1 echo   not listening

echo Port 9880 (SoVITS API, optional):
netstat -ano | findstr ":9880.*LISTENING"
if errorlevel 1 echo   not listening

echo Port 9881 (Edge TTS API):
netstat -ano | findstr ":9881.*LISTENING"
if errorlevel 1 echo   not listening

echo.
echo ========================================
echo [2/4] Checking unified HTTP endpoints...
echo.

echo GET /api/health ...
curl -s http://127.0.0.1:8080/api/health 2>nul || echo no response

echo.
echo GET /api/runtime/overview ...
curl -s http://127.0.0.1:8080/api/runtime/overview 2>nul || echo no response

echo.
echo GET /api/live2d/state ...
curl -s http://127.0.0.1:8080/api/live2d/state 2>nul || echo no response

echo.
echo GET /api/danmaku/state ...
curl -s http://127.0.0.1:8080/api/danmaku/state 2>nul || echo no response

echo.
echo ========================================
echo [3/4] Checking overlay routes...
echo.

echo Live2D overlay:
curl -s -o nul -w "HTTP %%{http_code}" http://127.0.0.1:8080/overlay/live2d 2>nul || echo no response

echo.
echo Danmaku overlay:
curl -s -o nul -w "HTTP %%{http_code}" http://127.0.0.1:8080/overlay/danmaku 2>nul || echo no response

echo.
echo ========================================
echo [4/4] Checking optional Python/TTS assets...
echo.
if exist "python\tts\sovits\GPT-SoVITS-v2pro-20250604\runtime\python.exe" (
    echo SoVITS Python: installed
) else (
    echo SoVITS Python: not found
)

if exist "python\tts\sovits\GPT-SoVITS-v2pro-20250604\api_v2.py" (
    echo SoVITS API: installed
) else (
echo SoVITS API: not found
)

if exist "scripts\service-janitor.ps1" (
    echo.
    echo Service janitor status:
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\service-janitor.ps1" -Mode status
)

echo.
echo ========================================
echo 诊断完成。
echo.
echo 如果统一后端未运行：
echo 1. 运行 start-electron.bat
echo 2. 打开 Electron 桌面端
echo 3. 在“运行时”页面检查 Live2D 和弹幕状态
echo ========================================
pause
