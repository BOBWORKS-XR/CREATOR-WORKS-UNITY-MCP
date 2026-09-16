param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [ValidateSet('2.6.0', '2.7.0-alpha.1', '2.7.0-alpha.2', '2.7.0')][string]$BaselineVersion = '2.6.0',
    [string]$BaselineInstaller,
    [string]$ExpectedSourceCommit = $env:GITHUB_SHA,
    [string]$ExpectedInstallerSha256,
    [switch]$TestInteractivePrompts
)
$ErrorActionPreference = 'Stop'
# This executes real installers. Refuse local and self-hosted environments.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Real installation acceptance is restricted to a disposable GitHub-hosted Windows runner.'
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'test\fixtures\owned-node.ps1')
$candidate = (Resolve-Path -LiteralPath $Installer).Path
$candidateRoot = [IO.Path]::GetFullPath((Join-Path $repo 'launcher\src-tauri\target\release\bundle\nsis')) + '\'
if (-not $candidate.StartsWith($candidateRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate must be built in this checkout.' }
$version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
if ($version -ne '2.7.1') { throw 'Review this version-specific acceptance fixture before using another release.' }
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
$ownedSecond = $null
$unrelated = $null

function Require($condition, [string]$message) { if (-not $condition) { throw $message } }
function Hash([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Save-RefusalDiagnostic([string]$installerPath, [string]$label) {
    $record = [ordered]@{ label = $label; installerSha256 = Hash $installerPath; installRoot = $installRoot }
    try {
        $record.processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'node' OR Name = 'creator-works-mcp-launcher.exe' OR Name = 'bantworks-mcp-launcher.exe' OR Name = 'banter-mcp-launcher.exe'" -OperationTimeoutSec 8 | Select-Object Name,ProcessId,ExecutablePath)
        $payload = Join-Path $fixture ('refused-' + [guid]::NewGuid().ToString('N'))
        & $sevenZip x $installerPath ('-o' + $payload) '$PLUGINSDIR/creator-mcp-preflight.ps1' '-y' | Out-Null
        $guard = Join-Path $payload '$PLUGINSDIR\creator-mcp-preflight.ps1'
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $guard)) { throw 'Refused installer has no extractable script guard.' }
        $psi = [Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
        $psi.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $guard + '" -InstallDir "' + $installRoot + '\."'
        $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $probe = [Diagnostics.Process]::Start($psi)
        try {
            $stdout = $probe.StandardOutput.ReadToEndAsync(); $stderr = $probe.StandardError.ReadToEndAsync()
            $record.exited = $probe.WaitForExit(20000)
            $record.elapsedMs = $timer.ElapsedMilliseconds
            if ($record.exited) { $record.guardExitCode = $probe.ExitCode; $record.stdout = $stdout.Result; $record.stderr = $stderr.Result }
            else { $record.probePid = $probe.Id; $record.note = 'Diagnostic still running; no process terminated.' }
        } finally { $probe.Dispose() }
    } catch { $record.diagnosticError = $_.Exception.Message }
    $record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'preflight-refusal.json')
}
function Run-Setup([string]$path, [string]$arguments, [int]$expected, [string]$label) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $path
    $psi.Arguments = $arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $child = [Diagnostics.Process]::Start($psi)
    try {
        Require ($child.WaitForExit(180000)) "$label exceeded the deadline. No process was force-closed."
        if ($child.ExitCode -ne $expected) {
            Save-RefusalDiagnostic $path $label
            throw "$label returned $($child.ExitCode), expected $expected. See preflight-refusal.json."
        }
        $checks.Add([pscustomobject]@{ test = $label; exitCode = $child.ExitCode; passed = $true })
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
    # Tauri stamps the NSIS payload after building the portable launcher. Compare
    # against the actual extracted installer, never the companion portable EXE.
    Require ((Hash (Join-Path $installRoot 'creator-works-mcp-launcher.exe')) -eq (Hash (Join-Path $extracted 'creator-works-mcp-launcher.exe'))) 'Installed launcher differs from the installer payload.'
    foreach ($file in $buildInputs.files) {
        Require ((Hash (Join-Path $extracted $file.path)) -eq $file.sha256) "Packaged build input differs: $($file.path)"
        Require ((Hash (Join-Path $installRoot $file.path)) -eq $file.sha256) "Installed build input differs: $($file.path)"
    }
    Require ((Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion -eq $version) 'Registry version did not advance.'
    Require ((Hash (Join-Path $configRoot 'launcher-config.json')) -eq $script:configHash) 'Settings sentinel changed.'
    Require ((Hash (Join-Path $installRoot 'user-content-sentinel.txt')) -eq $script:sentinelHash) 'Unmanaged content sentinel changed.'
}

try {
    Require ($ExpectedInstallerSha256 -cmatch '^[a-f0-9]{64}$') 'Expected installer hash must come from the build job.'
    Require ($ExpectedSourceCommit -cmatch '^[a-f0-9]{40}$') 'Expected source revision must come from the verified build run.'
    Require ((Hash $candidate) -ceq $ExpectedInstallerSha256) 'Candidate differs from the exact installer built for both baseline tests.'
    $buildInputs = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $candidate) 'acceptance-inputs.json') -Raw | ConvertFrom-Json
    Require ($buildInputs.schemaVersion -eq 1 -and $buildInputs.version -ceq $version -and $buildInputs.sourceCommit -ceq $ExpectedSourceCommit -and $buildInputs.installerSha256 -ceq $ExpectedInstallerSha256) 'Build inputs are not from this candidate and source revision.'
    $expectedPaths = @('server/runtime/node.exe', 'server/runtime/node', 'server/creator-works-mcp.mjs', 'server/unity-extension/Editor/BanterMCPBridge.cs', 'licenses/LICENSE.txt', 'licenses/THIRD_PARTY_NOTICES.txt', 'licenses/rust-dependencies.json', 'licenses/node-dependencies.json')
    Require (@($buildInputs.files).Count -eq $expectedPaths.Count) 'Build input manifest has an unexpected file count.'
    foreach ($expectedPath in $expectedPaths) {
        $matches = @($buildInputs.files | Where-Object { $_.path -ceq $expectedPath })
        Require ($matches.Count -eq 1 -and $matches[0].sha256 -cmatch '^[a-f0-9]{64}$') "Missing or invalid build input: $expectedPath"
    }
    Copy-Item -LiteralPath $candidate -Destination (Join-Path $output ([IO.Path]::GetFileName($candidate)))
    $extracted = Join-Path $output 'extracted'
    $sevenZip = (Get-Command 7z.exe -ErrorAction Stop).Source
    & $sevenZip x $candidate ('-o' + $extracted) '-y' | Out-Null
    Require ($LASTEXITCODE -eq 0) 'Candidate extraction failed.'
    Require (Test-Path -LiteralPath (Join-Path $extracted 'creator-works-mcp-launcher.exe')) 'Installer has no expected launcher payload.'
    $runtimeStop = Join-Path $extracted '$PLUGINSDIR\creator-mcp-runtime-stop.ps1'
    Require ($buildInputs.runtimeStopSha256 -cmatch '^[a-f0-9]{64}$') 'Missing build binding for the packaged runtime cleanup.'
    Require ((Hash $runtimeStop) -ceq $buildInputs.runtimeStopSha256) 'Packaged runtime cleanup differs from the reviewed source.'
    $baselines = @{
        '2.7.0' = @{
            asset = 'Creator.Works.MCP_2.7.0_x64-setup.exe'
            installerSha256 = 'f403da14237a16d3e7a50620d484c60c0a3fbdbb6abfe1ccaf21e4ffb78e1da9'
            executableSha256 = '0fc9f6023973378778a00b063c383f37f2973eec9d89a96b084391c89f2287cd'
        }
        '2.6.0' = @{
            asset = 'Creator.Works.MCP_2.6.0_x64-setup.exe'
            installerSha256 = '11d6fc0fb95e33023a90a8722cf9234f82de6e175689bd915401bac3d49bc8c2'
            executableSha256 = 'b712aadd91ac63ea64b5bbead28d7dc2fc83d4102f989999d7ea85b427649676'
        }
        '2.7.0-alpha.1' = @{
            asset = 'Creator-Works-MCP-2.7.0-alpha.1-Windows-setup.exe'
            installerSha256 = '8f39b9f2e120076346873dc8cc3186e6a2c055e1cca4cf9b8b66dfb700f12c41'
            executableSha256 = '04971c5c6cc2c3346606d4ae96bbea465c9924b564a1fe928f7d7d006527de65'
        }
        '2.7.0-alpha.2' = @{
            asset = 'Creator Works MCP_2.7.0-alpha.2_x64-setup.exe'
            installerSha256 = 'e5997ad60ae7d331b15a0b1038042e8062492589602724206eeb943093113c1e'
            executableSha256 = '7138bbf4efe3e58018071e7023220f0c637ddd89339f1a9de0d8db2a6b5f62e7'
        }
    }
    $baselinePin = $baselines[$BaselineVersion]
    $baseline = Join-Path $fixture $baselinePin.asset
    if ($BaselineVersion -ceq '2.7.0-alpha.2') {
        Require (-not [string]::IsNullOrWhiteSpace($BaselineInstaller)) 'Alpha 2 must come from its pinned accepted CI artifact, not a public release.'
        $baselineSource = (Resolve-Path -LiteralPath $BaselineInstaller).Path
        $baselineRoot = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts\accepted-alpha2-baseline')) + '\'
        Require ($baselineSource.StartsWith($baselineRoot, [StringComparison]::OrdinalIgnoreCase)) 'Alpha 2 baseline must be downloaded into the dedicated CI fixture.'
        Require ((Hash $baselineSource) -ceq $baselinePin.installerSha256) 'Accepted alpha 2 artifact hash mismatch.'
        Copy-Item -LiteralPath $baselineSource -Destination $baseline
    } else {
        Require ([string]::IsNullOrWhiteSpace($BaselineInstaller)) 'Public baselines must use their pinned release assets.'
        Invoke-WebRequest -UseBasicParsing -Uri ("https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/download/v$BaselineVersion/" + $baselinePin.asset) -OutFile $baseline
    }
    Require ((Hash $baseline) -ceq $baselinePin.installerSha256) 'Baseline hash mismatch.'
    # /R is deliberately absent: neither installer may start the real GUI.
    Run-Setup $baseline '/S /NS' 0 "Clean baseline $BaselineVersion installation"
    Require ((Hash (Join-Path $installRoot 'creator-works-mcp-launcher.exe')) -ceq $baselinePin.executableSha256) 'Unexpected baseline launcher payload.'
    Require ((Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion -ceq $BaselineVersion) 'Unexpected baseline registered version.'
    $null = New-Item -ItemType Directory -Path $configRoot
    [IO.File]::WriteAllText((Join-Path $configRoot 'launcher-config.json'), '{"channels":[],"ciSentinel":"preserve-this-exact-file"}')
    [IO.File]::WriteAllText((Join-Path $installRoot 'user-content-sentinel.txt'), 'Unmanaged fixture content')
    $script:configHash = Hash (Join-Path $configRoot 'launcher-config.json')
    $script:sentinelHash = Hash (Join-Path $installRoot 'user-content-sentinel.txt')
    $before = Snapshot
    $unrelated = Start-OwnedNode (Get-Command node.exe).Source
    $owned = Start-OwnedNode (Join-Path $installRoot 'server\runtime\node.exe')
    $ownedSecond = Start-OwnedNode (Join-Path $installRoot 'server\runtime\node.exe')
    Run-Setup $candidate '/S /NS' 10 'Upgrade refuses active installed private runtime'
    Require ((Snapshot) -ceq $before) 'Blocked upgrade altered baseline files/settings/registration.'
    Run-Setup $candidate ('/S /NS /UPDATE /D=' + $installRoot) 10 'Hub update mode refuses active installed private runtime'
    Require ((Snapshot) -ceq $before) 'Blocked Hub upgrade altered baseline files/settings/registration.'
    Require (-not $owned.Process.HasExited -and -not $ownedSecond.Process.HasExited -and -not $unrelated.Process.HasExited) 'Installer stopped a fixture process.'
    if ($TestInteractivePrompts) {
        . (Join-Path $repo 'test\fixtures\installer-native-prompts.ps1')
        Test-InstallerRuntimePrompts -Installer $candidate -InstallDir $installRoot -First $owned.Process -Second $ownedSecond.Process -Unrelated $unrelated.Process -VerifyUnchanged { Require ((Snapshot) -ceq $before) 'Interactive preflight changed baseline files/settings/registration.' }
        $checks.Add([pscustomobject]@{ test = 'Native installer No rechecks without stopping; Cancel preserves both runtimes; Yes stops both while preserving unrelated Node and baseline files'; passed = $true })
        Close-OwnedNode $owned
        Close-OwnedNode $ownedSecond
        $owned = Start-OwnedNode (Join-Path $installRoot 'server\runtime\node.exe')
        $ownedSecond = Start-OwnedNode (Join-Path $installRoot 'server\runtime\node.exe')
    }
    # Use the exact script extracted from the candidate installer, not a source
    # substitute. Native Yes/No/Cancel click-through remains a separate check.
    & "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $runtimeStop -InstallDir $installRoot
    Require ($LASTEXITCODE -eq 0) 'Packaged runtime cleanup failed.'
    Require ($owned.Process.WaitForExit(5000) -and $ownedSecond.Process.WaitForExit(5000)) 'Cleanup did not stop both private runtimes.'
    Require (-not $unrelated.Process.HasExited) 'Cleanup stopped unrelated Node.'
    Require ((Snapshot) -ceq $before) 'Cleanup altered baseline files/settings/registration.'
    $checks.Add([pscustomobject]@{ test = 'Packaged cleanup stops multiple old private runtimes, preserves unrelated Node and all baseline files/settings'; passed = $true })
    Close-OwnedNode $owned
    $owned = $null
    Close-OwnedNode $ownedSecond
    $ownedSecond = $null
    Run-Setup $candidate ('/S /NS /UPDATE /D=' + $installRoot) 0 'Hub installed upgrade succeeds after confirmed runtime cleanup'
    Verify-Candidate
    $env:MCP_SHUTDOWN_ENTRY = Join-Path $installRoot 'server\creator-works-mcp.mjs'
    $env:MCP_SHUTDOWN_NODE = Join-Path $installRoot 'server\runtime\node.exe'
    & node --test (Join-Path $repo 'test\server-shutdown.test.mjs')
    Require ($LASTEXITCODE -eq 0) 'Installed runtime/server shutdown acceptance failed.'
    Remove-Item Env:\MCP_SHUTDOWN_ENTRY,Env:\MCP_SHUTDOWN_NODE
    $checks.Add([pscustomobject]@{ test = 'Installed private Node and bundled server exit on idle/pending-wait EOF and remain usable while connected'; passed = $true })
    Require (-not $unrelated.Process.HasExited) 'Upgrade stopped an unrelated Node.'
    $checks.Add([pscustomobject]@{ test = 'Installed hashes, settings and unmanaged content preserved'; passed = $true })

    $before = Snapshot
    $owned = Start-OwnedNode (Join-Path $installRoot 'server\runtime\node.exe')
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    Run-Setup $uninstaller ('/S _?=' + $installRoot) 10 'Candidate uninstaller refuses active runtime'
    Require ((Snapshot) -ceq $before) 'Blocked uninstall altered installed baseline.'
    Require (-not $owned.Process.HasExited -and -not $unrelated.Process.HasExited) 'Uninstaller stopped a fixture process.'
    Close-OwnedNode $owned
    $owned = $null

    # Real GUI/Retry and legacy uninstall-page behavior are deliberately not inferred from /S.
    [pscustomobject]@{ passed = $true; installerSha256 = Hash $candidate; executableSha256 = Hash (Join-Path $extracted 'creator-works-mcp-launcher.exe'); version = $version; checks = @($checks.ToArray());
        baselineVersion = $BaselineVersion; sourceCommit = $ExpectedSourceCommit; acceptanceCommit = $env:GITHUB_SHA; buildInputsVerified = $true;
        interactivePromptsTested = [bool]$TestInteractivePrompts; interactiveUpgradeTested = $false; productionUserMachineUsed = $false } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'report.json')
} catch {
    [pscustomobject]@{ passed = $false; baselineVersion = $BaselineVersion; error = $_.Exception.Message; checks = @($checks.ToArray()) } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'report.json')
    throw
} finally {
    try { Close-OwnedNode $owned } finally { try { Close-OwnedNode $ownedSecond } finally { Close-OwnedNode $unrelated } }
    # The disposable runner owns cleanup. Never recursively remove product paths here.
}
