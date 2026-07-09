param(
  [int]$Port = 0,
  [switch]$SkipBootstrap,
  [switch]$NoDaemonStart,
  [switch]$NoLive2D,
  [switch]$CheckOnly,
  [switch]$ShowFailureDialog
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
$runtimeDir = Join-Path $root 'runtime'
$launcherLog = Join-Path $runtimeDir 'launcher.log'
$launcherLogEnabled = $true

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
try {
  Set-Content -Path $launcherLog -Value '' -Encoding UTF8
} catch {
  $launcherLogEnabled = $false
  Microsoft.PowerShell.Utility\Write-Host "[launcher] 无法写入启动日志: $($_.Exception.Message)" -ForegroundColor Yellow
}

function Write-LauncherLogLine {
  param([string]$Line)

  if (-not $launcherLogEnabled) {
    return
  }

  try {
    Add-Content -Path $launcherLog -Value $Line -Encoding UTF8
  } catch {
    $script:launcherLogEnabled = $false
    Microsoft.PowerShell.Utility\Write-Host "[launcher] 无法继续写入启动日志: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Write-LauncherOutput {
  param([string]$Line)

  Microsoft.PowerShell.Utility\Write-Host $Line
  Write-LauncherLogLine -Line $Line
}

function Write-LauncherStatus {
  param(
    [string]$Message,
    [ConsoleColor]$ForegroundColor
  )

  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $line = "[$timestamp] $Message"
  if ($PSBoundParameters.ContainsKey('ForegroundColor')) {
    Microsoft.PowerShell.Utility\Write-Host $line -ForegroundColor $ForegroundColor
  } else {
    Microsoft.PowerShell.Utility\Write-Host $line
  }
  Write-LauncherLogLine -Line $line
}

function ConvertTo-ProcessArgument {
  param([string]$Value)

  if ($null -eq $Value) {
    return '""'
  }

  if ($Value -notmatch '[\s"]') {
    return $Value
  }

  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

function ConvertTo-CmdArgument {
  param([string]$Value)

  if ($null -eq $Value) {
    return '""'
  }

  return '"' + ($Value -replace '"', '""') + '"'
}

function Resolve-NativeCommandPath {
  param([string]$FilePath)

  if (Test-Path -LiteralPath $FilePath) {
    return (Resolve-Path -LiteralPath $FilePath).Path
  }

  $command = Get-Command $FilePath -ErrorAction Stop
  return $command.Source
}

function Write-MultilineLauncherOutput {
  param([string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return
  }

  $Text -split "`r?`n" |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    ForEach-Object { Write-LauncherOutput -Line $_ }
}

function Invoke-LoggedNativeCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments = @()
  )

  $resolvedPath = Resolve-NativeCommandPath -FilePath $FilePath
  $extension = [System.IO.Path]::GetExtension($resolvedPath).ToLowerInvariant()
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = (Get-Location).Path

  if ($extension -in @('.cmd', '.bat')) {
    $cmd = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }
    $argumentText = ($Arguments | ForEach-Object { ConvertTo-CmdArgument -Value $_ }) -join ' '
    $commandText = '"' + ($resolvedPath -replace '"', '""') + '"'
    if ($argumentText) {
      $commandText = "$commandText $argumentText"
    }
    $psi.FileName = $cmd
    $psi.Arguments = "/d /c `"$commandText`""
  } else {
    $psi.FileName = $resolvedPath
    $psi.Arguments = ($Arguments | ForEach-Object { ConvertTo-ProcessArgument -Value $_ }) -join ' '
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  if (-not $process.Start()) {
    throw "无法启动命令: $FilePath"
  }

  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  Write-MultilineLauncherOutput -Text $stdoutTask.Result
  Write-MultilineLauncherOutput -Text $stderrTask.Result

  return $process.ExitCode
}

function Show-LauncherFailureDialog {
  param([string]$Message)

  if (-not $ShowFailureDialog) {
    return
  }

  try {
    $shell = New-Object -ComObject WScript.Shell
    $body = "$Message`n`n日志: $launcherLog"
    $shell.Popup($body, 0, '忆境启动器 - 启动失败', 16) | Out-Null
  } catch {
    Write-LauncherStatus -Message "[launcher] 无法显示失败弹窗: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

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
  param(
    [int]$CandidatePort,
    [int[]]$ListeningPorts
  )

  if ($ListeningPorts) {
    return ($ListeningPorts -contains $CandidatePort)
  }

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
  $ipProperties = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
  $listeningPorts = @($ipProperties.GetActiveTcpListeners() | Select-Object -ExpandProperty Port -Unique)

  foreach ($candidate in $candidates) {
    Set-RuntimeEndpoint $candidate
    if ((Test-PortListening -CandidatePort $candidate -ListeningPorts $listeningPorts) -and (Test-RuntimeHealth $healthUrl)) {
      if ($candidate -ne $originalPort) {
        Write-LauncherStatus -Message "[0/6] 发现可用后端: $runtimeUrl"
      }
      return
    }
  }

  foreach ($candidate in $candidates) {
    Set-RuntimeEndpoint $candidate
    if (-not (Test-PortListening -CandidatePort $candidate -ListeningPorts $listeningPorts)) {
      if ($candidate -ne $originalPort) {
        Write-LauncherStatus -Message "[0/6] 端口 $originalPort 不可用，改用 $candidate。"
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
    Write-LauncherStatus -Message '[1/6] 正在构建桌面界面资源...'
    Push-Location (Join-Path $root 'apps\web')
    try {
      $exitCode = Invoke-LoggedNativeCommand -FilePath 'npm' -Arguments @('install')
      if ($exitCode -ne 0) {
        throw "apps/web 的 npm install 失败，退出码 $exitCode"
      }
      $exitCode = Invoke-LoggedNativeCommand -FilePath 'npm' -Arguments @('run', 'build')
      if ($exitCode -ne 0) {
        throw "apps/web 的 npm run build 失败，退出码 $exitCode"
      }
    } finally {
      Pop-Location
    }
  } else {
    Write-LauncherStatus -Message '[1/6] 桌面界面资源已存在。'
  }

  if (Test-Path $live2dModel) {
    Write-LauncherStatus -Message '[2/6] Live2D 模型资源已就绪。'
  } else {
    Write-LauncherStatus -Message '[2/6] 未找到 Live2D 模型资源，浮窗会显示缺资源提示。' -ForegroundColor Yellow
    Write-LauncherStatus -Message "      需要的模型文件: $live2dModel" -ForegroundColor Yellow
  }

  if (Test-RuntimeHealth $healthUrl) {
    Write-LauncherStatus -Message "[3/6] 后端已在运行: $runtimeUrl"
    return
  }

  if (Test-DaemonBuildStale) {
    Write-LauncherStatus -Message '[3/6] 正在构建后端 daemon.exe...'
    Use-PortableGnuToolchainIfPresent
    $cargo = Get-CargoCommand
    if (-not $cargo) {
      throw "没有找到 Rust cargo，并且 daemon.exe 不存在：$daemonExe。请安装 Rust，或从 cargo 可用的终端启动。"
    }
    Push-Location $root
    try {
      $exitCode = Invoke-LoggedNativeCommand -FilePath $cargo -Arguments @('build', '-p', 'daemon')
      if ($exitCode -ne 0) {
        throw "cargo build -p daemon 失败，退出码 $exitCode"
      }
    } finally {
      Pop-Location
    }
  } else {
    Write-LauncherStatus -Message '[3/6] 后端 daemon.exe 已存在。'
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
    Write-LauncherStatus -Message '[5/6] Electron 依赖已就绪。'
    return
  }

  Write-LauncherStatus -Message '[5/6] 正在安装 Electron 依赖...'
  Push-Location $root
  try {
    $exitCode = Invoke-LoggedNativeCommand -FilePath 'npm' -Arguments @('install')
    if ($exitCode -ne 0) {
      throw "npm install 失败，退出码 $exitCode"
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
    & $serviceJanitor -Mode $Mode 2>&1 | ForEach-Object {
      Write-LauncherOutput -Line $_.ToString()
    }
  } catch {
    Write-LauncherStatus -Message "[janitor] $Mode 执行失败: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

try {
  Write-LauncherStatus "启动器开始。root=$root"
  Write-LauncherStatus "日志文件: $launcherLog"
  Select-RuntimePort
  Write-LauncherStatus "运行端点: $runtimeUrl"
  Invoke-BootstrapIfNeeded
  Ensure-ElectronDependency
  Start-DaemonIfNeeded -WaitForHealthy
  Write-LauncherStatus "后端健康检查通过: $healthUrl"

  if ($CheckOnly) {
    Write-LauncherStatus -Message "[6/6] 启动自检通过: $runtimeUrl"
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
    Write-LauncherStatus "正在启动 Electron: $electronMain"
    $exitCode = Invoke-LoggedNativeCommand -FilePath $electronCmd -Arguments @($electronMain)
    if ($exitCode -ne 0) {
      throw "Electron 退出，退出码 $exitCode"
    }
    Write-LauncherStatus "Electron 已正常退出。"
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
  $message = $_.Exception.Message
  Write-LauncherStatus -Message "错误: $message" -ForegroundColor Red
  Show-LauncherFailureDialog -Message $message
  exit 1
}
