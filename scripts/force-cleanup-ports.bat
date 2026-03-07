@echo off
chcp 65001 >nul
echo ========================================
echo   Force Cleanup Unified and Legacy Ports
echo ========================================
echo.
echo This will kill processes listening on:
echo 8080, 4014, 4007, 4008, 9880
echo.
pause

echo.
echo Cleaning ports...

for %%p in (8080 4014 4007 4008 9880) do (
    echo Checking port %%p...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p.*LISTENING"') do (
        echo   Killing PID %%a on port %%p
        taskkill /F /PID %%a 2>nul
    )
)

echo.
echo Port cleanup complete.
pause
