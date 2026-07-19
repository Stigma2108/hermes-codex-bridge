[CmdletBinding()]
param(
  [Parameter()]
  [string]$Root = (Join-Path $PSScriptRoot '..')
)

$ErrorActionPreference = 'Stop'
$maximumFileBytes = 16MB
$violations = [System.Collections.Generic.List[string]]::new()

function Add-Violation([string]$Code, [string]$Path) {
  $normalized = if ([string]::IsNullOrWhiteSpace($Path)) { '<repository>' } else { $Path.Replace('\', '/') }
  $violations.Add("$Code`:$normalized")
}

function Test-ExplicitPlaceholder([string]$Value) {
  if ($Value -match '(?i)(?:example|placeholder|change[_-]?me|replace[_-]?me|redacted|dummy|synthetic|your[_-])') { return $true }
  if ($Value -match '(?i)abcdefghijklmnopqrstuvwxyz') { return $true }
  if ($Value -match '^([A-Za-z0-9])\1{15,}$') { return $true }
  return $false
}

function Get-Text([byte[]]$Bytes) {
  if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xff -and $Bytes[1] -eq 0xfe) {
    return [Text.Encoding]::Unicode.GetString($Bytes, 2, $Bytes.Length - 2)
  }
  if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xfe -and $Bytes[1] -eq 0xff) {
    return [Text.Encoding]::BigEndianUnicode.GetString($Bytes, 2, $Bytes.Length - 2)
  }
  if ($Bytes -contains 0) { return $null }
  try {
    return [Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
  } catch [Text.DecoderFallbackException] {
    return $null
  }
}

function Test-ReparseChain([string]$RepositoryRoot, [string]$RelativePath) {
  $current = $RepositoryRoot
  foreach ($part in ($RelativePath -split '/')) {
    $current = Join-Path $current $part
    if (-not (Test-Path -LiteralPath $current)) { continue }
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $null -ne $item.LinkType) { return $true }
  }
  return $false
}

try {
  $repositoryRoot = (Resolve-Path -LiteralPath $Root).Path
} catch {
  Write-Output 'REPOSITORY_SAFETY_ROOT:<repository>'
  exit 1
}

$trackedOutput = & git -C $repositoryRoot -c core.quotepath=false ls-files --stage 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Output 'REPOSITORY_SAFETY_GIT:<repository>'
  exit 1
}

$tracked = [System.Collections.Generic.List[object]]::new()
foreach ($line in $trackedOutput) {
  if ($line -notmatch '^(?<mode>\d{6}) [0-9a-f]{40,64} \d+\t(?<path>.+)$') {
    Add-Violation 'REPOSITORY_SAFETY_GIT_RECORD' '<repository>'
    continue
  }
  $tracked.Add([pscustomobject]@{ Mode = $Matches.mode; Path = $Matches.path.Replace('\', '/') })
}

$credentialPatterns = @(
  '(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])',
  '(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,255}(?![A-Za-z0-9_])',
  '(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])',
  '(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])',
  '(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{20,255}(?![A-Za-z0-9_-])',
  '(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{32,255}(?![A-Za-z0-9_-])'
)

foreach ($entry in $tracked) {
  $relativePath = $entry.Path
  if ($entry.Mode -eq '120000' -or (Test-ReparseChain $repositoryRoot $relativePath)) {
    Add-Violation 'REPOSITORY_SAFETY_REPARSE' $relativePath
    continue
  }

  $isFixture = $relativePath -match '^(?:(?:bridge/)?tests/fixtures/|examples/queue/)'
  if (-not $isFixture -and (
      $relativePath -match '(?i)(^|/)(?:Queue|state)(/|$)' -or
      $relativePath -match '(?i)(^|/)(?:heartbeat|cursor|ledger|runtime-state)(?:[-_.][^/]*)?\.(?:json|jsonl)$'
    )) {
    Add-Violation 'REPOSITORY_SAFETY_RUNTIME_PATH' $relativePath
    continue
  }

  $fullPath = Join-Path $repositoryRoot ($relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar))
  try {
    $item = Get-Item -LiteralPath $fullPath -Force
    if (-not $item.PSIsContainer -and $item.Length -gt $maximumFileBytes) {
      Add-Violation 'REPOSITORY_SAFETY_SCAN_ERROR' $relativePath
      continue
    }
    if ($item.PSIsContainer) {
      Add-Violation 'REPOSITORY_SAFETY_SCAN_ERROR' $relativePath
      continue
    }
    $bytes = [IO.File]::ReadAllBytes($fullPath)
  } catch {
    Add-Violation 'REPOSITORY_SAFETY_SCAN_ERROR' $relativePath
    continue
  }

  $text = Get-Text $bytes
  if ($null -eq $text) { continue }

  if ($text -match '(?m)^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]{4,}\r?\n)+-----END [A-Z0-9 ]*PRIVATE KEY-----\s*$') {
    Add-Violation 'REPOSITORY_SAFETY_PRIVATE_KEY' $relativePath
    continue
  }

  $credentialFound = $false
  foreach ($pattern in $credentialPatterns) {
    foreach ($match in [regex]::Matches($text, $pattern)) {
      if (-not (Test-ExplicitPlaceholder $match.Value)) {
        $credentialFound = $true
        break
      }
    }
    if ($credentialFound) { break }
  }
  if ($credentialFound) { Add-Violation 'REPOSITORY_SAFETY_CREDENTIAL' $relativePath }
}

if ($violations.Count -ne 0) {
  $violations | Sort-Object -Unique | Write-Output
  exit 1
}

Write-Output 'REPOSITORY_SAFETY_OK'
