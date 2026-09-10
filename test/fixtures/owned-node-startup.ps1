param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$psi = [Diagnostics.ProcessStartInfo]::new()
$psi.FileName = (Resolve-Path -LiteralPath $NodePath).Path
$psi.Arguments = '-e "process.stdin.resume();process.stdin.on(''data'',()=>process.exit(0));process.stdin.on(''end'',()=>process.exit(0));console.log(''fixture-ready'')"'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$child = [Diagnostics.Process]::Start($psi)
try {
    $ready = $child.StandardOutput.ReadLineAsync()
    if (-not $ready.Wait(10000)) { throw 'Owned fixture did not become ready.' }
    if ($ready.Result -ne 'fixture-ready' -or $child.HasExited) {
        $detail = if ($child.HasExited) { "exit=$($child.ExitCode); stderr=$($child.StandardError.ReadToEnd())" } else { 'process still running' }
        throw "Owned fixture failed: stdout=$($ready.Result); $detail"
    }
    Write-Output 'Owned Node fixture started and stayed alive.'
} finally {
    if (-not $child.HasExited) { $child.StandardInput.WriteLine('done'); $child.StandardInput.Close() }
    if (-not $child.WaitForExit(10000)) { throw 'Owned fixture did not exit cooperatively.' }
    $child.Dispose()
}
