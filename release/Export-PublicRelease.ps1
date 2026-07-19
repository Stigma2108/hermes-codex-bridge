[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Destination
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedPath {
    param([Parameter(Mandatory)][string]$Path)

    $providerPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    return [System.IO.Path]::GetFullPath($providerPath).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
}

function Test-PathInsideRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Root
    )

    $prefix = $Root + [System.IO.Path]::DirectorySeparatorChar
    return $Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-DestinationPathSafe {
    param([Parameter(Mandatory)][string]$Path)

    $normalizedPath = Get-NormalizedPath $Path
    if (
        $normalizedPath.Equals($sourceRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Test-PathInsideRoot -Path $normalizedPath -Root $sourceRoot)
    ) {
        throw 'EXPORT_DESTINATION_INSIDE_SOURCE'
    }

    $currentPath = $normalizedPath
    while ($currentPath) {
        if (Test-Path -LiteralPath $currentPath) {
            $item = Get-Item -LiteralPath $currentPath -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "EXPORT_DESTINATION_REPARSE_POINT:$currentPath"
            }
        }

        $parent = [System.IO.Directory]::GetParent($currentPath)
        if ($null -eq $parent -or $parent.FullName -eq $currentPath) {
            break
        }
        $currentPath = $parent.FullName
    }
}

function Assert-SourcePathSafe {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Entry
    )

    $currentPath = Get-NormalizedPath $Path
    while ($currentPath) {
        if (Test-Path -LiteralPath $currentPath) {
            $item = Get-Item -LiteralPath $currentPath -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "EXPORT_REPARSE_POINT:$Entry"
            }
        }

        if ($currentPath.Equals($sourceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }

        $parent = [System.IO.Directory]::GetParent($currentPath)
        if (
            $null -eq $parent -or
            (
                -not $parent.FullName.Equals($sourceRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
                -not (Test-PathInsideRoot -Path $parent.FullName -Root $sourceRoot)
            )
        ) {
            throw "EXPORT_MANIFEST_ENTRY_INVALID:$Entry"
        }
        $currentPath = $parent.FullName
    }
}

$sourceRoot = Get-NormalizedPath (Join-Path $PSScriptRoot '..')
$destinationRoot = Get-NormalizedPath $Destination

Assert-DestinationPathSafe -Path $destinationRoot

if (Test-Path -LiteralPath $destinationRoot) {
    $destinationItem = Get-Item -LiteralPath $destinationRoot -Force
    if (-not $destinationItem.PSIsContainer -or (Get-ChildItem -LiteralPath $destinationRoot -Force | Select-Object -First 1)) {
        throw 'EXPORT_DESTINATION_NOT_EMPTY'
    }
}
else {
    $null = New-Item -ItemType Directory -Path $destinationRoot -Force
}
Assert-DestinationPathSafe -Path $destinationRoot

$manifestPath = Join-Path $PSScriptRoot 'public-files.txt'
$entries = Get-Content -LiteralPath $manifestPath | ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') }

$validatedEntries = foreach ($entry in $entries) {
    $invalid = [System.IO.Path]::IsPathRooted($entry)
    $segments = [System.Text.RegularExpressions.Regex]::Split($entry, '[\\/]')
    if ($segments.Count -eq 0) {
        $invalid = $true
    }
    foreach ($segment in $segments) {
        if (
            [string]::IsNullOrEmpty($segment) -or $segment -eq '.' -or $segment -eq '..' -or
            $segment.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
            $segment.EndsWith('.') -or $segment.EndsWith(' ')
        ) {
            $invalid = $true
            break
        }
    }

    if (-not $invalid) {
        try {
            $sourcePath = Get-NormalizedPath (Join-Path $sourceRoot $entry)
            $destinationPath = Get-NormalizedPath (Join-Path $destinationRoot $entry)
            if (
                -not (Test-PathInsideRoot -Path $sourcePath -Root $sourceRoot) -or
                -not (Test-PathInsideRoot -Path $destinationPath -Root $destinationRoot)
            ) {
                $invalid = $true
            }
        }
        catch {
            $invalid = $true
        }
    }

    if ($invalid) {
        throw "EXPORT_MANIFEST_ENTRY_INVALID:$entry"
    }

    [pscustomobject]@{
        Entry = $entry
        SourcePath = $sourcePath
        DestinationPath = $destinationPath
    }
}

foreach ($validatedEntry in $validatedEntries) {
    $entry = $validatedEntry.Entry
    $sourcePath = $validatedEntry.SourcePath
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        throw "EXPORT_SOURCE_MISSING:$entry"
    }

    Assert-SourcePathSafe -Path $sourcePath -Entry $entry

    $destinationPath = $validatedEntry.DestinationPath
    $destinationParent = Split-Path -Parent $destinationPath
    if (-not (Test-Path -LiteralPath $destinationParent)) {
        $null = New-Item -ItemType Directory -Path $destinationParent -Force
    }

    Assert-DestinationPathSafe -Path $destinationPath
    Assert-SourcePathSafe -Path $sourcePath -Entry $entry
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Recurse -Force
}

Write-Output "PUBLIC_EXPORT_OK:$destinationRoot"
