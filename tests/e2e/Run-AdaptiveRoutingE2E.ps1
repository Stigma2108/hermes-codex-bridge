[CmdletBinding()]
param(
  [ValidateRange(5, 45)][int]$TimeoutSeconds = 30,
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$root = Join-Path ([IO.Path]::GetTempPath()) "hermes-codex-adaptive-e2e-$([guid]::NewGuid().ToString('N'))"
$runtimeRoot = Join-Path $root 'runtime'
$queueRoot = Join-Path $root 'queue\bridge\v3'
$codexHome = Join-Path $root 'codex'
$sessionsRoot = Join-Path $codexHome 'sessions\fictional\2026\07\18'
$stateRoot = Join-Path $root 'state'
$workspaceRoot = Join-Path $root 'workspace'
$logsRoot = Join-Path $root 'logs'
$configPath = Join-Path $runtimeRoot 'config.json'
$appServerEntrypoint = Join-Path $root 'app-server'
$service = $null

$knotsThread = '11111111-1111-4111-8111-111111111111'
$hermesThread = '22222222-2222-4222-8222-222222222222'
$childThread = '33333333-3333-4333-8333-333333333333'
$knotsRollout = Join-Path $sessionsRoot 'rollout-knots.jsonl'
$hermesRollout = Join-Path $sessionsRoot 'rollout-hermes.jsonl'
$childRollout = Join-Path $sessionsRoot 'rollout-child.jsonl'

function Write-Json([string]$Path, $Value) {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
  [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 20) + "`n"), [Text.UTF8Encoding]::new($false))
}
function Append-Rollout([string]$Path, $Value) {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
  [IO.File]::AppendAllText($Path, (($Value | ConvertTo-Json -Compress -Depth 20) + "`n"), [Text.UTF8Encoding]::new($false))
}
function Start-HiddenProcess([string]$FilePath, [string[]]$ArgumentList, [hashtable]$Environment) {
  $parameters = @{
    FilePath = $FilePath
    ArgumentList = $ArgumentList
    WorkingDirectory = $root
    PassThru = $true
    WindowStyle = 'Hidden'
    RedirectStandardOutput = (Join-Path $logsRoot 'service.stdout.log')
    RedirectStandardError = (Join-Path $logsRoot 'service.stderr.log')
  }
  if ($Environment.Count -gt 0) { $parameters.Environment = $Environment }
  Start-Process @parameters
}
function Wait-Until([scriptblock]$Condition, [string]$Code) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $Code
}
function Stop-HiddenProcess([System.Diagnostics.Process]$Process) {
  if ($null -eq $Process) { return }
  try { $Process.Refresh() } catch { return }
  if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    try { Wait-Process -Id $Process.Id -Timeout 5 -ErrorAction Stop } catch {}
  }
}
function New-RootRollout([string]$Path, [string]$ThreadId, [string]$ProjectPath) {
  Append-Rollout $Path ([ordered]@{ timestamp='2026-07-18T17:58:00.000Z'; type='session_meta'; payload=[ordered]@{ id=$ThreadId; thread_source='user'; cwd=$ProjectPath } })
  Append-Rollout $Path ([ordered]@{ timestamp='2026-07-18T17:58:01.000Z'; type='turn_context'; payload=[ordered]@{ turn_id="history-$ThreadId"; cwd=$ProjectPath } })
}
function Get-Events {
  $interactions = Join-Path $queueRoot 'interactions'
  if (-not (Test-Path -LiteralPath $interactions -PathType Container)) { return @() }
  @(
    Get-ChildItem -LiteralPath $interactions -Directory |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'event.json') -PathType Leaf } |
      ForEach-Object { Get-Content -LiteralPath (Join-Path $_.FullName 'event.json') -Raw | ConvertFrom-Json }
  )
}

