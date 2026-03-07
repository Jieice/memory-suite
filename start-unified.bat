@echo off
setlocal
cd /d "%~dp0"

echo Memory Suite unified bootstrap (Rust runtime first)

if not exist "runtime" mkdir "runtime"
if not exist "runtime\imports" mkdir "runtime\imports"
if not exist "runtime\audio-cache" mkdir "runtime\audio-cache"

echo [1/5] Generating shared API types...
cargo run -p api-types --bin export_web
if errorlevel 1 exit /b 1

echo [2/5] Installing web dependencies if needed...
if not exist "apps\web\node_modules" (
  call npm --prefix apps/web install
  if errorlevel 1 exit /b 1
)

echo [3/5] Building unified web shell...
call npm --prefix apps/web run build
if errorlevel 1 exit /b 1

echo [4/5] Runtime directories are ready.
if /i "%MEMORY_SUITE_SKIP_SERVE%"=="1" (
  echo [5/5] Bootstrap complete. Skipping daemon startup because MEMORY_SUITE_SKIP_SERVE=1.
  exit /b 0
)

echo [5/5] Starting unified Rust daemon...
cargo run -p daemon
