[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$TargetRoot,
    [string]$CodexHome,
    [string]$IntegrationRoot,
    [string]$QueueRoot,
    [string]$CodexCommand,
    [string[]]$AllowedWorkspaceRoots = @((Get-Location).Path),
    [ValidateSet('external','native')]
    [string]$UiRouterMode = 'external',
    [string]$SandboxRoot,
    [switch]$SkipScheduledTask
)

$ErrorActionPreference = 'Stop'
$UiRouterModeWasSpecified = $PSBoundParameters.ContainsKey('UiRouterMode')
$BridgeSource = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $BridgeSource
$taskName = 'HermesCodexBridgeV3'

function Get-CanonicalPath([string]$Path) { return [IO.Path]::GetFullPath($Path) }
function Assert-NoReparsePath([string]$Path) {
    try {
        $current = Get-CanonicalPath $Path
        while (-not [string]::IsNullOrWhiteSpace($current)) {
            if (Test-Path -LiteralPath $current) {
                $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SAFETY_REPARSE_POINT' }
            }
            $parent = Split-Path -Parent $current
            if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) { break }
            $current = $parent
        }
    } catch {
        if ($_.Exception.Message -eq 'SAFETY_REPARSE_POINT') { throw 'SAFETY_REPARSE_POINT' }
        throw 'SAFETY_PATH_INSPECTION'
    }
}
function Assert-NoReparseTree([string]$Root) {
    Assert-NoReparsePath $Root
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    try {
        $pending = [Collections.Generic.Stack[string]]::new()
        $pending.Push((Get-CanonicalPath $Root))
        while ($pending.Count -gt 0) {
            $directory = $pending.Pop()
            foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SAFETY_REPARSE_POINT' }
                if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            }
        }
    } catch {
        if ($_.Exception.Message -eq 'SAFETY_REPARSE_POINT') { throw 'SAFETY_REPARSE_POINT' }
        throw 'SAFETY_PATH_INSPECTION'
    }
}
function Test-EqualPath([string]$Left, [string]$Right) {
    return [string]::Equals((Get-CanonicalPath $Left), (Get-CanonicalPath $Right), [StringComparison]::OrdinalIgnoreCase)
}
function Test-TaskAction($Task, [string]$Execute, [string]$Arguments) {
    $actions = @($Task.Actions)
    return $actions.Count -eq 1 -and (Test-EqualPath $actions[0].Execute $Execute) -and
        [string]::Equals([string]$actions[0].Arguments, $Arguments, [StringComparison]::Ordinal)
}
function Read-OwnedManifest([string]$ManifestPath, [string]$ExpectedTarget, [string]$ExpectedCodex,
    [string]$ExpectedState, [string]$ExpectedExecute, [string]$ExpectedArguments) {
    try {
        if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'invalid' }
        if ((Get-Item -LiteralPath $ManifestPath).Length -gt 16384) { throw 'invalid' }
        $value = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
        if ($value.schema -ne 'hermes-codex-windows-install-manifest/v3' -or
            -not (Test-EqualPath $value.targetRoot $ExpectedTarget) -or
            -not (Test-EqualPath $value.codexHome $ExpectedCodex) -or
            -not (Test-EqualPath $value.stateRoot $ExpectedState) -or
            $value.scheduledTask.name -ne $taskName -or
            -not (Test-EqualPath $value.scheduledTask.execute $ExpectedExecute) -or
            -not [string]::Equals([string]$value.scheduledTask.arguments, $ExpectedArguments, [StringComparison]::Ordinal)) { throw 'invalid' }
        return $value
    } catch { throw 'INSTALL_OWNERSHIP_CONFLICT' }
}

