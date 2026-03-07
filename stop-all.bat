@echo off
setlocal EnableExtensions
chcp 65001 >nul
color 0C
title Memory Suite - Stop Unified Runtime

echo.
echo ================================================================
echo           Memory Suite - Stopping Unified Runtime
echo ================================================================
echo.

echo [*] Killing unified runtime and Python worker ports...
for %%p in (8080 4007 4008 9880 9933) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%p.*LISTENING"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
)

echo.
echo [+] All services stopped.
echo.
echo   Services stopped:
echo     - Unified Rust daemon (8080)
echo     - Optional Python workers on 4007 / 4008 / 9880 / 9933
echo ================================================================
echo.
timeout /t 2 >nul
exit /b 0
