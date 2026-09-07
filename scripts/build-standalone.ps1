param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$Package = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = $Package.version
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.-]*$') {
    throw "Invalid release version: $Version"
}

$ReleaseRoot = Join-Path $RepoRoot "release"
$StandaloneRoot = Join-Path $ReleaseRoot "standalone"
$StagingRoot = Join-Path $StandaloneRoot "Creator-Works-MCP-$Version"
$ArchivePath = Join-Path $ReleaseRoot "Creator-Works-MCP-$Version-standalone.zip"
$ServerBundle = Join-Path $ReleaseRoot "creator-works-mcp.mjs"

if (-not (Test-Path -LiteralPath $ServerBundle -PathType Leaf)) {
    throw "Standalone server bundle is missing. Run 'npm run release:server' first."
}

New-Item -ItemType Directory -Path $StandaloneRoot -Force | Out-Null
if (Test-Path -LiteralPath $StagingRoot) {
    $resolvedStaging = [System.IO.Path]::GetFullPath($StagingRoot)
    $resolvedParent = [System.IO.Path]::GetFullPath($StandaloneRoot).TrimEnd('\') + '\'
    if (-not $resolvedStaging.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean staging path outside release/standalone: $resolvedStaging"
    }
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
}
New-Item -ItemType Directory -Path $StagingRoot | Out-Null

Copy-Item -LiteralPath $ServerBundle -Destination (Join-Path $StagingRoot "creator-works-mcp.mjs")
Copy-Item -LiteralPath $ServerBundle -Destination (Join-Path $StagingRoot "banter-mcp.mjs")
$rootFiles = @(
    "setup.ps1",
    "setup.bat",
    "setup.sh",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "SECURITY.md",
    "CONTRIBUTING.md"
)
foreach ($file in $rootFiles) {
    Copy-Item -LiteralPath (Join-Path $RepoRoot $file) -Destination $StagingRoot
}
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs") -Destination (Join-Path $StagingRoot "docs") -Recurse
Copy-Item -LiteralPath (Join-Path $RepoRoot "unity-extension") -Destination (Join-Path $StagingRoot "unity-extension") -Recurse
Copy-Item -LiteralPath (Join-Path $RepoRoot "scripts\cli") -Destination (Join-Path $StagingRoot "scripts\cli") -Recurse

if (Test-Path -LiteralPath $ArchivePath) {
    Remove-Item -LiteralPath $ArchivePath -Force
}
Compress-Archive -LiteralPath $StagingRoot -DestinationPath $ArchivePath

$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("creator-works-standalone-smoke-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $TestRoot | Out-Null
try {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $TestRoot
    $ExtractedRoot = Join-Path $TestRoot (Split-Path -Leaf $StagingRoot)
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ExtractedRoot "setup.ps1") -Install
    if ($LASTEXITCODE -ne 0) {
        throw "Extracted standalone setup smoke failed with exit code $LASTEXITCODE"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ExtractedRoot "docs\compatibility.md") -PathType Leaf)) {
        throw "Standalone archive is missing docs/compatibility.md"
    }
} finally {
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($TestRoot)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTestRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}

$archive = Get-Item -LiteralPath $ArchivePath
Write-Host "Standalone release smoke passed: $($archive.FullName) ($($archive.Length) bytes)"
