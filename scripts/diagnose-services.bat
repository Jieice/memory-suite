@echo off
chcp 65001 >nul
echo ========================================
echo   Memory Suite 服务诊断工具
echo ========================================
echo.

echo [1/6] 检查端口占用情况...
echo.
echo 端口 4014 (TTS):
netstat -ano | findstr ":4014.*LISTENING"
if errorlevel 1 echo   未占用

echo 端口 4002 (Live2D):
netstat -ano | findstr ":4002.*LISTENING"
if errorlevel 1 echo   未占用

echo 端口 4003 (Danmaku):
netstat -ano | findstr ":4003.*LISTENING"
if errorlevel 1 echo   未占用

echo 端口 4005 (Memory Universe):
netstat -ano | findstr ":4005.*LISTENING"
if errorlevel 1 echo   未占用

echo 端口 4007 (BrainNN):
netstat -ano | findstr ":4007.*LISTENING"
if errorlevel 1 echo   未占用

echo 端口 4008 (Local LLM):
netstat -ano | findstr ":4008.*LISTENING"
if errorlevel 1 echo   未占用

echo 端口 8080 (Manager):
netstat -ano | findstr ":8080.*LISTENING"
if errorlevel 1 echo   未占用

echo 端口 9880 (SoVITS API):
netstat -ano | findstr ":9880.*LISTENING"
if errorlevel 1 echo   未占用 (TTS 需要此服务)

echo.
echo ========================================
echo [2/6] 检查服务健康状态...
echo.

echo 检查 Manager (8080)...
curl -s -o nul -w "HTTP %%{http_code}" http://127.0.0.1:8080/health 2>nul || echo 无响应

echo.
echo 检查 TTS (4014)...
curl -s http://127.0.0.1:4014/health 2>nul || echo 无响应

echo.
echo 检查 Live2D (4002)...
curl -s http://127.0.0.1:4002/health 2>nul || echo 无响应

echo.
echo 检查 Memory Universe (4005)...
curl -s http://127.0.0.1:4005/health 2>nul || echo 无响应

echo.
echo 检查 BrainNN (4007)...
curl -s http://127.0.0.1:4007/health 2>nul || echo 无响应

echo.
echo ========================================
echo [3/6] 检查 SoVITS 配置...
echo.
if exist "memory-tts\sovits\GPT-SoVITS-v2pro-20250604\runtime\python.exe" (
    echo SoVITS Python: 已安装
) else (
    echo SoVITS Python: 未找到
)

if exist "memory-tts\sovits\GPT-SoVITS-v2pro-20250604\api_v2.py" (
    echo SoVITS API: 已安装
) else (
    echo SoVITS API: 未找到
)

echo.
echo ========================================
echo 诊断完成！
echo.
echo 如果服务未启动，请：
echo 1. 先启动 SoVITS: memory-tts\sovits\start-api.bat
echo 2. 再启动 Manager: start-manager.bat
echo 3. 在 Manager Web UI 中点击"启动全部"
echo ========================================
pause
