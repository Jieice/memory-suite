@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
color 0A
title Memory Suite V8 - Launcher

set "MANAGER_PORT=8080"
set "MU_PORT=4005"
set "TTS_PORT=4014"
set "BRAIN_PORT=4007"
set "DANMAKU_PORT=4003"
set "HEALTH_TIMEOUT=12"
set "HEALTH_INTERVAL=2"

echo.
echo  ================================================================
echo            Memory Suite V8 - Service Launcher
echo  ================================================================
echo   Core:   Manager=%MANAGER_PORT%  Universe=%MU_PORT%  TTS=%TTS_PORT%
echo   Aux:    Brain=%BRAIN_PORT%  Danmaku=%DANMAKU_PORT%
echo  ================================================================
echo.

:: ---- Prerequisites ----
call npm -v >nul 2>&1
if errorlevel 1 goto npm_missing

:: ---- Step 1: Clean old logs ----
echo [1/5] Cleaning old logs...
if exist "%~dp0scripts\clear-logs.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\clear-logs.ps1" >nul 2>&1
) else (
    echo        [skip] clear-logs.ps1 not found
)

:: ---- Step 2: Stop old PM2 processes (precise, no blanket taskkill) ----
echo [2/5] Stopping old PM2 processes...
call npx pm2 delete all >nul 2>&1

:: Release ports that PM2 might have orphaned
for %%p in (%MANAGER_PORT% %MU_PORT% %TTS_PORT% %BRAIN_PORT% %DANMAKU_PORT%) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%p.*LISTENING"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
)
timeout /t 1 /nobreak >nul

:: ---- Step 3: Port pre-check ----
echo [3/5] Checking port availability...
set "PORT_CONFLICT=0"
for %%p in (%MANAGER_PORT% %MU_PORT% %TTS_PORT% %BRAIN_PORT% %DANMAKU_PORT%) do (
    netstat -ano 2>nul | findstr ":%%p.*LISTENING" >nul 2>&1
    if !errorlevel! equ 0 (
        echo        [WARN] Port %%p still occupied!
        set "PORT_CONFLICT=1"
    )
)
if "%PORT_CONFLICT%"=="1" (
    echo        Some ports are still in use. Waiting 3s for release...
    timeout /t 3 /nobreak >nul
)

:: ---- Step 4: Start services ----
echo [4/5] Starting services via PM2...
cd /d "%~dp0"
call npx pm2 start pm2.config.cjs --time
if errorlevel 1 goto start_fail

:: ---- Step 5: Health check ----
echo [5/5] Waiting for services to become healthy...
timeout /t 3 /nobreak >nul

set "MANAGER_OK=0"
set "MU_OK=0"
set "RETRIES=0"

:health_loop
if %RETRIES% geq 5 goto health_done

if "%MANAGER_OK%"=="0" (
    curl -sf -o nul -m 3 http://localhost:%MANAGER_PORT%/api/health 2>nul
    if !errorlevel! equ 0 set "MANAGER_OK=1"
)
if "%MU_OK%"=="0" (
    curl -sf -o nul -m 3 http://localhost:%MU_PORT%/api/health 2>nul
    if !errorlevel! equ 0 set "MU_OK=1"
)

if "%MANAGER_OK%"=="1" if "%MU_OK%"=="1" goto health_done
set /a RETRIES+=1
timeout /t %HEALTH_INTERVAL% /nobreak >nul
goto health_loop

:health_done
echo.
call npx pm2 list
echo.

:: ---- Status summary ----
echo  ================================================================
if "%MANAGER_OK%"=="1" (
    echo   [OK]   Manager         http://localhost:%MANAGER_PORT%
) else (
    echo   [WAIT] Manager         http://localhost:%MANAGER_PORT%  ^(still starting^)
)
if "%MU_OK%"=="1" (
    echo   [OK]   Memory Universe http://localhost:%MU_PORT%
) else (
    echo   [WAIT] Memory Universe http://localhost:%MU_PORT%  ^(still starting^)
)
echo   [----] TTS Adapter     http://localhost:%TTS_PORT%
echo   [----] Danmaku Bridge  http://localhost:%DANMAKU_PORT%
echo   [----] BrainNN         http://localhost:%BRAIN_PORT%
echo  ================================================================
echo   Manager UI:  http://localhost:%MANAGER_PORT%
echo   LoRA Train:  http://localhost:%MANAGER_PORT%/training.html
echo   Live2D:      http://localhost:%MU_PORT%/live2d/index.html
echo  ================================================================
echo   Logs: npx pm2 logs     Stop: stop-all.bat
echo  ================================================================
echo.
pause
exit /b 0

:npm_missing
echo [ERROR] npm not found. Install Node.js (includes npm) and reopen this window.
pause
exit /b 1

:start_fail
echo [ERROR] Failed to start services. Check logs:
echo         npx pm2 logs --lines 20
pause
exit /b 1
