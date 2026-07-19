[CmdletBinding()]
param(
  [ValidateRange(5, 45)][int]$TimeoutSeconds = 30,
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$root = Join-Path ([IO.Path]::GetTempPath()) "hermes-codex-local-e2e-$([guid]::NewGuid().ToString('N'))"
$queueRoot = Join-Path $root 'Queue\bridge\v3'
$codexHome = Join-Path $root 'CODEX_HOME'
$sessionsRoot = Join-Path $codexHome 'sessions\fictional\2026\07\18'
$stateRoot = Join-Path $root 'state'
$workspaceRoot = Join-Path $root 'workspace'
$logsRoot = Join-Path $root 'logs'
$resultPath = Join-Path $root 'result.json'
$appRecord = Join-Path $root 'app-record.jsonl'
$appPid = Join-Path $root 'app-server.pid'
$crashMarker = Join-Path $root 'crash-marker.json'
$configPath = Join-Path $root 'config.json'
$appServerEntrypoint = Join-Path $root 'app-server'
$presenceScript = Join-Path $root 'presence-away.ps1'
$ownedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Write-Json([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 20) + "`n"), [Text.UTF8Encoding]::new($false))
}
function Append-Rollout([string]$Path, $Value) {
  [IO.File]::AppendAllText($Path, (($Value | ConvertTo-Json -Compress -Depth 20) + "`n"), [Text.UTF8Encoding]::new($false))
}
function Start-OwnedProcess([string]$FilePath, [string[]]$ArgumentList, [string]$Name, [hashtable]$Environment = @{}) {
  $stdout = Join-Path $logsRoot "$Name.stdout.log"
  $stderr = Join-Path $logsRoot "$Name.stderr.log"
  $parameters = @{ FilePath = $FilePath; ArgumentList = $ArgumentList; WorkingDirectory = $root; PassThru = $true; WindowStyle = 'Hidden'; RedirectStandardOutput = $stdout; RedirectStandardError = $stderr }
  if ($Environment.Count -gt 0) { $parameters.Environment = $Environment }
  $process = Start-Process @parameters
  $ownedProcesses.Add($process)
  return $process
}
function Wait-Until([scriptblock]$Condition, [string]$Code, [int]$Seconds = $TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $Code
}
function Stop-OwnedProcess([System.Diagnostics.Process]$Process) {
  try { $Process.Refresh() } catch { return }
  if ($Process.HasExited) { return }
  Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  try { Wait-Process -Id $Process.Id -Timeout 5 -ErrorAction Stop } catch {
    if (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue) { throw "CHILD_STOP_TIMEOUT:$($Process.Id)" }
  }
}
function New-Rollout([string]$Path, [string]$ThreadId, [string]$HistoryTurn, [string]$HistoryItem, [string]$HistoryText) {
  Append-Rollout $Path ([ordered]@{ timestamp='2026-07-18T10:00:00.000Z'; type='session_meta'; payload=[ordered]@{ id=$ThreadId; cwd=$workspaceRoot; originator='fictional-local-e2e' } })
  Append-Rollout $Path ([ordered]@{ timestamp='2026-07-18T10:00:01.000Z'; type='turn_context'; payload=[ordered]@{ turn_id=$HistoryTurn; cwd=$workspaceRoot } })
  Append-Rollout $Path ([ordered]@{ timestamp='2026-07-18T10:00:02.000Z'; type='response_item'; turn_id=$HistoryTurn; payload=[ordered]@{ id=$HistoryItem; type='message'; role='assistant'; phase='final_answer'; content=@([ordered]@{type='output_text';text=$HistoryText}) } })
}
function Append-Final([string]$Path, [string]$TurnId, [string]$ItemId, [string]$Text) {
  Append-Rollout $Path ([ordered]@{ timestamp=([DateTime]::UtcNow.ToString('o')); type='turn_context'; payload=[ordered]@{ turn_id=$TurnId; cwd=$workspaceRoot } })
  Append-Rollout $Path ([ordered]@{ timestamp=([DateTime]::UtcNow.AddMilliseconds(1).ToString('o')); type='response_item'; turn_id=$TurnId; payload=[ordered]@{ id=$ItemId; type='message'; role='assistant'; phase='final_answer'; content=@([ordered]@{type='output_text';text=$Text}) } })
}

