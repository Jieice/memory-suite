@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

where pwsh >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-electron.ps1" -CheckOnly %*
) else (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-electron.ps1" -CheckOnly %*
)
set "LAUNCHER_EXIT=%ERRORLEVEL%"

echo.
echo Startup check exited with code %LAUNCHER_EXIT%.
echo Log: "%~dp0runtime\launcher.log"
pause
exit /b %LAUNCHER_EXIT%