if ($SandboxRoot) {
    if (-not [IO.Path]::IsPathFullyQualified($SandboxRoot)) { throw 'SAFETY_SANDBOX_ABSOLUTE' }
    $SandboxRoot = Get-CanonicalPath $SandboxRoot
    $TargetRoot = Join-Path $SandboxRoot 'runtime'
    $CodexHome = Join-Path $SandboxRoot 'codex'
    $IntegrationRoot = Join-Path $SandboxRoot 'integration'
    $QueueRoot = Join-Path $SandboxRoot 'queue\bridge\v3'
    $AllowedWorkspaceRoots = @((Join-Path $SandboxRoot 'workspace'))
    $SkipScheduledTask = $true
}
if (-not $SandboxRoot) {
    if ([string]::IsNullOrWhiteSpace($IntegrationRoot)) { throw 'CONFIG_INTEGRATION_ROOT_REQUIRED' }
    if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'CONFIG_LOCALAPPDATA_REQUIRED' }
        $TargetRoot = Join-Path $env:LOCALAPPDATA 'HermesCodexBridge'
    }
    if ([string]::IsNullOrWhiteSpace($CodexHome)) {
        if ($env:CODEX_HOME) { $CodexHome = $env:CODEX_HOME }
        elseif ($HOME) { $CodexHome = Join-Path $HOME '.codex' }
        else { throw 'CONFIG_CODEX_HOME_REQUIRED' }
    }
}
if (-not $QueueRoot) { $QueueRoot = Join-Path $IntegrationRoot 'Queue\bridge\v3' }
$StateRoot = if ($SandboxRoot) { Join-Path $SandboxRoot 'state' } else { Join-Path $TargetRoot 'state' }
$WindowsTarget = Join-Path $IntegrationRoot 'v3\windows'
$protocolTarget = if ($SandboxRoot) { Join-Path $SandboxRoot 'queue\protocol\v3' } else { Join-Path $IntegrationRoot 'Queue\protocol\v3' }
$hermesTarget = Join-Path $IntegrationRoot 'v3\hermes'
$paths = @($TargetRoot, $CodexHome, $IntegrationRoot, $QueueRoot, $StateRoot, $WindowsTarget, $protocolTarget, $hermesTarget) + $AllowedWorkspaceRoots
if ($paths | Where-Object { -not [IO.Path]::IsPathFullyQualified($_) }) { throw 'SAFETY_ABSOLUTE_PATH_REQUIRED' }
$TargetRoot = Get-CanonicalPath $TargetRoot
$CodexHome = Get-CanonicalPath $CodexHome
$IntegrationRoot = Get-CanonicalPath $IntegrationRoot
$QueueRoot = Get-CanonicalPath $QueueRoot
$StateRoot = Get-CanonicalPath $StateRoot
$WindowsTarget = Get-CanonicalPath $WindowsTarget
$protocolTarget = Get-CanonicalPath $protocolTarget
$hermesTarget = Get-CanonicalPath $hermesTarget
$AllowedWorkspaceRoots = @($AllowedWorkspaceRoots | ForEach-Object { Get-CanonicalPath $_ })
if (-not $QueueRoot.EndsWith([IO.Path]::Combine('Queue', 'bridge', 'v3'), [StringComparison]::OrdinalIgnoreCase)) { throw 'SAFETY_QUEUE_BOUNDARY' }

# Resolve every executable and validate every source before the first mutation, including WhatIf.
$node = (Get-Command node.exe -ErrorAction Stop).Source
if (-not $CodexCommand) { $CodexCommand = if ($SandboxRoot) { $node } else { (Get-Command codex.exe -ErrorAction Stop).Source } }
if (-not [IO.Path]::IsPathFullyQualified($CodexCommand)) { throw 'SAFETY_CODEX_COMMAND_ABSOLUTE' }
$CodexCommand = Get-CanonicalPath $CodexCommand
if (-not (Test-Path -LiteralPath $CodexCommand -PathType Leaf)) { throw 'SAFETY_CODEX_COMMAND_MISSING' }

