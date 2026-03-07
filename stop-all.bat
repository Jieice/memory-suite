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

echo [*] Stopping legacy PM2 processes if present...
call npx pm2 stop all >nul 2>&1

echo [*] Deleting legacy PM2 processes if present...
call npx pm2 delete all >nul 2>&1

echo [*] Killing any remaining processes on unified and fallback cleanup ports...
for %%p in (8080 4007 4009 4010 4011 4012 4013 4014 4008 9880 9933) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%p.*LISTENING"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
)

echo.
echo [+] All services stopped.
echo.
echo   Services stopped:
echo     - Unified Rust daemon (8080)
echo     - Legacy sidecars on cleanup ports if any were still running
echo.
echo   View PM2 status: pm2 status
echo   View PM2 logs: pm2 logs
echo ================================================================
echo.
timeout /t 2 >nul
exit /b 0
