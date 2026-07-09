@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

if not "%MEMORY_SUITE_HIDDEN_RELAY%"=="1" (
  wscript.exe //nologo "%~dp0start-electron.vbs" %*
  exit /b 0
)

set "LAUNCHER_DIALOG_ARG="
if "%MEMORY_SUITE_HIDDEN_RELAY%"=="1" set "LAUNCHER_DIALOG_ARG=-ShowFailureDialog"

where pwsh >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-electron.ps1" %* %LAUNCHER_DIALOG_ARG%
) else (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-electron.ps1" %* %LAUNCHER_DIALOG_ARG%
)
if errorlevel 1 (
  echo.
  echo Electron launcher failed. Check the output above.
  echo Log: "%~dp0runtime\launcher.log"
  if not "%MEMORY_SUITE_NO_PAUSE%"=="1" pause
  exit /b 1
)

exit /b 0
