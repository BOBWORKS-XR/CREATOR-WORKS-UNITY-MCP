param(
    [Parameter(Mandatory = $true)][string]$UnityEditor,
    [Parameter(Mandatory = $true)][string]$UnityCli,
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)][string]$ProbeScript
)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath($ProjectPath)
if (Test-Path -LiteralPath $project) { throw 'Use a new disposable project path; existing projects are never changed.' }
foreach ($file in @($UnityEditor, $UnityCli, $ProbeScript)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing test prerequisite: $file" }
}
$repo = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path $project | Out-Null
$create = Start-Process -FilePath $UnityEditor -ArgumentList @('-batchmode', '-nographics', '-createProject', "`"$project`"", '-quit', '-logFile', "`"$project/create.log`"") -PassThru -WindowStyle Hidden
if (-not $create.WaitForExit(240000)) {
    Stop-Process -Id $create.Id -ErrorAction SilentlyContinue
    throw 'Disposable project creation timed out. Its own process was stopped; logs preserved.'
}
$create.Refresh()
if ($create.ExitCode -ne 0) { throw 'Disposable project creation failed; inspect create.log.' }
$manifestPath = Join-Path $project 'Packages/manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest.dependencies | Add-Member -NotePropertyName 'com.unity.pipeline' -NotePropertyValue '0.6.0-exp.1' -Force
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $project 'cli-smoke-owner.json'), '{"disposable":true}', [Text.UTF8Encoding]::new($false))
$editorFolder = Join-Path $project 'Assets/Editor'
New-Item -ItemType Directory -Path $editorFolder -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'unity-extension/Editor/BanterMCPBridge.cs') -Destination $editorFolder
Copy-Item -LiteralPath (Join-Path $repo 'unity-extension/Editor/CreatorWorksMCPLogo.png') -Destination $editorFolder
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures/UnityCliSmoke.cs') -Destination $editorFolder
$editor = Start-Process -FilePath $UnityEditor -ArgumentList @('-batchmode', '-nographics', '-projectPath', "`"$project`"", '-creatorWorksCliSmoke', '-logFile', "`"$project/editor.log`"") -PassThru -WindowStyle Hidden
try {
    $deadline = [DateTime]::UtcNow.AddMinutes(6)
    while (-not (Test-Path -LiteralPath (Join-Path $project 'cli-smoke-ready.json'))) {
        $editor.Refresh()
        if ($editor.HasExited) { throw 'Disposable Editor exited before fixture readiness; inspect editor.log.' }
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Disposable fixture timed out during import/compile; inspect editor.log.' }
        Start-Sleep -Seconds 2
    }
    & node $ProbeScript $UnityCli $project
    if ($LASTEXITCODE -ne 0) { throw 'Unity CLI probe failed; outputs and logs were preserved.' }
} finally {
    [IO.File]::WriteAllText((Join-Path $project 'cli-smoke-stop'), 'stop', [Text.UTF8Encoding]::new($false))
    if (-not $editor.WaitForExit(15000)) {
        Stop-Process -Id $editor.Id -ErrorAction SilentlyContinue
        Write-Warning 'Disposable Editor did not acknowledge shutdown; only the process launched by this fixture was stopped.'
    }
}
