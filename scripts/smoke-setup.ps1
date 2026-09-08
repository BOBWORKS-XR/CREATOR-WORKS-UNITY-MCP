$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("creator-works-setup-smoke-" + [guid]::NewGuid())
$AppData = Join-Path $TestRoot "AppData"
$UserProfile = Join-Path $TestRoot "User"
$Project = Join-Path $TestRoot "UnityProject"
$Editor = Join-Path $Project "Assets\Editor"
$ConfigDir = Join-Path $AppData "banter-mcp"
$CurrentConfigDir = Join-Path $AppData "creator-works-mcp"
$CodexDir = Join-Path $UserProfile ".codex"
$LegacyBundleDir = Join-Path $TestRoot "LegacyServer"
$LegacyBundle = Join-Path $LegacyBundleDir "banter-mcp.mjs"

New-Item -ItemType Directory -Path $Editor, $ConfigDir, $CodexDir, $LegacyBundleDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $RepoRoot "release\creator-works-mcp.mjs") -Destination $LegacyBundle
Set-Content -LiteralPath (Join-Path $Editor "BanterMCPBridge.cs") -Value "// old bridge"
Set-Content -LiteralPath (Join-Path $CodexDir "config.toml") -Value 'model = "existing"'
Set-Content -LiteralPath (Join-Path $UserProfile ".claude.json") -Value '{"keep":true,"mcpServers":{"other":{}}}'

$config = @{
    channels = @(@{
        id = "test"
        name = "Test"
        unity_project_path = $Project
        scene_path = $null
        enabled = $true
    })
    active_channel_id = "test"
    mcp_server_path = $LegacyBundle
    auto_start = $false
    enable_custom_scripts = $false
} | ConvertTo-Json -Depth 10
Set-Content -LiteralPath (Join-Path $ConfigDir "launcher-config.json") -Value $config

$PreviousAppData = $env:APPDATA
$PreviousUserProfile = $env:USERPROFILE
try {
    $env:APPDATA = $AppData
    $env:USERPROFILE = $UserProfile
    "G`n3`n`nX`n`nC`n`nE`n`nQ`n" | powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot "setup.ps1") | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "setup.ps1 exited with code $LASTEXITCODE"
    }

    $installedHash = (Get-FileHash (Join-Path $Editor "BanterMCPBridge.cs")).Hash
    $sourceHash = (Get-FileHash (Join-Path $RepoRoot "unity-extension\Editor\BanterMCPBridge.cs")).Hash
    if ($installedHash -ne $sourceHash) {
        throw "Bridge replacement hash mismatch"
    }

    $installedLogoHash = (Get-FileHash (Join-Path $Editor "CreatorWorksMCPLogo.png")).Hash
    $sourceLogoHash = (Get-FileHash (Join-Path $RepoRoot "unity-extension\Editor\CreatorWorksMCPLogo.png")).Hash
    if ($installedLogoHash -ne $sourceLogoHash) {
        throw "Bridge logo replacement hash mismatch"
    }

    $backups = @(Get-ChildItem (Join-Path $Project ".bantworks-mcp\backups") -Filter "BanterMCPBridge-*.cs")
    if ($backups.Count -ne 1 -or (Get-Content $backups[0].FullName -Raw) -notmatch "old bridge") {
        throw "Bridge backup was not created correctly"
    }

    $codexConfig = Get-Content (Join-Path $CodexDir "config.toml") -Raw
    if ($codexConfig -notmatch 'model = "existing"' -or
        $codexConfig -notmatch '\[mcp_servers\.creator-works\]' -or
        $codexConfig -match '\[mcp_servers\.banter\]' -or
        $codexConfig -notmatch 'creator-works-mcp\.mjs' -or
        $codexConfig -notmatch 'CREATOR_WORKS_TOOL_GROUPS = "core,banter"') {
        throw "Existing Codex configuration was not preserved and updated"
    }

    $claudeConfig = Get-Content (Join-Path $UserProfile ".claude.json") -Raw | ConvertFrom-Json
    if ($claudeConfig.keep -ne $true -or
        $null -eq $claudeConfig.mcpServers.other -or
        $null -ne $claudeConfig.mcpServers.banter -or
        $claudeConfig.mcpServers.'creator-works'.args[0] -notmatch 'creator-works-mcp\.mjs$' -or
        $claudeConfig.mcpServers.'creator-works'.env.CREATOR_WORKS_TOOL_GROUPS -ne "core,banter") {
        throw "Existing Claude configuration was not preserved and updated"
    }

    if (-not (Test-Path -LiteralPath (Join-Path $CurrentConfigDir "launcher-config.json") -PathType Leaf)) {
        throw "Legacy launcher configuration was not migrated to Creator Works MCP"
    }

    $temporaryFiles = @(Get-ChildItem $TestRoot -Recurse -Force -File | Where-Object {
        $_.Name -match '^\..*\.(tmp|replace-backup)$'
    })
    if ($temporaryFiles.Count -ne 0) {
        throw "Setup left temporary files: $($temporaryFiles.FullName -join ', ')"
    }

    Write-Host "PowerShell setup smoke passed"
} finally {
    $env:APPDATA = $PreviousAppData
    $env:USERPROFILE = $PreviousUserProfile
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($TestRoot)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if (-not $resolvedTestRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing cleanup outside temp directory: $resolvedTestRoot"
    }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}
