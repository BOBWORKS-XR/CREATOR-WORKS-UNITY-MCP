# Creator Works MCP Setup Script
# Run this in PowerShell to configure Unity projects for Codex or Claude Code.

param(
    [switch]$Install,
    [switch]$AddProject,
    [switch]$ListProjects,
    [switch]$SetActive,
    [switch]$Help
)

$ConfigPath = "$env:APPDATA\creator-works-mcp\launcher-config.json"
$LegacyConfigPath = "$env:APPDATA\banter-mcp\launcher-config.json"
$ClaudeConfigPath = "$env:USERPROFILE\.claude.json"
$CodexConfigPath = "$env:USERPROFILE\.codex\config.toml"
$MCPRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$LegacyServerPath = "C:/tools/banter-mcp/dist/index.js"

function Get-DefaultServerPath {
    $candidates = @(
        (Join-Path $MCPRoot "creator-works-mcp.mjs"),
        (Join-Path $MCPRoot "release\creator-works-mcp.mjs"),
        (Join-Path $MCPRoot "banter-mcp.mjs"),
        (Join-Path $MCPRoot "release\banter-mcp.mjs"),
        (Join-Path $MCPRoot "dist\index.js")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw "MCP server was not found under $MCPRoot. Run '.\setup.ps1 -Install' first."
}

function Test-LegacyServerPath($value) {
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $false
    }
    $normalized = $value -replace "\\", "/"
    return ($normalized.Equals($LegacyServerPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($normalized).Equals("banter-mcp.mjs", [System.StringComparison]::OrdinalIgnoreCase))
}

function Normalize-ToolGroups($Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return "all"
    }

    $entries = @(($Value.ToLowerInvariant() -split ",") | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object -Unique)
    if ($entries.Count -eq 0) {
        throw "Tool groups must contain all, none, read, author, test, banter, or shadergraph."
    }
    if ($entries -contains "all" -or $entries -contains "none") {
        if ($entries.Count -ne 1) {
            throw "Tool groups cannot combine 'all' or 'none' with other groups."
        }
        return $entries[0]
    }

    $knownGroups = @("read", "author", "test", "banter", "shadergraph")
    $unknown = @($entries | Where-Object { $_ -notin $knownGroups })
    if ($unknown.Count -gt 0) {
        throw "Unknown tool groups: $($unknown -join ', '). Use all, none, read, author, test, banter, or shadergraph."
    }

    return (@($knownGroups | Where-Object { $_ -in $entries }) -join ",")
}

function Publish-AtomicFile($TemporaryPath, $Destination) {
    if (-not (Test-Path -LiteralPath $Destination)) {
        [System.IO.File]::Move($TemporaryPath, $Destination)
        return
    }

    $parent = Split-Path -Parent $Destination
    $replacementBackup = Join-Path $parent (".{0}.{1}.replace-backup" -f (Split-Path -Leaf $Destination), [guid]::NewGuid())
    $published = $false
    try {
        [System.IO.File]::Replace($TemporaryPath, $Destination, $replacementBackup)
        $published = $true
    } finally {
        if ($published -and (Test-Path -LiteralPath $replacementBackup)) {
            Remove-Item -LiteralPath $replacementBackup -Force
        }
    }
}

