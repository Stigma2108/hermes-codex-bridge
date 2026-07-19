[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Root
)

$ErrorActionPreference = 'Stop'

$rootPath = (Resolve-Path -LiteralPath $Root).ProviderPath
$rootPath = [System.IO.Path]::GetFullPath($rootPath).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
)
$pathPattern = '(?:^|/)(?:(?:Queue|state|handoff|\.git)(?:/|$)|docs/superpowers(?:/|$)|(?:event|reply|delivery|receipt|approval|acceptance)\.json$)'
$privateLiteralTerms = @(
    ('test-ai-second-' + 'brain-vault')
    ('C:\Users\' + 'stigm')
    ('D:\' + 'Tools')
    ('D:\' + 'Project')
    ('Knot' + 'Guide')
)
$privateTerms = @($privateLiteralTerms | ForEach-Object { [regex]::Escape($_) }) +
    @('-----' + 'BEGIN [^-\r\n]*PRIVATE KEY(?: BLOCK)?-----')
$privateContentPattern = '(?:' + ($privateTerms -join '|') + ')'
$maxContentBytes = 16MB
$violations = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$scanErrors = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$directories = [System.Collections.Generic.Queue[System.IO.DirectoryInfo]]::new()
$rootItem = Get-Item -LiteralPath $rootPath -Force

if (-not $rootItem.PSIsContainer) {
    throw "PUBLIC_EXPORT_ROOT_NOT_DIRECTORY:$rootPath"
}

if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    $null = $violations.Add('.')
}
else {
    $directories.Enqueue($rootItem)
}

while ($directories.Count -gt 0) {
    $directory = $directories.Dequeue()
    try {
        $children = Get-ChildItem -LiteralPath $directory.FullName -Force
    }
    catch {
        $directoryPath = [System.IO.Path]::GetRelativePath($rootPath, $directory.FullName).Replace('\', '/')
        $null = $scanErrors.Add($directoryPath)
        continue
    }

    foreach ($child in $children) {
        $relativePath = [System.IO.Path]::GetRelativePath($rootPath, $child.FullName).Replace('\', '/')
        $isReparsePoint = ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0

        if ($isReparsePoint) {
            $null = $violations.Add($relativePath)
            continue
        }

        $isSyntheticQueueExample = $relativePath.Equals('examples/queue', [System.StringComparison]::OrdinalIgnoreCase) -or
            $relativePath.StartsWith('examples/queue/', [System.StringComparison]::OrdinalIgnoreCase)
        if (-not $isSyntheticQueueExample -and $relativePath -match $pathPattern) {
            $null = $violations.Add($relativePath)
            if ($child.PSIsContainer) {
                continue
            }
        }

        if ($child.PSIsContainer) {
            $directories.Enqueue($child)
            continue
        }

        $stream = $null
        $memory = $null
        $bytes = $null
        $readFailed = $false
        $oversized = $false
        try {
            $stream = [System.IO.File]::Open(
                $child.FullName,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::Read
            )
            if ($stream.Length -gt $maxContentBytes) {
                $oversized = $true
            }
            else {
                $memory = [System.IO.MemoryStream]::new()
                $buffer = [byte[]]::new(81920)
                while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    if ($memory.Length + $count -gt $maxContentBytes) {
                        $oversized = $true
                        break
                    }
                    $memory.Write($buffer, 0, $count)
                }
                if (-not $oversized) {
                    $bytes = $memory.ToArray()
                }
            }
        }
        catch {
            $readFailed = $true
        }
        finally {
            if ($null -ne $memory) {
                $memory.Dispose()
            }
            if ($null -ne $stream) {
                $stream.Dispose()
            }
        }

        if ($readFailed -or $oversized) {
            $null = $scanErrors.Add($relativePath)
            continue
        }

        if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xff -and $bytes[1] -eq 0xfe) {
            $content = [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
        }
        elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xfe -and $bytes[1] -eq 0xff) {
            $content = [System.Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
        }
        elseif ($bytes -contains 0) {
            continue
        }
        else {
            $content = [System.Text.Encoding]::UTF8.GetString($bytes)
        }

        if ($content -match $privateContentPattern) {
            $null = $violations.Add($relativePath)
        }
    }
}

if ($violations.Count -gt 0 -or $scanErrors.Count -gt 0) {
    foreach ($path in ($violations | Sort-Object)) {
        Write-Output "PUBLIC_EXPORT_AUDIT_VIOLATION:$path"
    }
    foreach ($path in ($scanErrors | Sort-Object)) {
        Write-Output "PUBLIC_EXPORT_AUDIT_SCAN_ERROR:$path"
    }
    exit 1
}

Write-Output 'PUBLIC_EXPORT_AUDIT_OK'