$ProtocolSource = Join-Path $RepoRoot 'protocol\v3'
$HermesSource = Join-Path $RepoRoot 'hermes'
$runtimeFiles = @('app-server-client.mjs','atomic-store.mjs','candidate-store.mjs','cli.mjs','codex-command-resolver.mjs','contracts.mjs','event-publisher.mjs','final-identity.mjs','hook-adapter.mjs','hook-installer.mjs','hook-launcher.mjs','ledger.mjs','notification-gate.mjs','policy.mjs','redaction.mjs','reply-dispatcher.mjs','rollout-parser.mjs','service.mjs','session-watcher.mjs','thread-driver.mjs','ui-action-store.mjs','ui-router-cli.mjs','ui-router-health.mjs','windows-presence.mjs')
$scriptFiles = @('Get-WindowsPresence.ps1','Install-Bridge.ps1','Uninstall-Bridge.ps1')
$protocolFiles = @('PROTOCOL.md','protocol.json','schemas\delivery.schema.json','schemas\event.schema.json','schemas\receipt.schema.json','schemas\reply.schema.json')
$hermesFiles = @('__init__.py','contracts.py','doctor.py','inbound.py','telegram.py','watcher.py','test_contracts.py','test_doctor.py','test_inbound.py','test_install_scripts.py','test_watcher.py','HERMES_INSTALL_PROMPT.md','templates\hermes-codex-bridge.service.in','templates\SKILL.md.in','scripts\install.sh','scripts\uninstall.sh')
$requiredSources = @((Join-Path $BridgeSource 'package.json'), (Join-Path $BridgeSource 'assets\UI_ROUTER_PROMPT.md')) +
    @($runtimeFiles | ForEach-Object { Join-Path $BridgeSource "src\$_" }) +
    @($scriptFiles | ForEach-Object { Join-Path $PSScriptRoot $_ }) +
    @($protocolFiles | ForEach-Object { Join-Path $ProtocolSource $_ }) +
    @($hermesFiles | ForEach-Object { Join-Path $HermesSource $_ })
foreach ($source in $requiredSources) { if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'SOURCE_MISSING' } }

$configPath = Join-Path $TargetRoot 'config.json'
$manifestPath = Join-Path $TargetRoot 'install-manifest.json'
$hooksPath = Join-Path $CodexHome 'hooks.json'
$taskArguments = ('"{0}" run --config "{1}"' -f (Join-Path $TargetRoot 'src\cli.mjs'), $configPath)
foreach ($ownedPath in @($TargetRoot, $StateRoot, $CodexHome, $hooksPath, $manifestPath, $WindowsTarget, $protocolTarget, $hermesTarget, $QueueRoot) + $AllowedWorkspaceRoots) {
    Assert-NoReparsePath $ownedPath
}
foreach ($ownedTree in @($TargetRoot, $StateRoot, $WindowsTarget, $protocolTarget, $hermesTarget)) { Assert-NoReparseTree $ownedTree }
$targetExisted = Test-Path -LiteralPath $TargetRoot -PathType Container
if (Test-Path -LiteralPath $TargetRoot) {
    if (-not $targetExisted) { throw 'INSTALL_OWNERSHIP_CONFLICT' }
    $null = Read-OwnedManifest $manifestPath $TargetRoot $CodexHome $StateRoot $node $taskArguments
}
$existingTask = $null
$taskWasRunning = $false
if (-not $SkipScheduledTask) {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask -and -not (Test-TaskAction $existingTask $node $taskArguments)) { throw 'INSTALL_TASK_OWNERSHIP_CONFLICT' }
    $taskWasRunning = $existingTask -and $existingTask.State -eq 'Running'
}