function Write-AtomicText($Path, $Content) {
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    $temporaryPath = Join-Path $parent (".{0}.{1}.tmp" -f (Split-Path -Leaf $Path), [guid]::NewGuid())
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $Content, [System.Text.UTF8Encoding]::new($false))
        Publish-AtomicFile $temporaryPath $Path
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function Copy-AtomicFile($Source, $Destination) {
    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    $temporaryPath = Join-Path $parent (".{0}.{1}.tmp" -f (Split-Path -Leaf $Destination), [guid]::NewGuid())
    try {
        [System.IO.File]::Copy($Source, $temporaryPath, $true)
        Publish-AtomicFile $temporaryPath $Destination
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function Ensure-ConfigDir {
    $configDir = Split-Path $ConfigPath
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }
}

function Load-Config {
    Ensure-ConfigDir
    $sourcePath = if (Test-Path $ConfigPath) { $ConfigPath } elseif (Test-Path $LegacyConfigPath) { $LegacyConfigPath } else { $null }
    if ($sourcePath) {
        $config = Get-Content $sourcePath | ConvertFrom-Json
        $configuredServer = $config.mcp_server_path
        if ([string]::IsNullOrWhiteSpace($configuredServer) -or (Test-LegacyServerPath $configuredServer)) {
            $defaultServer = Get-DefaultServerPath
            if ($null -eq $config.PSObject.Properties["mcp_server_path"]) {
                $config | Add-Member -NotePropertyName "mcp_server_path" -NotePropertyValue $defaultServer
            } else {
                $config.mcp_server_path = $defaultServer
            }
        }
        $toolGroups = Normalize-ToolGroups $config.tool_groups
        if ($null -eq $config.PSObject.Properties["tool_groups"]) {
            $config | Add-Member -NotePropertyName "tool_groups" -NotePropertyValue $toolGroups
        } else {
            $config.tool_groups = $toolGroups
        }
        if ($sourcePath -eq $LegacyConfigPath) {
            Write-AtomicText $ConfigPath ($config | ConvertTo-Json -Depth 10)
        }
        return $config
    }
    return @{
        channels = @()
        active_channel_id = $null
        mcp_server_path = Get-DefaultServerPath
        tool_groups = "all"
        auto_start = $false
        enable_custom_scripts = $false
    }
}

function Save-Config($config) {
    Ensure-ConfigDir
    if (-not (Test-Path -LiteralPath $config.mcp_server_path -PathType Leaf)) {
        throw "MCP server file does not exist: $($config.mcp_server_path)"
    }
    $config.tool_groups = Normalize-ToolGroups $config.tool_groups
    Write-AtomicText $ConfigPath ($config | ConvertTo-Json -Depth 10)
}

function Show-Menu {
    Clear-Host
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "    Creator Works MCP Configuration     " -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    $config = Load-Config

    if ($config.channels.Count -eq 0) {
        Write-Host "  No projects configured yet." -ForegroundColor Yellow
    } else {
        Write-Host "  Your Projects:" -ForegroundColor Green
        Write-Host ""
        for ($i = 0; $i -lt $config.channels.Count; $i++) {
            $channel = $config.channels[$i]
            $marker = if ($channel.id -eq $config.active_channel_id) { "[ACTIVE]" } else { "        " }
            $color = if ($channel.id -eq $config.active_channel_id) { "Green" } else { "White" }
            Write-Host "  $($i + 1). $marker $($channel.name)" -ForegroundColor $color
            Write-Host "              $($channel.unity_project_path)" -ForegroundColor DarkGray
        }
    }

    Write-Host ""
    Write-Host "----------------------------------------" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  [A] Add new project"
    Write-Host "  [S] Set active project"
    Write-Host "  [G] Set capability profile"
    Write-Host "  [R] Remove a project"
    Write-Host "  [C] Apply to Claude Code"
    Write-Host "  [X] Apply to Codex"
    Write-Host "  [E] Install Unity Extension"
    Write-Host "  [Q] Quit"
    Write-Host ""
}

function Add-Project {
    Write-Host ""
    Write-Host "Add New Project" -ForegroundColor Cyan
    Write-Host "---------------"

    $name = Read-Host "Project name"
    if ([string]::IsNullOrWhiteSpace($name)) {
        Write-Host "Cancelled." -ForegroundColor Yellow
        return
    }

    $path = Read-Host "Unity project path (e.g., E:\unity\MyProject)"
    if ([string]::IsNullOrWhiteSpace($path)) {
        Write-Host "Cancelled." -ForegroundColor Yellow
        return
    }

    # Validate path
    if (-not (Test-Path $path)) {
        Write-Host "Error: Path does not exist!" -ForegroundColor Red
        return
    }

    if (-not (Test-Path "$path\Assets")) {
        Write-Host "Error: Not a valid Unity project (no Assets folder)!" -ForegroundColor Red
        return
    }

    $config = Load-Config

    $newChannel = @{
        id = [guid]::NewGuid().ToString()
        name = $name
        unity_project_path = $path
        scene_path = $null
        enabled = $true
    }

    $config.channels += $newChannel

    # If first project, make it active
    if ($config.channels.Count -eq 1) {
        $config.active_channel_id = $newChannel.id
    }

    Save-Config $config
    Write-Host "Project added successfully!" -ForegroundColor Green
}

function Set-ActiveProject {
    $config = Load-Config

    if ($config.channels.Count -eq 0) {
        Write-Host "No projects to select!" -ForegroundColor Yellow
        return
    }

    Write-Host ""
    $selection = Read-Host "Enter project number to activate"

    try {
        $index = [int]$selection - 1
        if ($index -ge 0 -and $index -lt $config.channels.Count) {
            $config.active_channel_id = $config.channels[$index].id
            Save-Config $config
            Write-Host "Active project set to: $($config.channels[$index].name)" -ForegroundColor Green
        } else {
            Write-Host "Invalid selection!" -ForegroundColor Red
        }
    } catch {
        Write-Host "Invalid input!" -ForegroundColor Red
    }
}

function Set-CapabilityProfile {
    $config = Load-Config
    Write-Host ""
    Write-Host "Capability Profile" -ForegroundColor Cyan
    Write-Host "  1. Full Unity + Banter"
    Write-Host "  2. Inspection"
    Write-Host "  3. Banter workflow"
    Write-Host "  4. Unity authoring"
    Write-Host "  5. Testing"
    Write-Host "  6. Minimal routing"
    $selection = Read-Host "Select profile"
    $profiles = @{
        "1" = "all"
        "2" = "read"
        "3" = "read,author,banter"
        "4" = "read,author"
        "5" = "read,test"
        "6" = "none"
    }
    if (-not $profiles.ContainsKey($selection)) {
        Write-Host "Invalid selection!" -ForegroundColor Red
        return
    }

    $config.tool_groups = $profiles[$selection]
    Save-Config $config
    Write-Host "Capability profile set to: $($config.tool_groups)" -ForegroundColor Green
}

function Remove-Project {
    $config = Load-Config

    if ($config.channels.Count -eq 0) {
        Write-Host "No projects to remove!" -ForegroundColor Yellow
        return
    }

    Write-Host ""
    $selection = Read-Host "Enter project number to remove"

    try {
        $index = [int]$selection - 1
        if ($index -ge 0 -and $index -lt $config.channels.Count) {
            $removedId = $config.channels[$index].id
            $removedName = $config.channels[$index].name

            $config.channels = @($config.channels | Where-Object { $_.id -ne $removedId })

            if ($config.active_channel_id -eq $removedId) {
                $config.active_channel_id = if ($config.channels.Count -gt 0) { $config.channels[0].id } else { $null }
            }

            Save-Config $config
            Write-Host "Removed: $removedName" -ForegroundColor Green
        } else {
            Write-Host "Invalid selection!" -ForegroundColor Red
        }
    } catch {
        Write-Host "Invalid input!" -ForegroundColor Red
    }
}

function Apply-ToClaudeCode {
    $config = Load-Config

    if (-not $config.active_channel_id) {
        Write-Host "No active project selected!" -ForegroundColor Yellow
        return
    }

    $activeChannel = $config.channels | Where-Object { $_.id -eq $config.active_channel_id }

    if (-not $activeChannel) {
        Write-Host "Active channel not found!" -ForegroundColor Red
        return
    }

    # Load or create Claude config
    $claudeConfig = if (Test-Path $ClaudeConfigPath) {
        Get-Content $ClaudeConfigPath | ConvertFrom-Json
    } else {
        @{}
    }

    # Ensure mcpServers exists
    if (-not $claudeConfig.mcpServers) {
        $claudeConfig | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue @{} -Force
    }

    $envVars = @{
        UNITY_PROJECT_PATH = $activeChannel.unity_project_path
        CREATOR_WORKS_TOOL_GROUPS = Normalize-ToolGroups $config.tool_groups
    }

    if ($activeChannel.scene_path) {
        $envVars.UNITY_SCENE_PATH = $activeChannel.scene_path
    }

    $serverConfig = @{
        command = "node"
        args = @($config.mcp_server_path)
        env = $envVars
    }
    if ($claudeConfig.mcpServers -is [hashtable]) {
        $claudeConfig.mcpServers.Remove("banter")
        $claudeConfig.mcpServers.Remove("creator-works")
        $claudeConfig.mcpServers["creator-works"] = $serverConfig
    } else {
        $claudeConfig.mcpServers.PSObject.Properties.Remove("banter")
        $claudeConfig.mcpServers.PSObject.Properties.Remove("creator-works")
        $claudeConfig.mcpServers | Add-Member -NotePropertyName "creator-works" -NotePropertyValue $serverConfig -Force
    }

    Write-AtomicText $ClaudeConfigPath ($claudeConfig | ConvertTo-Json -Depth 10)

    Write-Host ""
    Write-Host "Applied to Claude Code!" -ForegroundColor Green
    Write-Host "  Project: $($activeChannel.name)" -ForegroundColor Cyan
    Write-Host "  Path: $($activeChannel.unity_project_path)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Restart Claude Code for changes to take effect." -ForegroundColor Yellow
}

function Remove-TomlTableBlock($content, $tableName) {
    $target = "[$tableName]"
    $lines = $content -split "`r?`n"
    $output = New-Object System.Collections.Generic.List[string]
    $skipping = $false

    foreach ($line in $lines) {
        $trimmed = $line.Trim()

        if ($trimmed -eq $target) {
            $skipping = $true
            continue
        }

        if ($skipping -and $trimmed.StartsWith("[") -and $trimmed.EndsWith("]")) {
            $skipping = $false
        }

        if (-not $skipping) {
            $output.Add($line)
        }
    }

    return ($output -join "`n").TrimEnd()
}

function Escape-TomlString($value) {
    return ($value -replace "\\", "\\" -replace '"', '\"')
}

function Apply-ToCodex {
    $config = Load-Config

    if (-not $config.active_channel_id) {
        Write-Host "No active project selected!" -ForegroundColor Yellow
        return
    }

    $activeChannel = $config.channels | Where-Object { $_.id -eq $config.active_channel_id }

    if (-not $activeChannel) {
        Write-Host "Active channel not found!" -ForegroundColor Red
        return
    }

    $configDir = Split-Path $CodexConfigPath
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $content = if (Test-Path $CodexConfigPath) {
        Get-Content $CodexConfigPath -Raw
    } else {
        ""
    }

    $content = Remove-TomlTableBlock $content "mcp_servers.banter"
    $content = Remove-TomlTableBlock $content "mcp_servers.banter.env"
    $content = Remove-TomlTableBlock $content "mcp_servers.creator-works"
    $content = Remove-TomlTableBlock $content "mcp_servers.creator-works.env"

    if (-not [string]::IsNullOrWhiteSpace($content)) {
        $content = $content.TrimEnd() + "`n`n"
    }

    $serverPath = Escape-TomlString ($config.mcp_server_path -replace "\\", "/")
    $projectPath = Escape-TomlString ($activeChannel.unity_project_path -replace "\\", "/")

    $content += "[mcp_servers.creator-works]`n"
    $content += "command = `"node`"`n"
    $content += "args = [`"$serverPath`"]`n"
    $content += "startup_timeout_sec = 20`n"
    $content += "tool_timeout_sec = 600`n`n"
    $content += "[mcp_servers.creator-works.env]`n"
    $content += "UNITY_PROJECT_PATH = `"$projectPath`"`n"
    $toolGroups = Escape-TomlString (Normalize-ToolGroups $config.tool_groups)
    $content += "CREATOR_WORKS_TOOL_GROUPS = `"$toolGroups`"`n"

    if ($activeChannel.scene_path) {
        $scenePath = Escape-TomlString ($activeChannel.scene_path -replace "\\", "/")
        $content += "UNITY_SCENE_PATH = `"$scenePath`"`n"
    }

    Write-AtomicText $CodexConfigPath $content

    Write-Host ""
    Write-Host "Applied to Codex!" -ForegroundColor Green
    Write-Host "  Config: $CodexConfigPath" -ForegroundColor DarkGray
    Write-Host "  Project: $($activeChannel.name)" -ForegroundColor Cyan
    Write-Host "  Path: $($activeChannel.unity_project_path)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Restart Codex for changes to take effect." -ForegroundColor Yellow
}

function Install-UnityExtension {
    $config = Load-Config

    if (-not $config.active_channel_id) {
        Write-Host "No active project selected!" -ForegroundColor Yellow
        return
    }

    $activeChannel = $config.channels | Where-Object { $_.id -eq $config.active_channel_id }

    if (-not $activeChannel) {
        Write-Host "Active channel not found!" -ForegroundColor Red
        return
    }

    $sourcePath = "$MCPRoot\unity-extension\Editor\BanterMCPBridge.cs"
    $sourceLogoPath = "$MCPRoot\unity-extension\Editor\CreatorWorksMCPLogo.png"
    $destDir = "$($activeChannel.unity_project_path)\Assets\Editor"
    $destPath = "$destDir\BanterMCPBridge.cs"
    $destLogoPath = "$destDir\CreatorWorksMCPLogo.png"

    if (-not (Test-Path $sourcePath)) {
        Write-Host "Source extension not found at: $sourcePath" -ForegroundColor Red
        return
    }
    if (-not (Test-Path $sourceLogoPath)) {
        Write-Host "Source extension logo not found at: $sourceLogoPath" -ForegroundColor Red
        return
    }

    # Create Editor directory if needed
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    if (Test-Path -LiteralPath $destPath -PathType Leaf) {
        $backupDir = "$($activeChannel.unity_project_path)\.bantworks-mcp\backups"
        if (-not (Test-Path -LiteralPath $backupDir)) {
            New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
        }
        $backupPath = Join-Path $backupDir ("BanterMCPBridge-{0}.cs" -f [guid]::NewGuid())
        Copy-Item -LiteralPath $destPath -Destination $backupPath
    }

    Copy-AtomicFile $sourceLogoPath $destLogoPath
    Copy-AtomicFile $sourcePath $destPath

    $stateDir = "$($activeChannel.unity_project_path)\.bantworks-mcp\state"
    if (-not (Test-Path $stateDir)) {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }

    $launcherSettings = @{
        enableCustomScripts = [bool]$config.enable_custom_scripts
        allowAllTests = if ($null -ne $config.allow_all_tests) { [bool]$config.allow_all_tests } else { $true }
    } | ConvertTo-Json
    Write-AtomicText "$stateDir\launcher-settings.json" $launcherSettings

    Write-Host ""
    Write-Host "Unity extension installed!" -ForegroundColor Green
    Write-Host "  Destination: $destPath" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Open Unity to compile the extension." -ForegroundColor Yellow
}

function Show-Usage {
    Write-Host "Creator Works MCP setup"
    Write-Host ""
    Write-Host "  .\setup.ps1              Open the interactive configuration menu"
    Write-Host "  .\setup.ps1 -Install     Install dependencies and build the release server bundle"
    Write-Host "  .\setup.ps1 -AddProject  Prompt for one Unity project, then exit"
    Write-Host "  .\setup.ps1 -ListProjects"
    Write-Host "  .\setup.ps1 -SetActive   Prompt for the active project, then exit"
    Write-Host "  .\setup.ps1 -Help"
    Write-Host ""
    Write-Host "Cross-platform CLI subcommands are available via scripts/cli/setup.mjs:"
    Write-Host "  node scripts\cli\setup.mjs install"
    Write-Host "  node scripts\cli\setup.mjs apply-claude"
    Write-Host "  node scripts\cli\setup.mjs apply-codex"
    Write-Host "  node scripts\cli\setup.mjs apply-antigravity"
    Write-Host "  node scripts\cli\setup.mjs apply-opencode"
}

function Show-ProjectList {
    $config = Load-Config
    $channels = @($config.channels)
    if ($channels.Count -eq 0) {
        Write-Host "No projects configured."
        return
    }

    foreach ($channel in $channels) {
        $marker = if ($channel.id -eq $config.active_channel_id) { "*" } else { " " }
        Write-Host "$marker $($channel.name) [$($channel.id)]"
        Write-Host "  $($channel.unity_project_path)"
    }
}

function Install-ServerBundle {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        throw "Node.js 20 or newer is required but 'node' was not found on PATH."
    }

    $nodeVersion = (& node --version).TrimStart("v")
    if ($LASTEXITCODE -ne 0 -or -not ($nodeVersion -match '^(\d+)\.')) {
        throw "Could not determine the installed Node.js version."
    }
    if ([int]$Matches[1] -lt 20) {
        throw "Node.js 20 or newer is required; found $nodeVersion."
    }

    $standaloneBundle = Join-Path $MCPRoot "creator-works-mcp.mjs"
    $packageManifest = Join-Path $MCPRoot "package.json"

    if ((Test-Path -LiteralPath $standaloneBundle -PathType Leaf) -and
        -not (Test-Path -LiteralPath $packageManifest -PathType Leaf)) {
        & node --check $standaloneBundle
        if ($LASTEXITCODE -ne 0) {
            throw "Standalone MCP server validation failed with exit code $LASTEXITCODE"
        }
        Write-Host "Standalone MCP server is installed and valid:" -ForegroundColor Green
        Write-Host "  $standaloneBundle" -ForegroundColor DarkGray
        Write-Host "  Node.js $nodeVersion" -ForegroundColor DarkGray
        return
    }

    if (-not (Test-Path -LiteralPath $packageManifest -PathType Leaf)) {
        throw "Neither a standalone MCP bundle nor package.json was found under $MCPRoot."
    }

    Push-Location $MCPRoot
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE"
        }

        & npm run release:server
        if ($LASTEXITCODE -ne 0) {
            throw "Server bundle build failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

# Main loop
if ($Help) {
    Show-Usage
    exit 0
}
if ($Install) {
    Install-ServerBundle
    exit 0
}
if ($AddProject) {
    Add-Project
    exit 0
}
if ($ListProjects) {
    Show-ProjectList
    exit 0
}
if ($SetActive) {
    Set-ActiveProject
    exit 0
}

while ($true) {
    Show-Menu
    $choice = Read-Host "Select option"

    switch ($choice.ToUpper()) {
        "A" { Add-Project; Read-Host "Press Enter to continue" }
        "S" { Set-ActiveProject; Read-Host "Press Enter to continue" }
        "G" { Set-CapabilityProfile; Read-Host "Press Enter to continue" }
        "R" { Remove-Project; Read-Host "Press Enter to continue" }
        "C" { Apply-ToClaudeCode; Read-Host "Press Enter to continue" }
        "X" { Apply-ToCodex; Read-Host "Press Enter to continue" }
        "E" { Install-UnityExtension; Read-Host "Press Enter to continue" }
        "Q" { Write-Host "Goodbye!" -ForegroundColor Cyan; exit }
        default { Write-Host "Invalid option!" -ForegroundColor Red; Start-Sleep -Seconds 1 }
    }
}
