param(
    [string]$OutputPath = "D:\AI\memory-suite\.captures\kiro\kiro-auth-log-findings.json"
)

$ErrorActionPreference = "Stop"

$roots = @(
    (Join-Path $env:APPDATA "Kiro\logs"),
    (Join-Path $env:USERPROFILE ".kiro\logs")
) | Where-Object { Test-Path -LiteralPath $_ }

$patterns = @(
    "PortalAuthProvider: Opening portal",
    "PortalAuthServer: Listening",
    "Authentication timed out",
    "Failed to retrieve auth token",
    "https://",
    "token",
    "auth",
    "signin",
    "login",
    "profile"
)

$findings = foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -Recurse -File -Include *.log -ErrorAction SilentlyContinue |
        Select-String -Pattern $patterns -CaseSensitive:$false |
        ForEach-Object {
            [ordered]@{
                file = $_.Path
                line = $_.LineNumber
                text = $_.Line
            }
        }
}

$dir = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$findings | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

Write-Host "Wrote findings: $OutputPath"
Write-Host "Matches: $(@($findings).Count)"
