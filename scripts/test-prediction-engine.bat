@echo off
chcp 65001 >nul
echo ========================================
echo Testing Prediction Engine
echo ========================================
echo.

REM 检查服务是否运行
echo [1/5] Checking if Prediction Engine is running...
curl -s http://localhost:4013/health >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Prediction Engine is not running!
    echo Please start it first: cd brainnn ^&^& python prediction_engine.py
    pause
    exit /b 1
)
echo ✅ Prediction Engine is running
echo.

REM 测试 1: 互动预测
echo [2/5] Testing interaction prediction...
curl -X POST http://localhost:4013/predict/interaction ^
  -H "Content-Type: application/json" ^
  -d "{\"content\":\"今天想和大家聊聊游戏\",\"context\":{\"currentViewers\":150}}"
echo.
echo.

REM 测试 2: 舆情模拟
echo [3/5] Testing sentiment prediction...
curl -X POST http://localhost:4013/predict/sentiment ^
  -H "Content-Type: application/json" ^
  -d "{\"scenario\":\"general\",\"duration\":3}"
echo.
echo.

REM 测试 3: 策略优化
echo [4/5] Testing strategy optimization...
curl -X POST http://localhost:4013/predict/optimize ^
  -H "Content-Type: application/json" ^
  -d "{\"goal\":\"maximize_engagement\",\"constraints\":[\"no_controversial\"]}"
echo.
echo.

REM 测试 4: 获取状态
echo [5/5] Getting engine state...
curl -s http://localhost:4013/state
echo.
echo.

echo ========================================
echo All tests completed!
echo ========================================
pause