if ((-not $UiRouterModeWasSpecified) -and $targetExisted -and (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    try { $existingMode = (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).uiRouterMode; if ($existingMode -in @('external','native')) { $UiRouterMode = $existingMode } } catch { }
}
$config = [ordered]@{
    schema = 'hermes-codex-bridge-config/v3'; queueRoot = $QueueRoot; codexHome = $CodexHome
    codexCommand = $CodexCommand; stateRoot = $StateRoot; allowedWorkspaceRoots = $AllowedWorkspaceRoots
    pollMinMs = 1000; pollMaxMs = 1500; replyTtlSeconds = 604800; approvalTtlSeconds = 43200; uiRouterMode = $UiRouterMode
}
$manifest = [ordered]@{
    schema = 'hermes-codex-windows-install-manifest/v3'; targetRoot = $TargetRoot; codexHome = $CodexHome; stateRoot = $StateRoot
    scheduledTask = [ordered]@{ name = $taskName; execute = (Get-CanonicalPath $node); arguments = $taskArguments }
}

function Invoke-Mutation([string]$Label, [scriptblock]$Action) {
    Write-Host "TARGET: $Label"
    if ($PSCmdlet.ShouldProcess($Label)) { & $Action }
}
if ($WhatIfPreference) {
    foreach ($label in @('runtime','codex-home','queue','state','integration-windows','protocol','integration-hermes','ownership-manifest')) { Invoke-Mutation $label { } }
    if (-not $SkipScheduledTask) { Invoke-Mutation "ScheduledTask:$taskName" { } }
    Write-Host 'INSTALL_PLAN_OK'
    exit 0
}

$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ('.hc3-windows-install-' + [guid]::NewGuid().ToString('N'))
$taskCreated = $false
$backups = @{}
function Backup-Path([string]$Name, [string]$Path) {
    Assert-NoReparsePath $Path
    Assert-NoReparseTree $Path
    $exists = Test-Path -LiteralPath $Path
    $backups[$Name] = [ordered]@{ path = $Path; existed = $exists; backup = (Join-Path $stageRoot $Name) }
    if ($exists) { Copy-Item -LiteralPath $Path -Destination $backups[$Name].backup -Recurse -Force }
}
function Restore-Path($Entry) {
    Assert-NoReparsePath $Entry.path
    Assert-NoReparseTree $Entry.path
    if (Test-Path -LiteralPath $Entry.path) { Remove-Item -LiteralPath $Entry.path -Recurse -Force }
    if ($Entry.existed) { Copy-Item -LiteralPath $Entry.backup -Destination $Entry.path -Recurse -Force }
}
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
foreach ($pair in @(@('runtime',$TargetRoot), @('state',$StateRoot), @('windows',$WindowsTarget), @('protocol',$protocolTarget), @('hermes',$hermesTarget), @('hooks',$hooksPath))) { Backup-Path $pair[0] $pair[1] }

try {
    if ($existingTask) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
        $stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            $stoppedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            if (-not $stoppedTask -or -not (Test-TaskAction $stoppedTask $node $taskArguments)) { throw 'INSTALL_TASK_OWNERSHIP_CONFLICT' }
            if ($stoppedTask.State -ne 'Running') { break }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $stopDeadline)
        if ($stoppedTask.State -eq 'Running') { throw 'INSTALL_TASK_STOP_TIMEOUT' }
    }
    foreach ($ownedPath in @($TargetRoot, $StateRoot, $CodexHome, $hooksPath, $manifestPath, $WindowsTarget, $protocolTarget, $hermesTarget, $QueueRoot) + $AllowedWorkspaceRoots) { Assert-NoReparsePath $ownedPath }
    foreach ($ownedTree in @($TargetRoot, $StateRoot, $WindowsTarget, $protocolTarget, $hermesTarget)) { Assert-NoReparseTree $ownedTree }
    foreach ($directory in @($TargetRoot, (Join-Path $TargetRoot 'src'), (Join-Path $TargetRoot 'scripts'), $CodexHome, (Join-Path $CodexHome 'sessions'), $QueueRoot, (Join-Path $QueueRoot 'interactions'), $StateRoot, $IntegrationRoot, $WindowsTarget) + $AllowedWorkspaceRoots) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    foreach ($name in $runtimeFiles) { Copy-Item -LiteralPath (Join-Path $BridgeSource "src\$name") -Destination (Join-Path $TargetRoot "src\$name") -Force }
    foreach ($name in $scriptFiles) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $TargetRoot "scripts\$name") -Force }
    Copy-Item -LiteralPath (Join-Path $BridgeSource 'package.json') -Destination (Join-Path $TargetRoot 'package.json') -Force
    foreach ($name in @('ui-router-cli.mjs','ui-action-store.mjs','atomic-store.mjs','contracts.mjs')) { Copy-Item -LiteralPath (Join-Path $BridgeSource "src\$name") -Destination (Join-Path $WindowsTarget $name) -Force }
    Copy-Item -LiteralPath (Join-Path $BridgeSource 'assets\UI_ROUTER_PROMPT.md') -Destination (Join-Path $WindowsTarget 'UI_ROUTER_PROMPT.md') -Force

    New-Item -ItemType Directory -Path (Join-Path $protocolTarget 'schemas') -Force | Out-Null
    foreach ($name in $protocolFiles) { $destination = Join-Path $protocolTarget $name; New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null; Copy-Item -LiteralPath (Join-Path $ProtocolSource $name) -Destination $destination -Force }
    foreach ($name in $hermesFiles) { $destination = Join-Path $hermesTarget $name; New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null; Copy-Item -LiteralPath (Join-Path $HermesSource $name) -Destination $destination -Force }

    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8
    if (-not (Test-Path -LiteralPath $hooksPath)) { '{"hooks":{}}' | Set-Content -LiteralPath $hooksPath -Encoding utf8 }
    & $node (Join-Path $TargetRoot 'src\cli.mjs') validate-config --config $configPath
    if ($LASTEXITCODE -ne 0) { throw 'CONFIG_VALIDATION_FAILED' }
    & $node (Join-Path $TargetRoot 'src\cli.mjs') install-hooks --config $configPath
    if ($LASTEXITCODE -ne 0) { throw 'HOOK_INSTALL_FAILED' }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8

    if (-not $SkipScheduledTask) {
        if (-not $existingTask) {
            $action = New-ScheduledTaskAction -Execute $node -Argument $taskArguments
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
            $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User $env:USERNAME -RunLevel Limited | Out-Null
            $taskCreated = $true
        }
        $ownedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $ownedTask -or -not (Test-TaskAction $ownedTask $node $taskArguments)) { throw 'INSTALL_TASK_OWNERSHIP_CONFLICT' }
        $healthStarted = [DateTime]::UtcNow
        Start-ScheduledTask -TaskName $taskName
        $heartbeatPath = Join-Path $StateRoot 'bridge-v3\heartbeat.json'
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        $healthy = $false
        do {
            if (Test-Path -LiteralPath $heartbeatPath -PathType Leaf) {
                try {
                    $heartbeat = Get-Content -LiteralPath $heartbeatPath -Raw | ConvertFrom-Json
                    $observed = [DateTime]::Parse($heartbeat.observed_at).ToUniversalTime()
                    $healthy = $heartbeat.schema -eq 'hermes-codex-bridge-heartbeat/v3' -and $heartbeat.status -eq 'ok' -and $observed -ge $healthStarted.AddSeconds(-2)
                } catch { $healthy = $false }
            }
            if (-not $healthy) { Start-Sleep -Milliseconds 250 }
        } while (-not $healthy -and [DateTime]::UtcNow -lt $deadline)
        if (-not $healthy) { throw 'INSTALL_HEALTH_TIMEOUT' }
    }
} catch {
    $code = $_.Exception.Message
    $rollbackFailed = $false
    if (-not $SkipScheduledTask) {
        try {
            $rollbackTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            if ($rollbackTask) {
                if (-not (Test-TaskAction $rollbackTask $node $taskArguments)) { throw 'ownership changed' }
                Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
                if ($taskCreated) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop }
            }
        } catch { $rollbackFailed = $true }
    }
    foreach ($name in @('hooks','hermes','protocol','windows','state','runtime')) { try { Restore-Path $backups[$name] } catch { $rollbackFailed = $true } }
    if ($existingTask -and $taskWasRunning) { try { Start-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch { $rollbackFailed = $true } }
    if ($rollbackFailed) { throw 'INSTALL_ROLLBACK' }
    if ($code -notmatch '^[A-Z0-9_]+$') { $code = 'INSTALL_TRANSACTION' }
    throw $code
} finally {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'INSTALL_OK'
