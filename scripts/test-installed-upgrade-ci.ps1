param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
# This executes real installers. Refuse local and self-hosted environments.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Real installation acceptance is restricted to a disposable GitHub-hosted Windows runner.'
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$candidate = (Resolve-Path -LiteralPath $Installer).Path
$candidateRoot = [IO.Path]::GetFullPath((Join-Path $repo 'launcher\src-tauri\target\release\bundle\nsis')) + '\'
if (-not $candidate.StartsWith($candidateRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate must be built in this checkout.' }
$version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
if ($version -ne '2.7.0-alpha.1') { throw 'Review this version-specific acceptance fixture before using another release.' }
$installRoot = Join-Path $env:LOCALAPPDATA 'Creator Works MCP'
$configRoot = Join-Path $env:APPDATA 'creator-works-mcp'
$productKey = 'HKCU:\Software\Creator Works\Creator Works MCP'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Creator Works MCP'
foreach ($path in @($installRoot, $configRoot, $productKey, $uninstallKey)) {
    if (Test-Path -LiteralPath $path) { throw "Not a clean runner: $path already exists." }
}
$output = Join-Path $repo 'artifacts\installed-upgrade-ci'
$null = New-Item -ItemType Directory -Path $output -Force
$fixture = Join-Path $env:RUNNER_TEMP ('creator-installed-upgrade-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixture
$checks = [Collections.Generic.List[object]]::new()
$owned = $null
$unrelated = $null

function Require($condition, [string]$message) { if (-not $condition) { throw $message } }
function Hash([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Run-Setup([string]$path, [string]$arguments, [int]$expected, [string]$label) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $path
    $psi.Arguments = $arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $child = [Diagnostics.Process]::Start($psi)
    try {
        Require ($child.WaitForExit(180000)) "$label exceeded the deadline. No process was force-closed."
        Require ($child.ExitCode -eq $expected) "$label returned $($child.ExitCode), expected $expected."
        $checks.Add([pscustomobject]@{ test = $label; exitCode = $child.ExitCode; passed = $true })
    } finally { $child.Dispose() }
}
function Start-OwnedNode([string]$path) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $path
    $psi.Arguments = '-e "process.stdin.resume();process.stdin.on(''data'',()=>process.exit(0));process.stdin.on(''end'',()=>process.exit(0));console.log(''fixture-ready'')"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($psi)
    try {
        $ready = $child.StandardOutput.ReadLineAsync()
        Require ($ready.Wait(10000)) 'Owned Node fixture did not become ready.'
        Require ($ready.Result -eq 'fixture-ready' -and -not $child.HasExited) 'Owned Node fixture failed.'
        return $child
    } catch {
        Close-OwnedNode $child
        throw
    }
}
function Close-OwnedNode($child) {
    if ($null -eq $child) { return }
    try {
        if (-not $child.HasExited) { $child.StandardInput.WriteLine('done'); $child.StandardInput.Close() }
        Require ($child.WaitForExit(10000)) 'Owned Node did not exit cooperatively; no force-close was attempted.'
    } finally { $child.Dispose() }
}
function Snapshot {
    $files = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{ file = $_.FullName.Substring($installRoot.Length); hash = Hash $_.FullName; length = $_.Length; modified = $_.LastWriteTimeUtc.Ticks }
    })
    [pscustomobject]@{
        files = $files
        config = Hash (Join-Path $configRoot 'launcher-config.json')
        registeredPath = (Get-Item -LiteralPath $productKey).GetValue('')
        registeredVersion = (Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion
    } | ConvertTo-Json -Depth 6 -Compress
}
function Verify-Candidate {
    $pairs = @(
        @('server\runtime\node.exe', 'release\runtime\node.exe'),
        @('server\runtime\node', 'release\runtime\node'),
        @('server\creator-works-mcp.mjs', 'release\creator-works-mcp.mjs'),
        @('server\unity-extension\Editor\BanterMCPBridge.cs', 'unity-extension\Editor\BanterMCPBridge.cs')
    )
    # Tauri stamps the NSIS payload after building the portable launcher. Compare
    # against the actual extracted installer, never the companion portable EXE.
    Require ((Hash (Join-Path $installRoot 'creator-works-mcp-launcher.exe')) -eq (Hash (Join-Path $extracted 'creator-works-mcp-launcher.exe'))) 'Installed launcher differs from the installer payload.'
    foreach ($pair in $pairs) { Require ((Hash (Join-Path $installRoot $pair[0])) -eq (Hash (Join-Path $repo $pair[1]))) "Installed payload mismatch: $($pair[0])" }
    Require ((Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion -eq $version) 'Registry version did not advance.'
    Require ((Hash (Join-Path $configRoot 'launcher-config.json')) -eq $script:configHash) 'Settings sentinel changed.'
    Require ((Hash (Join-Path $installRoot 'user-content-sentinel.txt')) -eq $script:sentinelHash) 'Unmanaged content sentinel changed.'
}

try {
    $extracted = Join-Path $output 'extracted'
    $sevenZip = (Get-Command 7z.exe -ErrorAction Stop).Source
    & $sevenZip x $candidate ('-o' + $extracted) '-y' | Out-Null
    Require ($LASTEXITCODE -eq 0) 'Candidate extraction failed.'
    Require (Test-Path -LiteralPath (Join-Path $extracted 'creator-works-mcp-launcher.exe')) 'Installer has no expected launcher payload.'
    $baseline = Join-Path $fixture 'Creator.Works.MCP_2.6.0_x64-setup.exe'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/download/v2.6.0/Creator.Works.MCP_2.6.0_x64-setup.exe' -OutFile $baseline
    Require ((Hash $baseline) -eq '11d6fc0fb95e33023a90a8722cf9234f82de6e175689bd915401bac3d49bc8c2') 'Public baseline hash mismatch.'
    # /R is deliberately absent: neither installer may start the real GUI.
    Run-Setup $baseline '/S /NS' 0 'Clean baseline 2.6.0 installation'
    Require ((Hash (Join-Path $installRoot 'creator-works-mcp-launcher.exe')) -eq 'b712aadd91ac63ea64b5bbead28d7dc2fc83d4102f989999d7ea85b427649676') 'Unexpected baseline launcher payload.'
    $null = New-Item -ItemType Directory -Path $configRoot
    [IO.File]::WriteAllText((Join-Path $configRoot 'launcher-config.json'), '{"channels":[],"ciSentinel":"preserve-this-exact-file"}')
    [IO.File]::WriteAllText((Join-Path $installRoot 'user-content-sentinel.txt'), 'Unmanaged fixture content')
    $script:configHash = Hash (Join-Path $configRoot 'launcher-config.json')
    $script:sentinelHash = Hash (Join-Path $installRoot 'user-content-sentinel.txt')
    $before = Snapshot
    $unrelated = Start-OwnedNode (Get-Command node.exe).Source
    $owned = Start-OwnedNode (Join-Path $installRoot 'server\runtime\node.exe')
    Run-Setup $candidate '/S /NS' 10 'Upgrade refuses active installed private runtime'
    Require ((Snapshot) -ceq $before) 'Blocked upgrade altered baseline files/settings/registration.'
    Require (-not $owned.HasExited -and -not $unrelated.HasExited) 'Installer stopped a fixture process.'
    Close-OwnedNode $owned
    $owned = $null
    Run-Setup $candidate '/S /NS' 0 'Installed upgrade succeeds after cooperative runtime exit'
    Verify-Candidate
    Require (-not $unrelated.HasExited) 'Upgrade stopped an unrelated Node.'
    $checks.Add([pscustomobject]@{ test = 'Installed hashes, settings and unmanaged content preserved'; passed = $true })

    $before = Snapshot
    $owned = Start-OwnedNode (Join-Path $installRoot 'server\runtime\node.exe')
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    Run-Setup $uninstaller ('/S _?=' + $installRoot) 10 'Candidate uninstaller refuses active runtime'
    Require ((Snapshot) -ceq $before) 'Blocked uninstall altered installed baseline.'
    Require (-not $owned.HasExited -and -not $unrelated.HasExited) 'Uninstaller stopped a fixture process.'
    Close-OwnedNode $owned
    $owned = $null

    # Real GUI/Retry and legacy uninstall-page behavior are deliberately not inferred from /S.
    [pscustomobject]@{ passed = $true; installerSha256 = Hash $candidate; executableSha256 = Hash (Join-Path $extracted 'creator-works-mcp-launcher.exe'); version = $version; checks = @($checks.ToArray());
        interactiveUpgradeTested = $false; productionUserMachineUsed = $false } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'report.json')
} catch {
    [pscustomobject]@{ passed = $false; error = $_.Exception.Message; checks = @($checks.ToArray()) } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'report.json')
    throw
} finally {
    try { Close-OwnedNode $owned } finally { Close-OwnedNode $unrelated }
    # The disposable runner owns cleanup. Never recursively remove product paths here.
}
