@echo off
REM 运行压力测试的批处理脚本

echo ========================================
echo Memory Suite 压力测试
echo ========================================
echo.

REM 默认配置：30条/秒，3小时，10个并发用户
set QPS=30
set DURATION=3
set USERS=10
set BASE_URL=http://127.0.0.1:8080

REM 解析命令行参数
if "%1"=="--help" goto :help
if "%1"=="-h" goto :help

if not "%1"=="" set QPS=%1
if not "%2"=="" set DURATION=%2
if not "%3"=="" set USERS=%3
if not "%4"=="" set BASE_URL=%4

echo 配置:
echo   每秒消息数: %QPS%
echo   持续时间: %DURATION% 小时
echo   并发用户: %USERS%
echo   基础URL: %BASE_URL%
echo.

echo 开始压力测试...
echo.

REM 运行TypeScript测试脚本
ts-node scripts/stress-test-live.ts --messagesPerSecond %QPS% --durationHours %DURATION% --concurrentUsers %USERS% --baseUrl %BASE_URL%

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo 压力测试完成！
    echo ========================================
) else (
    echo.
    echo ========================================
    echo 压力测试失败！
    echo ========================================
    exit /b 1
)

pause
goto :end

:help
echo 用法: run-stress-test.bat [QPS] [DURATION] [USERS] [BASE_URL]
echo.
echo 参数:
echo   QPS        每秒消息数 (默认: 30)
echo   DURATION   持续时间（小时）(默认: 3)
echo   USERS      并发用户数 (默认: 10)
echo   BASE_URL   API基础URL (默认: http://127.0.0.1:8080)
echo.
echo 示例:
echo   run-stress-test.bat 50 1 20
echo   运行50条/秒，1小时，20个并发用户的测试
echo.

:end
