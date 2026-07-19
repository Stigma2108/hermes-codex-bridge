[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$bridgeRoot = Join-Path $repoRoot 'bridge'

function Assert-LastExitCode([string]$Code) {
  if ($LASTEXITCODE -ne 0) { throw "$Code`:$LASTEXITCODE" }
}

pwsh -NoProfile -File (Join-Path $repoRoot 'tools\Test-RepositorySafety.ps1')
Assert-LastExitCode 'REPOSITORY_SAFETY_FAILED'

Push-Location $bridgeRoot
try {
  $syntaxFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $bridgeRoot 'src') -Filter '*.mjs' -File
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'e2e') -Filter '*.mjs' -File
  ) | Sort-Object FullName
  foreach ($file in $syntaxFiles) {
    node --check $file.FullName
    Assert-LastExitCode "NODE_SYNTAX_FAILED:$($file.Name)"
  }
  npm test
  Assert-LastExitCode 'NODE_TESTS_FAILED'
} finally {
  Pop-Location
}

$parseErrors = [System.Collections.Generic.List[System.Management.Automation.Language.ParseError]]::new()
$powerShellFiles = @(
  Get-ChildItem -LiteralPath (Join-Path $bridgeRoot 'scripts') -Filter '*.ps1' -File
  Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File
  Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'e2e') -Filter '*.ps1' -File
) | Sort-Object FullName -Unique
foreach ($file in $powerShellFiles) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
  foreach ($error in $errors) { $parseErrors.Add($error) }
}
if ($parseErrors.Count -ne 0) { throw "POWERSHELL_PARSE_FAILED:$($parseErrors[0].Message)" }

$diagnosticTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$diagnosticProbeRoot = [IO.Path]::GetFullPath((Join-Path $diagnosticTempRoot ("hc3-prerequisites-{0}" -f [guid]::NewGuid())))
if (-not $diagnosticProbeRoot.StartsWith($diagnosticTempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $diagnosticProbeRoot) -notlike 'hc3-prerequisites-*') {
  throw 'PREREQUISITE_DIAGNOSTIC_PATH_UNSAFE'
}
try {
  New-Item -ItemType Directory -Path $diagnosticProbeRoot | Out-Null
  $nodeCommand = (Get-Command node -ErrorAction Stop).Source
  & pwsh -NoProfile -File (Join-Path $bridgeRoot 'scripts\Test-Prerequisites.ps1') -SharedRoot $diagnosticProbeRoot -CodexHome $repoRoot -NodeCommand $nodeCommand -CodexCommand $nodeCommand -SyncthingCommand $nodeCommand -SyncthingProcessName 'hc3-process-must-not-exist' -Json | Out-Null
  Assert-LastExitCode 'PREREQUISITE_DIAGNOSTIC_FAILED'

  $runningProcessName = (Get-Process -Id $PID).ProcessName
  $processOutput = & pwsh -NoProfile -File (Join-Path $bridgeRoot 'scripts\Test-Prerequisites.ps1') -SharedRoot $diagnosticProbeRoot -CodexHome $repoRoot -NodeCommand $nodeCommand -CodexCommand $nodeCommand -SyncthingCommand 'hc3-command-must-not-exist' -SyncthingProcessName $runningProcessName -Json | Out-String
  Assert-LastExitCode 'PREREQUISITE_SYNCTHING_PROCESS_FAILED'
  if (($processOutput | ConvertFrom-Json).checks.syncthing.code -ne 'PREREQ_SYNCTHING_PROCESS_OK') { throw 'PREREQUISITE_SYNCTHING_PROCESS_CODE_FAILED' }

  $missingOutput = & pwsh -NoProfile -File (Join-Path $bridgeRoot 'scripts\Test-Prerequisites.ps1') -SharedRoot $diagnosticProbeRoot -CodexHome $repoRoot -NodeCommand $nodeCommand -CodexCommand $nodeCommand -SyncthingCommand 'hc3-command-must-not-exist' -SyncthingProcessName 'hc3-process-must-not-exist' -Json 2>&1 | Out-String
  if ($LASTEXITCODE -ne 3) { throw "PREREQUISITE_SYNCTHING_MISSING_EXIT_FAILED:$LASTEXITCODE" }
  if (($missingOutput | ConvertFrom-Json).checks.syncthing.code -ne 'PREREQ_SYNCTHING_MISSING') { throw 'PREREQUISITE_SYNCTHING_MISSING_CODE_FAILED' }

  $privateMarker = 'private-prerequisite-marker'
  $failureOutput = & pwsh -NoProfile -File (Join-Path $bridgeRoot 'scripts\Test-Prerequisites.ps1') -SharedRoot $privateMarker -CodexHome $repoRoot -NodeCommand $nodeCommand -CodexCommand $nodeCommand -SyncthingCommand $nodeCommand -Json 2>&1 | Out-String
  if ($LASTEXITCODE -ne 3) { throw "PREREQUISITE_NEGATIVE_EXIT_FAILED:$LASTEXITCODE" }
  $failureReport = $failureOutput | ConvertFrom-Json
  if ($failureReport.healthy -or $failureReport.checks.sharedRoot.code -ne 'PREREQ_SHARED_ROOT_INVALID' -or $failureOutput.Contains($privateMarker, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'PREREQUISITE_NEGATIVE_REDACTION_FAILED'
  }
} finally {
  Remove-Item -LiteralPath $diagnosticProbeRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$hadPythonSetting = Test-Path Env:PYTHONDONTWRITEBYTECODE
$previousPythonSetting = $env:PYTHONDONTWRITEBYTECODE
Push-Location $repoRoot
try {
  $env:PYTHONDONTWRITEBYTECODE = '1'
  python -m unittest discover -s hermes -p 'test_*.py' -v
  Assert-LastExitCode 'PYTHON_TESTS_FAILED'
} finally {
  if ($hadPythonSetting) { $env:PYTHONDONTWRITEBYTECODE = $previousPythonSetting } else { Remove-Item Env:PYTHONDONTWRITEBYTECODE -ErrorAction SilentlyContinue }
  Pop-Location
}

pwsh -NoProfile -File (Join-Path $PSScriptRoot 'e2e\Run-LocalBridgeE2E.ps1')
Assert-LastExitCode 'LOCAL_E2E_FAILED'

pwsh -NoProfile -File (Join-Path $PSScriptRoot 'e2e\Run-AdaptiveRoutingE2E.ps1')
Assert-LastExitCode 'ADAPTIVE_E2E_FAILED'

pwsh -NoProfile -File (Join-Path $PSScriptRoot 'e2e\Run-NativeInboundRouterE2E.ps1')
Assert-LastExitCode 'NATIVE_UI_ROUTER_E2E_FAILED'

Push-Location $repoRoot
try {
  git diff --check
  Assert-LastExitCode 'GIT_DIFF_CHECK_FAILED'
} finally {
  Pop-Location
}

Write-Output 'V3_TESTS: PASS'
