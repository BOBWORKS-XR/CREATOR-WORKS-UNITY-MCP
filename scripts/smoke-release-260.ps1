param(
    [Parameter(Mandatory = $true)][string]$UnityEditor,
    [Parameter(Mandatory = $true)][string]$ProjectPath
)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath($ProjectPath)
if (Test-Path -LiteralPath $project) { throw 'Use a new, disposable project path; existing projects are never changed by this fixture.' }
if (-not (Test-Path -LiteralPath $UnityEditor -PathType Leaf)) { throw 'Unity Editor executable not found.' }
$repo = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path $project | Out-Null

function Run-Unity([string[]]$Arguments) {
    $process = Start-Process -FilePath $UnityEditor -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(240000)) {
        Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
        throw 'Disposable Unity test exceeded four minutes; its own process was stopped. Logs were preserved.'
    }
    $process.Refresh()
    if ($process.ExitCode -ne 0) { throw "Disposable Unity exited with code $($process.ExitCode); inspect its preserved logs." }
}

Run-Unity @('-batchmode', '-nographics', '-createProject', "`"$project`"", '-quit', '-logFile', "`"$project/create.log`"")
$editorFolder = Join-Path $project 'Assets/Editor'
New-Item -ItemType Directory -Path $editorFolder -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'unity-extension/Editor/BanterMCPBridge.cs') -Destination $editorFolder
Copy-Item -LiteralPath (Join-Path $repo 'unity-extension/Editor/CreatorWorksMCPLogo.png') -Destination $editorFolder
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures/Release260Smoke.cs') -Destination $editorFolder
Run-Unity @('-batchmode', '-nographics', '-projectPath', "`"$project`"", '-executeMethod', 'CreatorWorksSmoke.Release260Smoke.Run', '-logFile', "`"$project/smoke.log`"")
Get-Content -LiteralPath (Join-Path $project '.bantworks-mcp/state/release-260-smoke.json')
