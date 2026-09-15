param(
    [string]$UnityVersion = '2022.3.39f1',
    [string]$EditorRoot = 'C:\Program Files\Unity\Hub\Editor'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$editor = Join-Path $EditorRoot "$UnityVersion\Editor\Unity.exe"
if (-not (Test-Path -LiteralPath $editor -PathType Leaf)) { throw "Unity Editor not found: $editor" }
$fixture = Join-Path $root ('artifacts\plugins-presentation-' + $UnityVersion + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
if (Test-Path -LiteralPath $fixture) { throw "Refusing an existing fixture: $fixture" }
$scripts = Join-Path $fixture 'Assets\Editor\PluginTests'
$packages = Join-Path $fixture 'Packages'
$settings = Join-Path $fixture 'ProjectSettings'
New-Item -ItemType Directory -Path $scripts, $packages, $settings | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture '.presentation-test-fixture'), 'Dedicated empty Creator Plugins test; no user scene or SDK.')
[IO.File]::WriteAllText((Join-Path $packages 'manifest.json'), '{"dependencies":{}}')
[IO.File]::WriteAllText((Join-Path $settings 'ProjectVersion.txt'), "m_EditorVersion: $UnityVersion`n")
Copy-Item -LiteralPath (Join-Path $root 'launcher\unity\com.creatorworks.plugins') -Destination $packages -Recurse
Copy-Item -LiteralPath (Join-Path $root 'launcher\tests\unity\CreatorPluginsPresentationSmoke.cs'), (Join-Path $root 'launcher\tests\unity\CreatorWorks.Plugins.Editor.Tests.asmdef') -Destination $scripts
Copy-Item -LiteralPath (Join-Path $root 'launcher\tests\fixtures\community\start-location.json') -Destination (Join-Path $fixture 'listing.json')
$log = Join-Path $fixture 'Editor.log'
$process = Start-Process -FilePath $editor -ArgumentList @('-batchmode', '-projectPath', "`"$fixture`"", '-executeMethod', 'CreatorPluginsPresentationSmoke.Run', '-logFile', "`"$log`"") -WindowStyle Hidden -PassThru
Write-Output "Disposable Unity presentation fixture: $fixture (PID $($process.Id))"
if (-not $process.WaitForExit(240000)) { throw "Test still running: PID $($process.Id). Inspect $log; no process was terminated." }
$receipt = Join-Path $fixture 'presentation-result.json'
if (-not (Test-Path -LiteralPath $receipt)) { Get-Content -LiteralPath $log -Tail 50; throw 'Unity did not produce a presentation receipt.' }
$result = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
$result | ConvertTo-Json -Depth 4
if ($process.ExitCode -ne 0 -or -not $result.passed) { throw "Unity presentation fixture failed: $receipt" }
Write-Output "Passed: $receipt. Batch API/state checks only; no native import dialog or visual acceptance."
