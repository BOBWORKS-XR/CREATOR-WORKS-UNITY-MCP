param(
    [string[]]$UnityVersions = @('2022.3.39f1', '6000.3.21f1'),
    [string]$EditorRoot = 'C:\Program Files\Unity\Hub\Editor',
    [switch]$CheckNativeLock
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'launcher\unity\com.creatorworks.plugins\Editor\CreatorPluginsWindow.cs'
$tests = Join-Path $root 'launcher\tests\unity\CreatorPluginsProtocolTests.cs'
$interactiveTests = Join-Path $root 'launcher\tests\unity\CreatorPluginsInteractiveSmoke.cs'
$lockTests = Join-Path $root 'launcher\tests\unity\CreatorPluginsLockTests.cs'
$output = Join-Path $root 'artifacts\unity-plugins-compile'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$probe = $null
if ($CheckNativeLock) {
    $deps = Join-Path $root 'launcher\src-tauri\target\release\deps'
    $fs2 = @(Get-ChildItem -LiteralPath $deps -Filter 'libfs2-*.rlib' -File)
    if ($fs2.Count -ne 1) { throw 'Build the launcher release dependencies first; exactly one fs2 library is required for this probe.' }
    $probe = Join-Path $output 'queue-lock-probe.exe'
    & rustc --edition=2021 (Join-Path $root 'launcher\tests\native\QueueLockProbe.rs') --extern "fs2=$($fs2[0].FullName)" -L "dependency=$deps" -o $probe
    if ($LASTEXITCODE -ne 0) { throw 'Rust fs2 lock probe compilation failed.' }
}
foreach ($version in $UnityVersions) {
    $data = Join-Path $EditorRoot "$version\Editor\Data"
    $compiler = Join-Path $data 'MonoBleedingEdge\lib\mono\msbuild\Current\bin\Roslyn\csc.exe'
    $mono = Join-Path $data 'MonoBleedingEdge\bin\mono.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { throw "Compiler not found: $compiler" }
    $framework = Join-Path $data 'UnityReferenceAssemblies\unity-4.8-api'
    $managed = Join-Path $data 'Managed'
    $target = Join-Path $output "$version-protocol.exe"
    $references = @(
        Get-ChildItem -LiteralPath $framework -Filter '*.dll' -File
        Get-ChildItem -LiteralPath (Join-Path $framework 'Facades') -Filter '*.dll' -File
        Get-ChildItem -LiteralPath $managed -Filter 'Unity*.dll' -File
        Get-ChildItem -LiteralPath (Join-Path $managed 'UnityEngine') -Filter '*.dll' -File
    ) | Sort-Object FullName -Unique
    $arguments = @('/nologo', '/nostdlib+', '/langversion:8.0', '/warnaserror+', '/nowarn:0649', '/target:exe', "/out:`"$target`"", "/main:CreatorPluginsProtocolTests")
    $arguments += $references | ForEach-Object { "/reference:`"$($_.FullName)`"" }
    $arguments += @("`"$source`"", "`"$tests`"", "`"$interactiveTests`"", "`"$lockTests`"")
    $response = Join-Path $output "$version.rsp"
    [IO.File]::WriteAllLines($response, $arguments)
    & $mono $compiler /noconfig "@$response"
    if ($LASTEXITCODE -ne 0) { throw "Unity $version reference compilation failed." }
    $previousMonoPath = $env:MONO_PATH
    try {
        $env:MONO_PATH = "$managed;$(Join-Path $managed 'UnityEngine')"
        $fixtureArgs = @((Join-Path $output ("fixture-$version-" + [guid]::NewGuid().ToString('N'))))
        if ($probe) { $fixtureArgs += $probe }
        & $mono $target @fixtureArgs
        if ($LASTEXITCODE -ne 0) { throw "Unity $version offline protocol checks failed." }
    } finally { $env:MONO_PATH = $previousMonoPath }
    Write-Output "Unity $version reference compile and offline protocol checks passed. No Editor/project opened."
}
