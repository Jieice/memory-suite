@echo off
chcp 65001 >nul
echo ========================================
echo Testing Prediction Engine Integration
echo ========================================
echo.

REM 检查 Prediction Engine 是否运行
echo [1/5] Checking Prediction Engine...
curl -s http://localhost:4013/health >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Prediction Engine is not running!
    echo Please start it first: cd brainnn ^&^& python prediction_engine.py
    pause
    exit /b 1
)
echo ✅ Prediction Engine is running
echo.

REM 检查 Memory Universe 是否运行
echo [2/5] Checking Memory Universe...
curl -s http://localhost:4005/health >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Memory Universe is not running!
    echo Please start it first: cd memory-universe ^&^& npm start
    pause
    exit /b 1
)
echo ✅ Memory Universe is running
echo.

REM 测试预测 API
echo [3/5] Testing prediction API through Memory Universe...
curl -X POST http://localhost:4005/api/prediction/interaction ^
  -H "Content-Type: application/json" ^
  -d "{\"content\":\"今天想和大家聊聊游戏\",\"context\":{}}"
echo.
echo.

REM 测试话题选择
echo [4/5] Testing topic selection...
curl -X POST http://localhost:4005/api/prediction/select-topic ^
  -H "Content-Type: application/json" ^
  -d "{\"candidates\":[\"今天天气真好\",\"有人玩过这个游戏吗\",\"大家最近在忙什么\"],\"context\":{}}"
echo.
echo.

REM 测试预测引擎状态
echo [5/5] Testing prediction state...
curl -s http://localhost:4005/api/prediction/state
echo.
echo.

echo ========================================
echo Integration tests completed!
echo ========================================
pause
