[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SharedRoot,
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } elseif ($HOME) { Join-Path $HOME '.codex' }),
    [string]$NodeCommand = 'node',
    [string]$CodexCommand = 'codex.exe',
    [string]$SyncthingCommand = 'syncthing.exe',
    [string]$SyncthingProcessName = 'syncthing',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

function New-Check([string]$Status, [string]$Code) {
    [ordered]@{ status = $Status; code = $Code }
}

function Resolve-AvailableCommand([string]$Command) {
    if ([string]::IsNullOrWhiteSpace($Command)) { return $null }
    if ([IO.Path]::IsPathFullyQualified($Command)) {
        if (Test-Path -LiteralPath $Command -PathType Leaf) { return [IO.Path]::GetFullPath($Command) }
        return $null
    }
    try { return (Get-Command $Command -CommandType Application -ErrorAction Stop).Source } catch { return $null }
}

$checks = [ordered]@{}
$checks.powerShell = if ($PSVersionTable.PSVersion.Major -ge 7) { New-Check ok 'PREREQ_POWERSHELL_OK' } else { New-Check error 'PREREQ_POWERSHELL_VERSION' }

$resolvedNode = Resolve-AvailableCommand $NodeCommand
if (-not $resolvedNode) {
    $checks.node = New-Check error 'PREREQ_NODE_MISSING'
} else {
    try {
        $versionText = (& $resolvedNode --version 2>$null | Select-Object -First 1)
        $version = if ($versionText -match '^v?(\d+)\.') { [int]$Matches[1] } else { 0 }
        $checks.node = if ($version -ge 24) { New-Check ok 'PREREQ_NODE_OK' } else { New-Check error 'PREREQ_NODE_VERSION' }
    } catch { $checks.node = New-Check error 'PREREQ_NODE_VERSION' }
}

$checks.codex = if (Resolve-AvailableCommand $CodexCommand) { New-Check ok 'PREREQ_CODEX_OK' } else { New-Check error 'PREREQ_CODEX_MISSING' }
$checks.codexHome = if ($CodexHome -and [IO.Path]::IsPathFullyQualified($CodexHome) -and (Test-Path -LiteralPath $CodexHome -PathType Container)) { New-Check ok 'PREREQ_CODEX_HOME_OK' } else { New-Check error 'PREREQ_CODEX_HOME_INVALID' }
$sharedRootValid = $SharedRoot -and [IO.Path]::IsPathFullyQualified($SharedRoot) -and (Test-Path -LiteralPath $SharedRoot -PathType Container)
$checks.sharedRoot = if ($sharedRootValid) { New-Check ok 'PREREQ_SHARED_ROOT_OK' } else { New-Check error 'PREREQ_SHARED_ROOT_INVALID' }
$resolvedSyncthing = Resolve-AvailableCommand $SyncthingCommand
$syncthingRunning = $false
if (-not $resolvedSyncthing -and -not [string]::IsNullOrWhiteSpace($SyncthingProcessName)) {
    try {
        $syncthingProcesses = @([Diagnostics.Process]::GetProcessesByName($SyncthingProcessName))
        $syncthingRunning = $syncthingProcesses.Count -gt 0
        foreach ($process in $syncthingProcesses) { $process.Dispose() }
    } catch { $syncthingRunning = $false }
}
$checks.syncthing = if ($resolvedSyncthing) { New-Check ok 'PREREQ_SYNCTHING_COMMAND_OK' } elseif ($syncthingRunning) { New-Check ok 'PREREQ_SYNCTHING_PROCESS_OK' } else { New-Check error 'PREREQ_SYNCTHING_MISSING' }

$checks.writeAccess = New-Check skipped 'PREREQ_WRITE_NOT_RUN'
if ($sharedRootValid) {
    $probe = Join-Path ([IO.Path]::GetFullPath($SharedRoot)) ('.hc3-prerequisite-{0}.probe' -f [guid]::NewGuid())
    try {
        $bytes = [Text.Encoding]::ASCII.GetBytes("health`n")
        $stream = [IO.File]::Open($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Remove-Item -LiteralPath $probe -Force
        $checks.writeAccess = New-Check ok 'PREREQ_WRITE_OK'
    } catch {
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        $checks.writeAccess = New-Check error 'PREREQ_WRITE_FAILED'
    }
}

$healthy = @($checks.Values | Where-Object status -eq 'error').Count -eq 0
$report = [ordered]@{ schema = 'hermes-codex-prerequisites/v3'; healthy = $healthy; checks = $checks }
if ($Json) { $report | ConvertTo-Json -Depth 4 -Compress }
else {
    Write-Output $(if ($healthy) { 'PREREQUISITES_OK' } else { 'PREREQUISITES_UNHEALTHY' })
    foreach ($check in $checks.Values) { Write-Output $check.code }
}
if (-not $healthy) { exit 3 }
