param(
  [int]$Port = 0,
  [switch]$SkipBootstrap,
  [switch]$NoDaemonStart,
  [switch]$NoLive2D,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir

if ($Port -le 0) {
  if ($env:MEMORY_SUITE_PORT) {
    $Port = [int]$env:MEMORY_SUITE_PORT
  } elseif ($env:MEMORY_SUITE_URL) {
    $Port = ([Uri]$env:MEMORY_SUITE_URL).Port
  } else {
    $Port = 8080
  }
}

$runtimeUrl = if ($env:MEMORY_SUITE_URL) {
  $env:MEMORY_SUITE_URL.TrimEnd('/')
} else {
  "http://127.0.0.1:$Port"
}

$healthUrl = "$runtimeUrl/api/health"
$daemonExe = Join-Path $root 'target\debug\daemon.exe'
$webIndex = Join-Path $root 'apps\web\dist\index.html'
$electronCmd = Join-Path $root 'node_modules\.bin\electron.cmd'
$electronMain = Join-Path $root 'apps\electron\main.cjs'
$portableGnuBin = Join-Path $root 'runtime\toolchains\w64devkit\bin'
$live2dModel = Join-Path $root 'Liver2d\hiyori_zh-Hans\hiyori_pro\runtime\hiyori_pro_t11.model3.json'
$serviceJanitor = Join-Path $root 'scripts\service-janitor.ps1'

function Set-RuntimeEndpoint {
  param([int]$NextPort)

  $script:Port = $NextPort
  if ($env:MEMORY_SUITE_URL) {
    $script:runtimeUrl = $env:MEMORY_SUITE_URL.TrimEnd('/')
  } else {
    $script:runtimeUrl = "http://127.0.0.1:$script:Port"
  }
  $script:healthUrl = "$script:runtimeUrl/api/health"
}

function Get-CargoCommand {
  $command = Get-Command cargo -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidate = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
  if (Test-Path $candidate) {
    return $candidate
  }

  return $null
}

function Test-RuntimeHealth {
  param([string]$Url)

  try {
    $response = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 2
    return ($response.status -eq 'ok')
  } catch {
    return $false
  }
}

function Test-PortListening {
  param([int]$CandidatePort)

  $listener = Get-NetTCPConnection -LocalPort $CandidatePort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  return ($null -ne $listener)
}

function Select-RuntimePort {
  if ($env:MEMORY_SUITE_URL) {
    return
  }

  $originalPort = $Port
  $candidates = @($Port, 18080, 18081, 18082, 18083, 18084, 18085) |
    Select-Object -Unique

  foreach ($candidate in $candidates) {
    Set-RuntimeEndpoint $candidate
    if (Test-RuntimeHealth $healthUrl) {
      if ($candidate -ne $originalPort) {
        Write-Host "[0/6] 发现可用后端: $runtimeUrl"
      }
      return
    }
  }

  foreach ($candidate in $candidates) {
    Set-RuntimeEndpoint $candidate
    if (-not (Test-PortListening $candidate)) {
      if ($candidate -ne $originalPort) {
        Write-Host "[0/6] 端口 $originalPort 不可用，改用 $candidate。"
      }
      return
    }
  }

  throw "端口 $($candidates -join ', ') 均不可用。"
}

function Use-PortableGnuToolchainIfPresent {
  if (-not (Test-Path (Join-Path $portableGnuBin 'gcc.exe'))) {
    return
  }

  $libgcc = Get-ChildItem -Path (Split-Path -Parent $portableGnuBin) -Filter 'libgcc.a' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($libgcc) {
    $libgccEh = Join-Path $libgcc.DirectoryName 'libgcc_eh.a'
    if (-not (Test-Path $libgccEh)) {
      Copy-Item -LiteralPath $libgcc.FullName -Destination $libgccEh
    }
  }

  $pathParts = @($portableGnuBin) + (($env:PATH -split ';') | Where-Object { $_ -and $_ -ne $portableGnuBin })
  $env:PATH = ($pathParts -join ';')
}

function Test-DaemonBuildStale {
  if (-not (Test-Path $daemonExe)) {
    return $true
  }

  $daemonTime = (Get-Item -LiteralPath $daemonExe).LastWriteTimeUtc
  $sourceRoots = @(
    (Join-Path $root 'apps\daemon'),
    (Join-Path $root 'crates')
  )
  foreach ($sourceRoot in $sourceRoots) {
    if (-not (Test-Path $sourceRoot)) {
      continue
    }
    $newerSource = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Include *.rs,*.toml |
      Where-Object { $_.LastWriteTimeUtc -gt $daemonTime } |
      Select-Object -First 1
    if ($newerSource) {
      return $true
    }
  }

  return $false
}

function Invoke-BootstrapIfNeeded {
  if ($SkipBootstrap) {
    return
  }

  if (-not (Test-Path $webIndex)) {
    Write-Host '[1/6] 正在构建桌面界面资源...'
    Push-Location (Join-Path $root 'apps\web')
    try {
      & npm install
      if ($LASTEXITCODE -ne 0) {
        throw "apps/web 的 npm install 失败，退出码 $LASTEXITCODE"
      }
      & npm run build
      if ($LASTEXITCODE -ne 0) {
        throw "apps/web 的 npm run build 失败，退出码 $LASTEXITCODE"
      }
    } finally {
      Pop-Location
    }
  } else {
    Write-Host '[1/6] 桌面界面资源已存在。'
  }

  if (Test-Path $live2dModel) {
    Write-Host '[2/6] Live2D 模型资源已就绪。'
  } else {
    Write-Host '[2/6] 未找到 Live2D 模型资源，浮窗会显示缺资源提示。' -ForegroundColor Yellow
    Write-Host "      需要的模型文件: $live2dModel" -ForegroundColor Yellow
  }

  if (Test-RuntimeHealth $healthUrl) {
    Write-Host "[3/6] 后端已在运行: $runtimeUrl"
    return
  }

  if (Test-DaemonBuildStale) {
    Write-Host '[3/6] 正在构建后端 daemon.exe...'
    Use-PortableGnuToolchainIfPresent
    $cargo = Get-CargoCommand
    if (-not $cargo) {
      throw "没有找到 Rust cargo，并且 daemon.exe 不存在：$daemonExe。请安装 Rust，或从 cargo 可用的终端启动。"
    }
    Push-Location $root
    try {
      & $cargo build -p daemon
      if ($LASTEXITCODE -ne 0) {
        throw "cargo build -p daemon 失败，退出码 $LASTEXITCODE"
      }
    } finally {
      Pop-Location
    }
  } else {
    Write-Host '[3/6] 后端 daemon.exe 已存在。'
  }
}

function Start-DaemonIfNeeded {
  param(
    [switch]$WaitForHealthy
  )

  if (Test-RuntimeHealth $healthUrl) {
    return
  }

  if ($NoDaemonStart) {
    throw "后端在 $runtimeUrl 未通过健康检查，但当前设置了 -NoDaemonStart。"
  }

  if (-not (Test-Path $daemonExe)) {
    throw "找不到后端程序: $daemonExe"
  }

  Invoke-ServiceJanitor -Mode startup

  $previousPort = $env:MEMORY_SUITE_PORT
  $env:MEMORY_SUITE_PORT = [string]$Port
  try {
    Start-Process -FilePath $daemonExe -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  } finally {
    if ($null -eq $previousPort) {
      Remove-Item Env:\MEMORY_SUITE_PORT -ErrorAction SilentlyContinue
    } else {
      $env:MEMORY_SUITE_PORT = $previousPort
    }
  }

  if (-not $WaitForHealthy) {
    return
  }

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (Test-RuntimeHealth $healthUrl) {
      return
    }
    Start-Sleep -Milliseconds 500
  }

  throw "等待后端健康检查超时: $healthUrl"
}

