# Unified runtime chat API probe
Write-Host "================================" -ForegroundColor Cyan
Write-Host "Memory Suite - Unified Chat API" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

$testMessage = @{
    session_id = "powershell-chat-test"
    user_id = "test_user"
    text = "你好，做一次 unified chat 测试。"
} | ConvertTo-Json -Compress

Write-Host "[1/2] Checking unified health..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "http://localhost:8080/api/health" -Method Get -TimeoutSec 10
    Write-Host "OK unified health" -ForegroundColor Green
    Write-Host "  $($health | ConvertTo-Json -Depth 3)" -ForegroundColor White
} catch {
    Write-Host "FAIL unified health: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "[2/2] Testing unified chat..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:8080/api/chat" `
        -Method Post `
        -Body $testMessage `
        -ContentType "application/json; charset=utf-8" `
        -TimeoutSec 30

    Write-Host "OK unified chat" -ForegroundColor Green
    Write-Host "  $($response | ConvertTo-Json -Depth 3)" -ForegroundColor White
} catch {
    Write-Host "FAIL unified chat: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "================================" -ForegroundColor Cyan
Write-Host "Probe complete" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
