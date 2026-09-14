param(
    [string[]]$UnityVersions = @('2022.3.39f1', '6000.3.21f1'),
    [string]$EditorRoot = 'C:\Program Files\Unity\Hub\Editor'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'launcher\unity\com.creatorworks.plugins\Editor\CreatorPluginsWindow.cs'
$tests = Join-Path $root 'launcher\tests\unity\CreatorPluginsProtocolTests.cs'
$output = Join-Path $root 'artifacts\unity-plugins-compile'
New-Item -ItemType Directory -Force -Path $output | Out-Null
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
    $arguments += @("`"$source`"", "`"$tests`"")
    $response = Join-Path $output "$version.rsp"
    [IO.File]::WriteAllLines($response, $arguments)
    & $mono $compiler /noconfig "@$response"
    if ($LASTEXITCODE -ne 0) { throw "Unity $version reference compilation failed." }
    $previousMonoPath = $env:MONO_PATH
    try {
        $env:MONO_PATH = "$managed;$(Join-Path $managed 'UnityEngine')"
        & $mono $target (Join-Path $output ("fixture-$version-" + [guid]::NewGuid().ToString('N')))
        if ($LASTEXITCODE -ne 0) { throw "Unity $version offline protocol checks failed." }
    } finally { $env:MONO_PATH = $previousMonoPath }
    Write-Output "Unity $version reference compile and offline protocol checks passed. No Editor/project opened."
}
