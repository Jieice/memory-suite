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

echo Port 4014 (legacy TTS sidecar, optional):
netstat -ano | findstr ":4014.*LISTENING"
if errorlevel 1 echo   not listening

echo Port 9880 (SoVITS API, optional):
netstat -ano | findstr ":9880.*LISTENING"
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
if exist "memory-tts\sovits\GPT-SoVITS-v2pro-20250604\runtime\python.exe" (
    echo SoVITS Python: installed
) else (
    echo SoVITS Python: not found
)

if exist "memory-tts\sovits\GPT-SoVITS-v2pro-20250604\api_v2.py" (
    echo SoVITS API: installed
) else (
    echo SoVITS API: not found
)

echo.
echo ========================================
echo Diagnostic complete.
echo.
echo If the unified daemon is not running:
echo 1. Start the stack with start-unified.bat
echo 2. Open http://127.0.0.1:8080
echo 3. Use the Runtime page for Live2D and danmaku checks
echo ========================================
pause
