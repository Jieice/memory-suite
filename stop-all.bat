@echo off
setlocal EnableExtensions
chcp 65001 >nul
color 0C
title Memory Suite - Stop All Services

echo.
echo ================================================================
echo           Memory Suite - Stopping All Services
echo ================================================================
echo.

echo [*] Stopping all PM2 processes...
call npx pm2 stop all >nul 2>&1

echo [*] Deleting all PM2 processes...
call npx pm2 delete all >nul 2>&1

echo [*] Killing any remaining processes on managed ports...
for %%p in (8080 4005 4007 4009 4010 4011 4012 4013 4014 4002 4003 4008 9880 9933) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%p.*LISTENING"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
)

echo.
echo [+] All services stopped!
echo.
echo   Services stopped:
echo     - Manager (8080)
echo     - Memory Universe (4005)
echo     - BrainNN (4007)
echo     - Agent Core (4009)
echo     - Memory System V2 (4010)
echo     - Reflection Engine (4011)
echo     - Neuro-Symbolic Bridge (4012)
echo     - Prediction Engine (4013)
echo     - Memory TTS (4014)
echo     - Memory Live2D (4002)
echo     - Memory Danmaku (4003)
echo.
echo   View PM2 status: pm2 status
echo   View PM2 logs: pm2 logs
echo ================================================================
echo.
timeout /t 2 >nul
exit /b 0
