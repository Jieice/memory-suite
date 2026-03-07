@echo off
setlocal
cd /d "%~dp0"

echo Memory Suite unified bootstrap (Rust runtime first)

if not exist "runtime" mkdir "runtime"
if not exist "runtime\imports" mkdir "runtime\imports"
if not exist "runtime\audio-cache" mkdir "runtime\audio-cache"
if not exist "runtime\overlay-vendor\live2d-core" mkdir "runtime\overlay-vendor\live2d-core"

echo [1/5] Generating shared API types...
cargo run -p api-types --bin export_web
if errorlevel 1 exit /b 1

echo [2/5] Installing web dependencies if needed...
if not exist "apps\web\node_modules\pixi.js\dist\browser\pixi.min.js" (
  call npm --prefix apps/web install
  if errorlevel 1 exit /b 1
)

echo [3/5] Building unified web shell...
call npm --prefix apps/web run build
if errorlevel 1 exit /b 1

echo [4/5] Runtime directories are ready.
if not exist "runtime\overlay-vendor\live2d-core\live2dcubismcore.min.js" (
  echo     Downloading local Cubism Core runtime for OBS overlay...
  powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js' -OutFile 'runtime\\overlay-vendor\\live2d-core\\live2dcubismcore.min.js'"
  if errorlevel 1 exit /b 1
)
if /i "%MEMORY_SUITE_SKIP_SERVE%"=="1" (
  echo [5/5] Bootstrap complete. Skipping daemon startup because MEMORY_SUITE_SKIP_SERVE=1.
  exit /b 0
)

powershell -NoProfile -Command "$connections = @(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue); if ($connections.Length -gt 0) { $conn = $connections[0]; $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue; $name = if ($proc) { $proc.ProcessName } else { 'unknown' }; Write-Host ('[5/5] Port 8080 is already in use by ' + $name + ' (PID ' + $conn.OwningProcess + ').'); if ($name -eq 'daemon') { Write-Host '    Unified daemon is already running. Open http://127.0.0.1:8080 or stop the old process first.'; exit 10 } else { Write-Host '    Stop that process or free port 8080 before starting Memory Suite.'; exit 11 } }"
if errorlevel 11 (
  pause
  exit /b 1
)
if errorlevel 10 (
  pause
  exit /b 0
)

echo [5/5] Building unified Rust daemon...
cargo build -p daemon
if errorlevel 1 (
  echo.
  echo Unified daemon build failed.
  pause
  exit /b 1
)

echo [6/6] Starting unified Rust daemon...
target\debug\daemon.exe
if errorlevel 1 (
  echo.
  echo Unified daemon exited with an error.
  pause
  exit /b 1
)
