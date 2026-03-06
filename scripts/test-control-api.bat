@echo off
REM 测试后台控制API的批处理脚本

echo ========================================
echo 后台控制API测试
echo ========================================
echo.

set BASE_URL=http://localhost:8080

echo [1] 查看当前控制状态...
curl -X GET %BASE_URL%/api/control/state
echo.
echo.

echo [2] 启动新话题...
curl -X POST %BASE_URL%/api/control/topic/start ^
  -H "Content-Type: application/json" ^
  -d "{\"topic\":\"测试话题\",\"context\":\"这是一个测试话题\",\"priority\":\"high\"}"
echo.
echo.

timeout /t 2 /nobreak >nul

echo [3] 设置主动行为模式...
curl -X POST %BASE_URL%/api/control/behavior/set ^
  -H "Content-Type: application/json" ^
  -d "{\"behavior\":\"proactive\",\"duration\":3600,\"reason\":\"测试\"}"
echo.
echo.

timeout /t 2 /nobreak >nul

echo [4] 设置情绪状态...
curl -X POST %BASE_URL%/api/control/mood/set ^
  -H "Content-Type: application/json" ^
  -d "{\"mood\":\"excited\",\"intensity\":0.8,\"duration\":1800}"
echo.
echo.

timeout /t 2 /nobreak >nul

echo [5] 执行指令 - 打招呼...
curl -X POST %BASE_URL%/api/control/command ^
  -H "Content-Type: application/json" ^
  -d "{\"command\":\"say_hello\",\"params\":{\"target\":\"测试用户\"}}"
echo.
echo.

timeout /t 2 /nobreak >nul

echo [6] 切换话题...
curl -X POST %BASE_URL%/api/control/topic/switch ^
  -H "Content-Type: application/json" ^
  -d "{\"fromTopic\":\"测试话题\",\"toTopic\":\"新话题\",\"transition\":\"smooth\"}"
echo.
echo.

timeout /t 2 /nobreak >nul

echo [7] 查看最终状态...
curl -X GET %BASE_URL%/api/control/state
echo.
echo.

echo ========================================
echo 测试完成！
echo ========================================

pause
