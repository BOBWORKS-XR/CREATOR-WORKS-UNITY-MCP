param(
    [string]$UnityVersion = '6000.3.21f1',
    [string]$EditorRoot = 'C:\Program Files\Unity\Hub\Editor'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $root ('artifacts\plugins-ui-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$editor = Join-Path $EditorRoot "$UnityVersion\Editor\Unity.exe"
if (-not (Test-Path -LiteralPath $editor -PathType Leaf)) { throw "Unity not found: $editor" }
if (Test-Path -LiteralPath $fixture) { throw 'Refusing an existing fixture.' }
$scripts = Join-Path $fixture 'Assets\Editor\PluginTests'
$packages = Join-Path $fixture 'Packages'
$settings = Join-Path $fixture 'ProjectSettings'
New-Item -ItemType Directory -Path $scripts, $packages, $settings -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture '.creator-plugins-interactive-fixture'), 'Disposable native import dialog test only.')
[IO.File]::WriteAllText((Join-Path $packages 'manifest.json'), '{"dependencies":{}}')
[IO.File]::WriteAllText((Join-Path $settings 'ProjectVersion.txt'), "m_EditorVersion: $UnityVersion`n")
Copy-Item -LiteralPath (Join-Path $root 'launcher\unity\com.creatorworks.plugins') -Destination $packages -Recurse
Copy-Item -LiteralPath (Join-Path $root 'launcher\tests\unity\CreatorPluginsInteractiveSmoke.cs'), (Join-Path $root 'launcher\tests\unity\CreatorWorks.Plugins.Editor.Tests.asmdef') -Destination $scripts
$log = Join-Path $fixture 'Editor-prepare.log'
$process = Start-Process -FilePath $editor -ArgumentList @('-batchmode', '-nographics', '-projectPath', "`"$fixture`"", '-executeMethod', 'CreatorPluginsInteractiveSmoke.Prepare', '-logFile', "`"$log`"") -PassThru -WindowStyle Hidden
Write-Output "Preparing disposable native dialog fixture: $fixture (PID $($process.Id))"
if (-not $process.WaitForExit(240000)) { throw "Preparation has not exited. Inspect PID $($process.Id) and $log; no process was terminated." }
if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $fixture 'interactive-prepared.txt'))) {
    Get-Content -LiteralPath $log -Tail 60
    throw 'Interactive fixture preparation failed.'
}
Write-Output "Ready for native UI testing: $fixture. No real Unity project changed."
