@echo off
chcp 65001 >nul
echo ========================================
echo   强制清理所有服务端口
echo ========================================
echo.
echo 警告：这将杀死所有占用以下端口的进程：
echo 4014, 4002, 4003, 4005, 4006, 4007, 4008, 8080, 8081, 9880
echo.
pause

echo.
echo 正在清理端口...

for %%p in (4014 4002 4003 4005 4006 4007 4008 8080 8081 9880) do (
    echo 检查端口 %%p...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p.*LISTENING"') do (
        echo   杀死 PID %%a (端口 %%p)
        taskkill /F /PID %%a 2>nul
    )
)

echo.
echo 端口清理完成！
echo.
echo 现在可以重新启动服务了。
pause