function Ensure-ElectronDependency {
  if (Test-Path $electronCmd) {
    Write-Host '[5/6] Electron 依赖已就绪。'
    return
  }

  Write-Host '[5/6] 正在安装 Electron 依赖...'
  Push-Location $root
  try {
    & npm install
    if ($LASTEXITCODE -ne 0) {
      throw "npm install 失败，退出码 $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  if (-not (Test-Path $electronCmd)) {
    throw "找不到 Electron 命令: $electronCmd"
  }
}

function Invoke-ServiceJanitor {
  param(
    [ValidateSet('startup', 'shutdown', 'status')]
    [string]$Mode
  )

  if (-not (Test-Path $serviceJanitor)) {
    return
  }

  try {
    & $serviceJanitor -Mode $Mode
  } catch {
    Write-Host "[janitor] $Mode 执行失败: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'runtime') | Out-Null
  Select-RuntimePort
  Invoke-BootstrapIfNeeded
  Ensure-ElectronDependency
  Start-DaemonIfNeeded -WaitForHealthy:$CheckOnly

  if ($CheckOnly) {
    Write-Host "[6/6] 启动自检通过: $runtimeUrl"
    return
  }

  $previousUrl = $env:MEMORY_SUITE_URL
  $previousPort = $env:MEMORY_SUITE_PORT
  $previousRoot = $env:MEMORY_SUITE_ROOT
  $previousNoLive2D = $env:MEMORY_SUITE_NO_LIVE2D

  $env:MEMORY_SUITE_URL = $runtimeUrl
  $env:MEMORY_SUITE_PORT = [string]$Port
  $env:MEMORY_SUITE_ROOT = $root
  if ($NoLive2D) {
    $env:MEMORY_SUITE_NO_LIVE2D = '1'
  }

  try {
    & $electronCmd $electronMain
    if ($LASTEXITCODE -ne 0) {
      throw "Electron 退出，退出码 $LASTEXITCODE"
    }
  } finally {
    if ($null -eq $previousUrl) {
      Remove-Item Env:\MEMORY_SUITE_URL -ErrorAction SilentlyContinue
    } else {
      $env:MEMORY_SUITE_URL = $previousUrl
    }
    if ($null -eq $previousPort) {
      Remove-Item Env:\MEMORY_SUITE_PORT -ErrorAction SilentlyContinue
    } else {
      $env:MEMORY_SUITE_PORT = $previousPort
    }
    if ($null -eq $previousRoot) {
      Remove-Item Env:\MEMORY_SUITE_ROOT -ErrorAction SilentlyContinue
    } else {
      $env:MEMORY_SUITE_ROOT = $previousRoot
    }
    if ($null -eq $previousNoLive2D) {
      Remove-Item Env:\MEMORY_SUITE_NO_LIVE2D -ErrorAction SilentlyContinue
    } else {
      $env:MEMORY_SUITE_NO_LIVE2D = $previousNoLive2D
    }
  }
} catch {
  Write-Host "错误: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
