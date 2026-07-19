[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$TargetRoot,
    [string]$CodexHome,
    [string]$SandboxRoot,
    [switch]$SkipScheduledTask
)

$ErrorActionPreference = 'Stop'
$partial = $false
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
    try { return [string]::Equals((Get-CanonicalPath $Left), (Get-CanonicalPath $Right), [StringComparison]::OrdinalIgnoreCase) } catch { return $false }
}
function Test-TaskAction($Task, [string]$Execute, [string]$Arguments) {
    $actions = @($Task.Actions)
    return $actions.Count -eq 1 -and (Test-EqualPath $actions[0].Execute $Execute) -and
        [string]::Equals([string]$actions[0].Arguments, $Arguments, [StringComparison]::Ordinal)
}

if ($SandboxRoot) {
    if (-not [IO.Path]::IsPathFullyQualified($SandboxRoot)) { throw 'SAFETY_SANDBOX_ABSOLUTE' }
    $SandboxRoot = Get-CanonicalPath $SandboxRoot
    $TargetRoot = Join-Path $SandboxRoot 'runtime'
    $CodexHome = Join-Path $SandboxRoot 'codex'
    $SkipScheduledTask = $true
}
if (-not $SandboxRoot) {
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
if (-not [IO.Path]::IsPathFullyQualified($TargetRoot) -or -not [IO.Path]::IsPathFullyQualified($CodexHome)) { throw 'SAFETY_ABSOLUTE_PATH_REQUIRED' }
$TargetRoot = Get-CanonicalPath $TargetRoot
$CodexHome = Get-CanonicalPath $CodexHome
if ($SandboxRoot -and -not $TargetRoot.StartsWith($SandboxRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'SAFETY_TARGET_BOUNDARY' }
$stateRoot = if ($SandboxRoot) { Get-CanonicalPath (Join-Path $SandboxRoot 'state') } else { Get-CanonicalPath (Join-Path $TargetRoot 'state') }
$configPath = Join-Path $TargetRoot 'config.json'
$manifestPath = Join-Path $TargetRoot 'install-manifest.json'
$hooksPath = Join-Path $CodexHome 'hooks.json'

foreach ($ownedPath in @($TargetRoot, $stateRoot, $CodexHome, $hooksPath, $manifestPath)) { Assert-NoReparsePath $ownedPath }
foreach ($ownedTree in @($TargetRoot, $stateRoot)) { Assert-NoReparseTree $ownedTree }

if (-not (Test-Path -LiteralPath $TargetRoot)) {
    Write-Host 'TARGET: runtime'
    Write-Host 'UNINSTALL_ALREADY_ABSENT'
    exit 0
}
if (-not (Test-Path -LiteralPath $TargetRoot -PathType Container)) { throw 'UNINSTALL_OWNERSHIP_UNVERIFIED' }

try {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or (Get-Item -LiteralPath $manifestPath).Length -gt 16384) { throw 'invalid' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 'hermes-codex-windows-install-manifest/v3' -or
        -not (Test-EqualPath $manifest.targetRoot $TargetRoot) -or
        -not (Test-EqualPath $manifest.codexHome $CodexHome) -or
        -not (Test-EqualPath $manifest.stateRoot $stateRoot) -or
        $manifest.scheduledTask.name -ne $taskName -or
        -not [IO.Path]::IsPathFullyQualified([string]$manifest.scheduledTask.execute) -or
        [string]::IsNullOrWhiteSpace([string]$manifest.scheduledTask.arguments)) { throw 'invalid' }
} catch { throw 'UNINSTALL_OWNERSHIP_UNVERIFIED' }

$ownedTask = $null
if (-not $SkipScheduledTask) {
    $ownedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($ownedTask -and -not (Test-TaskAction $ownedTask ([string]$manifest.scheduledTask.execute) ([string]$manifest.scheduledTask.arguments))) {
        throw 'UNINSTALL_TASK_OWNERSHIP_UNVERIFIED'
    }
}

function Invoke-Removal([string]$Label, [scriptblock]$Action) {
    Write-Host "TARGET: $Label"
    if ($PSCmdlet.ShouldProcess($Label)) {
        try { & $Action } catch {
            if ($_.Exception.Message -in @('SAFETY_REPARSE_POINT','SAFETY_PATH_INSPECTION')) { throw $_.Exception.Message }
            $script:partial = $true
            Write-Warning 'UNINSTALL_STEP_FAILED'
        }
    }
}

if (-not $SkipScheduledTask -and $ownedTask) {
    Write-Host "TARGET: ScheduledTask:$taskName"
    if ($PSCmdlet.ShouldProcess("ScheduledTask:$taskName")) {
        $current = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $current -or -not (Test-TaskAction $current ([string]$manifest.scheduledTask.execute) ([string]$manifest.scheduledTask.arguments))) { throw 'UNINSTALL_TASK_OWNERSHIP_UNVERIFIED' }
        Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
        $current = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $current -or -not (Test-TaskAction $current ([string]$manifest.scheduledTask.execute) ([string]$manifest.scheduledTask.arguments))) { throw 'UNINSTALL_TASK_OWNERSHIP_UNVERIFIED' }
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            $current = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            if (-not $current -or -not (Test-TaskAction $current ([string]$manifest.scheduledTask.execute) ([string]$manifest.scheduledTask.arguments))) { throw 'UNINSTALL_TASK_OWNERSHIP_UNVERIFIED' }
            if ($current.State -ne 'Running') { break }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($current.State -eq 'Running') { throw 'UNINSTALL_TASK_STOP_TIMEOUT' }
        $current = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $current -or -not (Test-TaskAction $current ([string]$manifest.scheduledTask.execute) ([string]$manifest.scheduledTask.arguments))) { throw 'UNINSTALL_TASK_OWNERSHIP_UNVERIFIED' }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    }
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node -and (Test-Path -LiteralPath (Join-Path $TargetRoot 'src\cli.mjs') -PathType Leaf) -and (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Assert-NoReparseTree $TargetRoot
    Assert-NoReparsePath $hooksPath
    Invoke-Removal 'codex-hooks' {
        & $node.Source (Join-Path $TargetRoot 'src\cli.mjs') uninstall-hooks --config $configPath
        if ($LASTEXITCODE -notin @(0, 5)) { throw 'HOOK_UNINSTALL_FAILED' }
        if ($LASTEXITCODE -eq 5) { $script:partial = $true }
    }
}
Invoke-Removal 'state' {
    Assert-NoReparseTree $stateRoot
    if (Test-Path -LiteralPath $stateRoot) { Remove-Item -LiteralPath $stateRoot -Recurse -Force }
}
Invoke-Removal 'runtime' {
    Assert-NoReparseTree $TargetRoot
    if (Test-Path -LiteralPath $TargetRoot) { Remove-Item -LiteralPath $TargetRoot -Recurse -Force }
}

if ($partial) { Write-Error 'UNINSTALL_PARTIAL' -ErrorAction Continue; $host.SetShouldExit(5); exit 5 }
Write-Host 'UNINSTALL_OK'
