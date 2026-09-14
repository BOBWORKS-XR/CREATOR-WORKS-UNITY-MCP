param(
    [string]$UnityVersion = '2022.3.39f1',
    [string]$EditorRoot = 'C:\Program Files\Unity\Hub\Editor'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root 'artifacts'
$fixture = Join-Path $artifacts ('plugins-editor-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$editor = Join-Path $EditorRoot "$UnityVersion\Editor\Unity.exe"
if (-not (Test-Path -LiteralPath $editor -PathType Leaf)) { throw "Unity Editor not found: $editor" }
if (Test-Path -LiteralPath $fixture) { throw "Refusing an existing fixture: $fixture" }
$scripts = Join-Path $fixture 'Assets\Editor\PluginTests'
$packages = Join-Path $fixture 'Packages'
$settings = Join-Path $fixture 'ProjectSettings'
New-Item -ItemType Directory -Path $scripts, $packages, $settings -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture '.creator-plugins-disposable-fixture'), 'Dedicated empty Creator Plugins test; no user scene or SDK.')
[IO.File]::WriteAllText((Join-Path $packages 'manifest.json'), '{"dependencies":{}}')
[IO.File]::WriteAllText((Join-Path $settings 'ProjectVersion.txt'), "m_EditorVersion: $UnityVersion`n")
Copy-Item -LiteralPath (Join-Path $root 'launcher\unity\com.creatorworks.plugins') -Destination $packages -Recurse
Copy-Item -LiteralPath (Join-Path $root 'launcher\tests\unity\CreatorPluginsEditorSmoke.cs'), (Join-Path $root 'launcher\tests\unity\CreatorWorks.Plugins.Editor.Tests.asmdef') -Destination $scripts
Copy-Item -LiteralPath (Join-Path $root 'launcher\tests\fixtures\community\start-location.json') -Destination (Join-Path $fixture 'pending-listing.json')
$log = Join-Path $fixture 'Editor.log'
$process = Start-Process -FilePath $editor -ArgumentList @('-batchmode', '-nographics', '-projectPath', "`"$fixture`"", '-executeMethod', 'CreatorPluginsEditorSmoke.Run', '-logFile', "`"$log`"") -PassThru -WindowStyle Hidden
Write-Output "Disposable Unity fixture: $fixture (PID $($process.Id))"
if (-not $process.WaitForExit(240000)) { throw "Disposable Unity test has not exited after 240 seconds. Inspect PID $($process.Id) and $log; no process was terminated." }
$receipt = Join-Path $fixture 'creator-plugins-smoke.json'
if (-not (Test-Path -LiteralPath $receipt)) { Get-Content -LiteralPath $log -Tail 50; throw 'Unity did not produce a test receipt.' }
$result = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
$result | ConvertTo-Json
if ($process.ExitCode -ne 0 -or -not $result.passed) { throw "Unity Editor fixture failed: $receipt" }
Write-Output "Passed: $receipt. No import dialog was opened and no package was imported."
$log = Join-Path $fixture 'Editor-recovery.log'
$process = Start-Process -FilePath $editor -ArgumentList @('-batchmode', '-nographics', '-projectPath', "`"$fixture`"", '-executeMethod', 'CreatorPluginsEditorSmoke.Recover', '-logFile', "`"$log`"") -PassThru -WindowStyle Hidden
if (-not $process.WaitForExit(240000)) { throw "Recovery test has not exited. Inspect PID $($process.Id) and $log; no process was terminated." }
$receipt = Join-Path $fixture 'creator-plugins-recovery.json'
if (-not (Test-Path -LiteralPath $receipt)) { Get-Content -LiteralPath $log -Tail 50; throw 'Unity did not produce a recovery receipt.' }
$result = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
$result | ConvertTo-Json
if ($process.ExitCode -ne 0 -or -not $result.passed) { throw "Unity recovery fixture failed: $receipt" }
Write-Output "Passed: $receipt. Restart recovery and simulated callback routing, not real import acceptance."
