param(
    [ValidateSet('2022.3.39f1', '6000.3.21f1')][string]$UnityVersion = '2022.3.39f1',
    [string]$EditorRoot = 'C:\Program Files\Unity\Hub\Editor'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $root ('artifacts\plugins-organization-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$editor = Join-Path $EditorRoot "$UnityVersion\Editor\Unity.exe"
if (!(Test-Path -LiteralPath $editor -PathType Leaf)) { throw 'Unity Editor not found.' }
if (Test-Path -LiteralPath $fixture) { throw 'Refusing an existing fixture.' }
$scripts = Join-Path $fixture 'Assets\Editor\PluginTests'
$packages = Join-Path $fixture 'Packages'
$settings = Join-Path $fixture 'ProjectSettings'
New-Item -ItemType Directory -Path $scripts, $packages, $settings | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture '.creator-plugins-organization-fixture'), 'Disposable graph organization acceptance, no user project or SDK.')
$vsVersion = if ($UnityVersion -eq '2022.3.39f1') { '1.9.4' } else { '1.9.12' }
[IO.File]::WriteAllText((Join-Path $packages 'manifest.json'), (@{ dependencies = @{ 'com.unity.visualscripting' = $vsVersion } } | ConvertTo-Json))
[IO.File]::WriteAllText((Join-Path $settings 'ProjectVersion.txt'), "m_EditorVersion: $UnityVersion`n")
Copy-Item -LiteralPath (Join-Path $root 'launcher\unity\com.creatorworks.plugins') -Destination $packages -Recurse
foreach ($name in @('CreatorPluginsOrganizationSmoke.cs', 'CreatorPluginsReferenceFixture.cs', 'CreatorWorks.Plugins.Editor.Tests.asmdef')) {
    Copy-Item -LiteralPath (Join-Path $root "launcher\tests\unity\$name") -Destination $scripts
}
$log = Join-Path $fixture 'Editor.log'
$process = Start-Process -FilePath $editor -ArgumentList @('-batchmode', '-nographics', '-projectPath', "`"$fixture`"", '-executeMethod', 'CreatorPluginsOrganizationSmoke.Run', '-logFile', "`"$log`"") -PassThru -WindowStyle Hidden
Write-Output "Disposable organization fixture: $fixture (PID $($process.Id))"
if (!$process.WaitForExit(300000)) { throw "Test has not exited. Inspect PID $($process.Id) and $log; nothing was terminated." }
$receipt = Join-Path $fixture 'organization-result.json'
if (!(Test-Path -LiteralPath $receipt)) { Get-Content -LiteralPath $log -Tail 45; throw 'No organization test receipt.' }
$result = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
$result | ConvertTo-Json
if ($process.ExitCode -ne 0 -or !$result.passed) { throw "Organization test failed: $receipt" }
Write-Output "Passed: $receipt. No third-party imports or user project edits."
