param(
    [string]$KiroPath = "E:\AI\Kiro\Kiro.exe",
    [string]$CaptureDir = "D:\AI\memory-suite\.captures\kiro",
    [int]$RemoteDebuggingPort = 9222,
    [string]$ProxyServer = "http://127.0.0.1:8080",
    [switch]$UseProxy
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $KiroPath)) {
    throw "Kiro executable not found: $KiroPath"
}

New-Item -ItemType Directory -Force -Path $CaptureDir | Out-Null

$runningKiro = Get-Process Kiro -ErrorAction SilentlyContinue
if ($runningKiro) {
    Write-Warning "Kiro is already running. Close Kiro fully before running this script, otherwise Chromium startup flags may not apply."
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$netLogPath = Join-Path $CaptureDir "kiro-netlog-$stamp.json"
$manifestPath = Join-Path $CaptureDir "kiro-capture-$stamp.json"

$arguments = @(
    "--remote-debugging-port=$RemoteDebuggingPort",
    "--log-net-log=$netLogPath",
    "--net-log-capture-mode=IncludeSensitive"
)

$oldHttpProxy = $env:HTTP_PROXY
$oldHttpsProxy = $env:HTTPS_PROXY
$oldAllProxy = $env:ALL_PROXY

try {
    if ($UseProxy) {
        $arguments += "--proxy-server=$ProxyServer"
        $arguments += "--proxy-bypass-list=localhost;127.0.0.1;<local>"

        $env:HTTP_PROXY = $ProxyServer
        $env:HTTPS_PROXY = $ProxyServer
        $env:ALL_PROXY = $ProxyServer
    }

    $process = Start-Process -FilePath $KiroPath -ArgumentList $arguments -PassThru
} finally {
    $env:HTTP_PROXY = $oldHttpProxy
    $env:HTTPS_PROXY = $oldHttpsProxy
    $env:ALL_PROXY = $oldAllProxy
}

$manifest = [ordered]@{
    started_at = (Get-Date).ToString("o")
    pid = $process.Id
    kiro_path = $KiroPath
    remote_debugging_url = "http://127.0.0.1:$RemoteDebuggingPort"
    netlog_path = $netLogPath
    proxy_enabled = [bool]$UseProxy
    proxy_server = if ($UseProxy) { $ProxyServer } else { $null }
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host "Kiro started."
Write-Host "PID: $($process.Id)"
Write-Host "Remote debugging: http://127.0.0.1:$RemoteDebuggingPort"
Write-Host "Netlog path: $netLogPath"
Write-Host "Manifest: $manifestPath"
Write-Host "Close Kiro normally before opening the netlog file."
