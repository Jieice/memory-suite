$ErrorActionPreference = 'SilentlyContinue'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir

$logDirs = @(
  (Join-Path $root 'logs'),
  (Join-Path $root 'manager\\logs'),
  (Join-Path $root 'memory-universe\\logs'),
  (Join-Path $root 'memory-tts\\logs'),
  (Join-Path $root 'brainnn\\logs'),
  (Join-Path $root 'shared\\logs')
)

foreach ($dir in $logDirs) {
  if (-not (Test-Path $dir)) {
    continue
  }

  Get-ChildItem -Path $dir -Recurse -File -Filter '*.log' | ForEach-Object {
    try {
      Clear-Content -Path $_.FullName -ErrorAction SilentlyContinue
    } catch {
      # Best-effort cleanup; skip files in use.
    }
  }
}

Write-Host "[*] Logs cleared." -ForegroundColor Green
