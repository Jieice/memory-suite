# 测试聊天 API
Write-Host "================================" -ForegroundColor Cyan
Write-Host "Memory Suite - 聊天 API 测试" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# 测试数据
$testMessage = @{
    message = "你好，测试一下"
    userId = "test_user"
    userName = "测试用户"
} | ConvertTo-Json -Compress

Write-Host "[1/3] 测试 Memory Universe 直接连接..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:4005/api/chat" `
        -Method Post `
        -Body $testMessage `
        -ContentType "application/json; charset=utf-8" `
        -TimeoutSec 30
    
    Write-Host "✓ Memory Universe 响应成功" -ForegroundColor Green
    Write-Host "  响应: $($response | ConvertTo-Json -Depth 3)" -ForegroundColor White
} catch {
    Write-Host "✗ Memory Universe 失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  状态码: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
}

Write-Host ""

# 测试 Manager 代理
Write-Host "[2/3] 测试 Manager 代理..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:8080/api/chat" `
        -Method Post `
        -Body $testMessage `
        -ContentType "application/json; charset=utf-8" `
        -TimeoutSec 30
    
    Write-Host "✓ Manager 代理响应成功" -ForegroundColor Green
    Write-Host "  响应: $($response | ConvertTo-Json -Depth 3)" -ForegroundColor White
} catch {
    Write-Host "✗ Manager 代理失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  状态码: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
}

Write-Host ""

# 测试 BrainNN
Write-Host "[3/3] 测试 BrainNN..." -ForegroundColor Yellow
$brainnnTest = @{
    text = "你好"
    user_id = "test"
} | ConvertTo-Json -Compress

try {
    $response = Invoke-RestMethod -Uri "http://localhost:4007/process" `
        -Method Post `
        -Body $brainnnTest `
        -ContentType "application/json; charset=utf-8" `
        -TimeoutSec 10
    
    Write-Host "✓ BrainNN 响应成功" -ForegroundColor Green
    Write-Host "  回复: $($response.agent_decision.response)" -ForegroundColor White
} catch {
    Write-Host "✗ BrainNN 失败: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "================================" -ForegroundColor Cyan
Write-Host "测试完成！" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
