@echo off
setlocal
cd /d "%~dp0"

if /i "%~1"=="--help" goto :help
if /i "%~1"=="/?" goto :help
if /i "%~1"=="-h" goto :help

if /i "%~1"=="--skip-serve" (
  set "MEMORY_SUITE_SKIP_SERVE=1"
  shift
)

echo Memory Suite manager launcher is now a compatibility alias.
echo Active runtime: Rust daemon + unified web UI on http://127.0.0.1:8080
echo Redirecting to start-unified.bat ...
echo.

call "%~dp0start-unified.bat" %*
exit /b %errorlevel%

:help
echo Memory Suite compatibility launcher
echo.
echo Usage:
echo   start-manager.bat
echo   start-manager.bat --skip-serve
echo.
echo Behavior:
echo   - This script no longer starts the legacy manager stack.
echo   - It forwards to start-unified.bat.
echo   - The active operator UI is http://127.0.0.1:8080
echo.
echo Options:
echo   --skip-serve   Run bootstrap steps only and skip daemon startup.
exit /b 0
