param(
  [ValidateSet('status', 'startup', 'shutdown')]
  [string]$Mode = 'status'
)

$ErrorActionPreference = 'Stop'

function Get-ServiceDefinitions {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $daemonExe = Join-Path $repoRoot 'target\debug\daemon.exe'

  @(
    @{
      Name = 'daemon'
      ProcessName = 'daemon.exe'
      MatchAll = @($daemonExe)
      StartupAction = 'stop_all'
      ShutdownAction = 'stop_all'
      KeepCount = 0
    },
    @{
      Name = 'edge_tts'
      ProcessName = 'python.exe'
      MatchAll = @('edge_tts_server.py', '--port', '9881')
      StartupAction = 'stop_all'
      ShutdownAction = 'stop_all'
      KeepCount = 0
    },
    @{
      Name = 'flaresolverr'
      ProcessName = 'python.exe'
      MatchAll = @('-m flaresolverr')
      StartupAction = 'dedupe_keep_oldest'
      ShutdownAction = 'dedupe_keep_oldest'
      KeepCount = 1
    },
    @{
      Name = 'faster_whisper'
      ProcessName = 'python.exe'
      MatchAll = @('faster_whisper_server.py', '--port', '9882')
      StartupAction = 'stop_all'
      ShutdownAction = 'stop_all'
      KeepCount = 0
    }
  )
}

function Get-ServiceProcesses {
  param(
    [hashtable]$Definition
  )

  Get-CimInstance Win32_Process |
    Where-Object {
      if ($_.Name -ine $Definition.ProcessName -or $null -eq $_.CommandLine) {
        return $false
      }

      foreach ($needle in $Definition.MatchAll) {
        if ([string]::IsNullOrWhiteSpace($needle)) {
          continue
        }
        if (-not $_.CommandLine.Contains($needle)) {
          return $false
        }
      }

      return $true
    } |
    Sort-Object CreationDate, ProcessId |
    Select-Object @{ Name = 'Service'; Expression = { $Definition.Name } }, ProcessId, ParentProcessId, Name, CommandLine, CreationDate
}

function Stop-ServiceProcesses {
  param(
    [System.Collections.IEnumerable]$Processes
  )

  $stopped = @()
  foreach ($process in $Processes) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      $stopped += $process
    } catch {
      Write-Warning "无法停止 PID=$($process.ProcessId): $($_.Exception.Message)"
    }
  }
  $stopped
}

function Invoke-ServiceAction {
  param(
    [hashtable]$Definition,
    [string]$Action,
    [array]$Processes
  )

  if (-not $Processes.Count) {
    return [pscustomobject]@{
      Service = $Definition.Name
      Action = $Action
      Before = 0
      After = 0
      Removed = 0
      KeptPids = @()
      RemovedPids = @()
    }
  }

  $toKeep = @()
  $toStop = @()

  switch ($Action) {
    'stop_all' {
      $toStop = $Processes
    }
    'dedupe_keep_oldest' {
      $keepCount = [Math]::Max([int]$Definition.KeepCount, 1)
      $toKeep = @($Processes | Select-Object -First $keepCount)
      $toStop = @($Processes | Select-Object -Skip $keepCount)
    }
    default {
      $toKeep = $Processes
    }
  }

  $stopped = Stop-ServiceProcesses -Processes $toStop
  $remaining = Get-ServiceProcesses -Definition $Definition

  [pscustomobject]@{
    Service = $Definition.Name
    Action = $Action
    Before = $Processes.Count
    After = @($remaining).Count
    Removed = @($stopped).Count
    KeptPids = @($toKeep | Select-Object -ExpandProperty ProcessId -ErrorAction SilentlyContinue)
    RemovedPids = @($stopped | Select-Object -ExpandProperty ProcessId -ErrorAction SilentlyContinue)
  }
}

$definitions = Get-ServiceDefinitions
$results = @()

foreach ($definition in $definitions) {
  $processes = @(Get-ServiceProcesses -Definition $definition)

  switch ($Mode) {
    'status' {
      $results += [pscustomobject]@{
        Service = $definition.Name
        Action = 'status'
        Before = $processes.Count
        After = $processes.Count
        Removed = 0
        KeptPids = @($processes | Select-Object -ExpandProperty ProcessId -ErrorAction SilentlyContinue)
        RemovedPids = @()
      }
    }
    'startup' {
      $results += Invoke-ServiceAction -Definition $definition -Action $definition.StartupAction -Processes $processes
    }
    'shutdown' {
      $results += Invoke-ServiceAction -Definition $definition -Action $definition.ShutdownAction -Processes $processes
    }
  }
}

foreach ($result in $results) {
  Write-Host ("[janitor] {0} | action={1} | before={2} after={3} removed={4}" -f `
      $result.Service, $result.Action, $result.Before, $result.After, $result.Removed)
}
