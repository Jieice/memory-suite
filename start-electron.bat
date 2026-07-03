@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

title Memory Suite - Electron
echo Memory Suite Electron desktop launcher
echo.

where pwsh >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-electron.ps1" %*
) else (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-electron.ps1" %*
)
if errorlevel 1 (
  echo.
  echo Electron launcher failed. Check the output above.
  if not "%MEMORY_SUITE_NO_PAUSE%"=="1" pause
  exit /b 1
)

exit /b 0