$threadA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$threadB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
$rolloutA = Join-Path $sessionsRoot 'rollout-A.jsonl'
$rolloutB = Join-Path $sessionsRoot 'rollout-B.jsonl'
$service = $null
$hermes = $null
try {
  foreach ($directory in @($queueRoot, (Join-Path $queueRoot 'interactions'), $sessionsRoot, $stateRoot, $workspaceRoot, $logsRoot)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
  New-Rollout $rolloutA $threadA 'aaaaaaaa-0000-4000-8000-000000000001' 'aaaaaaaa-0000-4000-8000-000000000002' 'HISTORY-A'
  New-Rollout $rolloutB $threadB 'bbbbbbbb-0000-4000-8000-000000000001' 'bbbbbbbb-0000-4000-8000-000000000002' 'HISTORY-B'

  $fakeApp = (Resolve-Path (Join-Path $PSScriptRoot 'fake-app-server.mjs')).Path
  $node = (Get-Command node -ErrorAction Stop).Source
  $fakeAppUri = ([Uri]$fakeApp).AbsoluteUri
  [IO.File]::WriteAllText($appServerEntrypoint, "import('$fakeAppUri');`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($presenceScript, "[Console]::Out.WriteLine('{`"locked`":true,`"idleMs`":0}')`n", [Text.UTF8Encoding]::new($false))
  Write-Json $configPath ([ordered]@{ schema='hermes-codex-bridge-config/v3'; queueRoot=$queueRoot; codexHome=$codexHome; codexCommand=$node; stateRoot=$stateRoot; allowedWorkspaceRoots=@($workspaceRoot); pollMinMs=100; pollMaxMs=100; replyTtlSeconds=604800; approvalTtlSeconds=43200; uiRouterMode='external' })
  $serviceEnv = @{ HERMES_E2E_APP_RECORD=$appRecord; HERMES_E2E_CRASH_MARKER=$crashMarker; HERMES_E2E_APP_PID=$appPid; HERMES_E2E_APP_LOG=(Join-Path $logsRoot 'app-server.log') }
  $cli = (Resolve-Path (Join-Path $repoRoot 'bridge\src\cli.mjs')).Path
  $service = Start-OwnedProcess $node @($cli, 'run', '--config', $configPath, '--presence-script', $presenceScript) 'service-1' $serviceEnv
  $stateFile = Join-Path $stateRoot 'bridge-v3\sessions.state'
  Wait-Until { (Test-Path -LiteralPath $stateFile) -and ((Get-Content -Raw $stateFile) -match '"type":"bootstrap"') } 'BOOTSTRAP_TIMEOUT'

  Append-Final $rolloutA 'aaaaaaaa-1000-4000-8000-000000000001' 'aaaaaaaa-1000-4000-8000-000000000002' 'A2'
  Append-Final $rolloutB 'bbbbbbbb-1000-4000-8000-000000000001' 'bbbbbbbb-1000-4000-8000-000000000002' 'B2'
  $hermes = Start-OwnedProcess $node @((Resolve-Path (Join-Path $PSScriptRoot 'fake-hermes.mjs')).Path, $queueRoot, $resultPath) 'fake-hermes'

  Wait-Until { Test-Path -LiteralPath $crashMarker -PathType Leaf } 'CRASH_POINT_TIMEOUT'
  $bDirectory = Get-ChildItem -LiteralPath (Join-Path $queueRoot 'interactions') -Directory | Where-Object { (Get-Content -Raw (Join-Path $_.FullName 'event.json') | ConvertFrom-Json).message.summary -eq 'B2' } | Select-Object -First 1
  if ($null -eq $bDirectory -or (Test-Path -LiteralPath (Join-Path $bDirectory.FullName 'receipt.json'))) { throw 'CRASH_WINDOW_MISSED' }
  $pendingPath = Join-Path $stateRoot "thread-actions\$($bDirectory.Name).pending.json"
  $startedPath = Join-Path $stateRoot "thread-actions\$($bDirectory.Name).started.json"
  if (-not (Test-Path -LiteralPath $pendingPath -PathType Leaf) -or (Test-Path -LiteralPath $startedPath)) { throw 'CRASH_WINDOW_MISSED' }
  Stop-OwnedProcess $service
  Wait-Until { if (-not (Test-Path -LiteralPath $appPid)) { return $true }; $pidValue = [int](Get-Content -Raw $appPid); try { Get-Process -Id $pidValue -ErrorAction Stop | Out-Null; return $false } catch { return $true } } 'APP_SERVER_EXIT_TIMEOUT' 5
  Remove-Item -LiteralPath (Join-Path $stateRoot 'bridge-v3\service.lock') -Force -ErrorAction SilentlyContinue
  $service = Start-OwnedProcess $node @($cli, 'run', '--config', $configPath, '--presence-script', $presenceScript) 'service-2' $serviceEnv

  Wait-Until { Test-Path -LiteralPath $resultPath -PathType Leaf } 'RESULT_TIMEOUT'
  $hermes.Refresh()
  if (-not $hermes.HasExited) { Wait-Process -Id $hermes.Id -Timeout 5 -ErrorAction Stop }
  $hermes.Refresh()
  if ($hermes.ExitCode -ne 0) { throw "FAKE_HERMES_FAILED:$($hermes.ExitCode)" }

  $result = Get-Content -Raw $resultPath | ConvertFrom-Json
  $appStarts = @(Get-Content $appRecord | ForEach-Object { $_ | ConvertFrom-Json })
  $threadAInputs = @($appStarts | Where-Object threadId -eq $threadA | ForEach-Object { $_.input[0].text })
  $threadBInputs = @($appStarts | Where-Object threadId -eq $threadB | ForEach-Object { $_.input[0].text })
  if (($threadAInputs -join ',') -ne 'answer-for-A') { throw 'THREAD_A_MISROUTED' }
  if (($threadBInputs -join ',') -ne 'answer-for-B') { throw 'THREAD_B_MISROUTED' }
  foreach ($start in $appStarts) {
    if (@($start.input).Count -ne 1 -or $start.input[0].type -ne 'text' -or @($start.input[0].text_elements).Count -ne 0) { throw 'THREAD_A_MISROUTED' }
  }
  if (($result.replyOrder -join ',') -ne 'B,A') { throw 'THREAD_B_MISROUTED' }
  $duplicateDeliveries = @($result.events | Where-Object attempts -ne 1).Count
  if ($duplicateDeliveries -ne 0 -or @($result.events | Group-Object eventId | Where-Object Count -ne 1).Count -ne 0) { throw 'DUPLICATE_DELIVERY' }
  $historicalDeliveries = @($result.events | Where-Object summary -Like 'HISTORY-*').Count
  if ($historicalDeliveries -ne 0) { throw 'HISTORY_FLOOD' }
  foreach ($label in @('A','B')) {
    $eventId = $result.initialEventIds.$label
    $receipt = Get-Content -Raw (Join-Path $queueRoot "interactions\$eventId\receipt.json") | ConvertFrom-Json
    if ($receipt.status -ne 'APPLIED') { throw "RECEIPT_NOT_APPLIED:$label" }
  }
  if (@(Get-ChildItem -LiteralPath (Join-Path $queueRoot 'interactions') -Filter 'receipt.json' -File -Recurse).Count -ne 2) { throw 'DUPLICATE_DELIVERY' }
  foreach ($label in @('A','B')) {
    $initial = @($result.events | Where-Object summary -eq "${label}2")
    $followup = @($result.events | Where-Object summary -eq "${label}3")
    $expectedThread = if ($label -eq 'A') { $threadA } else { $threadB }
    if ($initial.Count -ne 1 -or $followup.Count -ne 1 -or $initial[0].threadId -ne $expectedThread -or $followup[0].threadId -ne $expectedThread) { throw "THREAD_${label}_MISROUTED" }
  }
  Write-Output "LOCAL_E2E: PASS events=$(@($result.events).Count) deliveries=$(@($result.events).Count) replies=2 receipts=2 restarts=1 starts=$($appStarts.Count)"
} finally {
  $cleanupProcesses = @($ownedProcesses)
  [array]::Reverse($cleanupProcesses)
  foreach ($process in $cleanupProcesses) { Stop-OwnedProcess $process }
  if ($KeepTemp) { Write-Host "LOCAL_E2E_TEMP=$root" } else { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}
