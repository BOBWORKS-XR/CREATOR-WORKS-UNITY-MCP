param([Parameter(Mandatory = $true)][string]$Guard)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$powershell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('creator-preflight-' + [guid]::NewGuid().ToString('N'))
$results = [Collections.Generic.List[object]]::new()

function Require($condition, [string]$message) {
    if (-not $condition) { throw $message }
}
function File-Hash([string]$path) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { [Convert]::ToBase64String($hash.ComputeHash([IO.File]::ReadAllBytes($path))) } finally { $hash.Dispose() }
}
function Invoke-RawPowerShell([string]$arguments) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $powershell
    $psi.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass ' + $arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($psi)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        Require ($process.WaitForExit(20000)) 'Owned preflight helper exceeded its 20-second test deadline.'
        [pscustomobject]@{ code = $process.ExitCode; pid = $process.Id; output = $output.Result.Trim(); error = $errors.Result.Trim() }
    } finally { $process.Dispose() }
}
function Invoke-Guard([string]$directory) {
    # This is the same raw native argument layout emitted by nsExec, not a PS argument array.
    Invoke-RawPowerShell ('-File "' + $Guard + '" -InstallDir "' + $directory + '\."')
}
function Check-Code([string]$name, $result, [int]$code) {
    Require ($result.code -eq $code) "$name expected $code, got $($result.code): $($result.output) $($result.error)"
    Require ([string]::IsNullOrWhiteSpace($result.error)) "$name wrote stderr: $($result.error)"
    $results.Add([pscustomobject]@{ test = $name; exitCode = $result.code; passed = $true })
}

try {
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    $oldScript = '& { param([string]$installDir); [pscustomobject]@{ received=$installDir; extra=@($args) } | ConvertTo-Json -Compress }'
    $old = Invoke-RawPowerShell ('-Command "' + $oldScript + '" "C:\Users\Andy\AppData\Local\Creator Works MCP"')
    $parsed = $old.output | ConvertFrom-Json
    Require ($parsed.received -eq 'C:\Users\Andy\AppData\Local\Creator') 'Old-command control did not reproduce path truncation.'
    Require (($parsed.extra -join ' ') -eq 'Works MCP') 'Old-command control did not split the suffix.'
    $results.Add([pscustomobject]@{ test = 'v2.6.0 raw command control reproduces truncated path'; passed = $true })

    $names = @('Plain', 'Creator Works MCP', "O'Brien & [MCP] (preview); `$notCode", ('Unicode-' + [char]0x00E9 + [char]0x68EE), 'Trailing\')
    $echo = Join-Path $PSScriptRoot 'installer-path-echo.ps1'
    foreach ($name in $names) {
        $directory = Join-Path $fixture $name
        $literal = Invoke-RawPowerShell ('-File "' + $echo + '" -InstallDir "' + $directory + '\."')
        Check-Code "Literal native argument: $name" $literal 0
        $received = $literal.output | ConvertFrom-Json
        Require ($received.received -ceq ($directory + '\.')) "Argument was changed: $name"
        Require ($received.extra.Count -eq 0) "Unexpected extra arguments: $name"
        Require ($received.normalized -ceq [IO.Path]::GetFullPath($directory + '\.')) "Normalization changed: $name"
        Check-Code "Absent destination: $name" (Invoke-Guard $directory) 0
        Require (-not [IO.Directory]::Exists($directory)) 'Preflight created an install directory.'
    }

    Check-Code 'Relative path refused' (Invoke-Guard 'relative\Creator Works MCP') 11
    foreach ($mode in @('throw', 'hidden')) {
        $queryFixture = Join-Path $PSScriptRoot 'installer-query-fixture.ps1'
        $queryArguments = '-File "' + $queryFixture + '" -Guard "' + $Guard + '" -InstallDir "' + $fixture + '\." -Mode ' + $mode
        Check-Code "Unavailable process verification: $mode" (Invoke-RawPowerShell $queryArguments) 11
    }
    $queryArguments = '-File "' + $queryFixture + '" -Guard "' + $Guard + '" -InstallDir "' + $fixture + '\." -Mode exited -GonePid ' + $old.pid
    Check-Code 'Confirmed exited process with missing CIM path ignored' (Invoke-RawPowerShell $queryArguments) 0

    $lockedRoot = Join-Path $fixture "O'Brien & [MCP] (locked); `$literal"
    $runtimeDir = Join-Path $lockedRoot 'server\runtime'
    [IO.Directory]::CreateDirectory($runtimeDir) | Out-Null
    $lockedFile = Join-Path $runtimeDir 'node.exe'
    [IO.File]::WriteAllBytes($lockedFile, [byte[]](17, 29, 41, 53))
    $before = File-Hash $lockedFile
    $handle = [IO.File]::Open($lockedFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { Check-Code 'Locked exact file refused' (Invoke-Guard $lockedRoot) 10 } finally { $handle.Dispose() }
    Require ((File-Hash $lockedFile) -eq $before) 'Locked file content changed.'
    Check-Code 'Unlocked exact file accepted' (Invoke-Guard $lockedRoot) 0
    Require ((File-Hash $lockedFile) -eq $before) 'Unlocked file content changed.'
    [IO.File]::SetAttributes($lockedFile, [IO.FileAttributes]::ReadOnly)
    try { Check-Code 'Read-only file refused' (Invoke-Guard $lockedRoot) 11 } finally { [IO.File]::SetAttributes($lockedFile, [IO.FileAttributes]::Normal) }

    # A copied, owned cmd.exe waits on stdin. It impersonates no real client and exits gracefully.
    foreach ($relative in @('server\runtime\node.exe', 'creator-works-mcp-launcher.exe', 'bantworks-mcp-launcher.exe', 'banter-mcp-launcher.exe')) {
        $root = Join-Path $fixture ('Running Creator Works ' + [guid]::NewGuid().ToString('N'))
        $exe = Join-Path $root $relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($exe)) | Out-Null
        [IO.File]::Copy("$env:WINDIR\System32\cmd.exe", $exe)
        $psi = [Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $exe
        $psi.Arguments = '/d /q /c "set /p fixture=Waiting"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $owned = [Diagnostics.Process]::Start($psi)
        try {
            Require (-not $owned.HasExited) 'Owned waiting process did not start.'
            Check-Code "Exact running path refused: $relative" (Invoke-Guard $root) 10
            Require (-not $owned.HasExited) 'Preflight terminated the owned waiting process.'
            Check-Code "Unrelated running path preserved: $relative" (Invoke-Guard (Join-Path $fixture 'Unrelated')) 0
            Require (-not $owned.HasExited) 'Preflight terminated an unrelated process.'
        } finally {
            if (-not $owned.HasExited) { $owned.StandardInput.WriteLine('done'); $owned.StandardInput.Close() }
            Require ($owned.WaitForExit(5000)) 'Owned waiting process did not exit gracefully.'
            $owned.Dispose()
        }
        Check-Code "Exited owned process accepted: $relative" (Invoke-Guard $root) 0
    }
    [pscustomobject]@{ powershell = $PSVersionTable.PSVersion.ToString(); passed = $true; checks = $results.Count; results = @($results.ToArray()) } | ConvertTo-Json -Depth 6
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('creator-preflight-')) {
        if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    } else { throw 'Refusing cleanup outside the owned fixture directory.' }
}