try {
  [IO.Directory]::CreateDirectory($root) | Out-Null
  $installLog = Join-Path $root 'install.log'
  & pwsh -NoProfile -File (Join-Path $repoRoot 'bridge\scripts\Install-Bridge.ps1') -SandboxRoot $root -SkipScheduledTask -Confirm:$false *> $installLog
  if ($LASTEXITCODE -ne 0) { throw "ADAPTIVE_E2E_INSTALL:$LASTEXITCODE" }
  foreach ($directory in @($sessionsRoot, $logsRoot)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }

  $probePath = Join-Path $runtimeRoot 'scripts\Get-WindowsPresence.ps1'
  [IO.Directory]::CreateDirectory((Split-Path -Parent $probePath)) | Out-Null
  [IO.File]::WriteAllText($probePath, '[ordered]@{ locked=$true; idleMs=90000 } | ConvertTo-Json -Compress', [Text.UTF8Encoding]::new($false))

  $knotsProject = Join-Path $workspaceRoot 'Knots'
  $hermesProject = Join-Path $workspaceRoot 'Hermes-Codex'
  [IO.Directory]::CreateDirectory($knotsProject) | Out-Null
  [IO.Directory]::CreateDirectory($hermesProject) | Out-Null
  New-RootRollout $knotsRollout $knotsThread $knotsProject
  New-RootRollout $hermesRollout $hermesThread $hermesProject
  Append-Rollout $childRollout ([ordered]@{ timestamp='2026-07-18T17:58:02.000Z'; type='session_meta'; payload=[ordered]@{ id=$childThread; parent_thread_id=$knotsThread; thread_source='subagent'; cwd=$knotsProject } })
  Append-Rollout $childRollout ([ordered]@{ timestamp='2026-07-18T17:58:03.000Z'; type='turn_context'; payload=[ordered]@{ turn_id='child-history'; cwd=$knotsProject } })

  Write-Json (Join-Path $codexHome '.codex-global-state.json') ([ordered]@{
    'electron-persisted-atom-state' = [ordered]@{ 'thread-descriptions-v1' = [ordered]@{
      $knotsThread = 'Example Project Step Editor'
      $hermesThread = 'Add Telegram bridge for Hermes'
    } }
  })

  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $config.pollMinMs = 100
  $config.pollMaxMs = 100
  Write-Json $configPath $config

  $fakeApp = (Resolve-Path (Join-Path $PSScriptRoot 'fake-app-server.mjs')).Path
  $node = (Get-Command node -ErrorAction Stop).Source
  [IO.File]::WriteAllText($appServerEntrypoint, "import('$(([Uri]$fakeApp).AbsoluteUri)');`n", [Text.UTF8Encoding]::new($false))
  $serviceEnv = @{
    HERMES_E2E_APP_RECORD = (Join-Path $root 'app-record.jsonl')
    HERMES_E2E_CRASH_MARKER = (Join-Path $root 'unused-crash-marker.json')
    HERMES_E2E_APP_PID = (Join-Path $root 'app-server.pid')
    HERMES_E2E_APP_LOG = (Join-Path $logsRoot 'app-server.log')
  }
  $service = Start-HiddenProcess $node @((Join-Path $runtimeRoot 'src\cli.mjs'), 'run', '--config', $configPath) $serviceEnv
  $stateFile = Join-Path $stateRoot 'bridge-v3\sessions.state'
  Wait-Until { (Test-Path -LiteralPath $stateFile) -and ((Get-Content -LiteralPath $stateFile -Raw) -match '"type":"bootstrap"') } 'ADAPTIVE_E2E_BOOTSTRAP'

  Append-Rollout $knotsRollout ([ordered]@{
    timestamp='2026-07-18T17:59:02.319Z'; type='response_item'; turn_id='goal-turn-1'
    payload=[ordered]@{ id='goal-final-1'; type='message'; role='assistant'; phase='final_answer'; content=@(
      [ordered]@{ type='output_text'; text='Промежуточный checkpoint goal-цикла' }
    ) }
  })
  Append-Rollout $knotsRollout ([ordered]@{ timestamp='2026-07-18T17:59:08.371Z'; type='event_msg'; payload=[ordered]@{ type='task_started'; turn_id='goal-turn-2' } })
  Append-Rollout $knotsRollout ([ordered]@{
    timestamp='2026-07-18T17:59:08.930Z'; type='response_item'; turn_id='goal-turn-2'
    payload=[ordered]@{ type='message'; role='user'; content=@(
      [ordered]@{ type='input_text'; text='<codex_internal_context source="goal">Continue working toward the active thread goal.</codex_internal_context>' }
    ) }
  })
  Append-Rollout $childRollout ([ordered]@{
    timestamp='2026-07-18T17:59:10.000Z'; type='response_item'; turn_id='child-turn'
    payload=[ordered]@{ id='child-final'; type='message'; role='assistant'; phase='final_answer'; content=@(
      [ordered]@{ type='output_text'; text='Внутренний результат child-субагента' }
    ) }
  })
  Append-Rollout $hermesRollout ([ordered]@{
    timestamp='2026-07-18T17:59:11.000Z'; type='response_item'; turn_id='hermes-turn'
    payload=[ordered]@{ id='hermes-final'; type='message'; role='assistant'; phase='final_answer'; content=@(
      [ordered]@{ type='output_text'; text="Финальный отчёт Hermes`n<!-- HC3:TASK_COMPLETED -->" }
    ) }
  })

  Wait-Until { @(Get-Events | Where-Object { $_.thread.id -eq $hermesThread }).Count -eq 1 } 'ADAPTIVE_E2E_HERMES_EVENT'
  Start-Sleep -Milliseconds 1500
  $events = @(Get-Events)
  if ($events.Count -ne 1) { throw "ADAPTIVE_E2E_SPAM:$($events.Count)" }
  if ($events[0].thread.id -ne $hermesThread) { throw 'ADAPTIVE_E2E_ROUTE' }
  if (@($events | Where-Object { $_.thread.id -eq $childThread }).Count -ne 0) { throw 'ADAPTIVE_E2E_CHILD' }
  Write-Output "ADAPTIVE_E2E: PASS events=$($events.Count)"
} finally {
  Stop-HiddenProcess $service
  if ($KeepTemp) {
    Write-Host "ADAPTIVE_E2E_TEMP=$root"
  } elseif ((Split-Path -Parent $root) -eq [IO.Path]::GetTempPath().TrimEnd('\')) {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}
