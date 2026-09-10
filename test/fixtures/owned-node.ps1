function Start-OwnedNode([string]$Path) {
    $stopFile = Join-Path ([IO.Path]::GetTempPath()) ('creator-node-stop-' + [guid]::NewGuid().ToString('N'))
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = (Resolve-Path -LiteralPath $Path).Path
    $psi.Arguments = '"{0}" "{1}"' -f (Join-Path $PSScriptRoot 'owned-node.cjs'), $stopFile
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($psi)
    $owned = [pscustomobject]@{ Process = $child; StopFile = $stopFile }
    try {
        $ready = $child.StandardOutput.ReadLineAsync()
        if (-not $ready.Wait(10000)) { throw 'Owned Node fixture did not become ready.' }
        if ($ready.Result -ne 'fixture-ready' -or $child.WaitForExit(500)) {
            $detail = if ($child.HasExited) { "exit=$($child.ExitCode); stderr=$($child.StandardError.ReadToEnd())" } else { 'process still running' }
            throw "Owned Node fixture failed: executable=$Path; stdout=$($ready.Result); $detail"
        }
        return $owned
    } catch {
        Close-OwnedNode $owned
        throw
    }
}

function Close-OwnedNode($Owned) {
    if ($null -eq $Owned) { return }
    $child = $Owned.Process
    try {
        if (-not $child.HasExited) { [IO.File]::WriteAllText($Owned.StopFile, 'exit') }
        if (-not $child.WaitForExit(10000)) { throw 'Owned Node did not exit cooperatively; no force-close was attempted.' }
        if ($child.ExitCode -ne 0) { throw "Owned Node failed: exit=$($child.ExitCode); stderr=$($child.StandardError.ReadToEnd())" }
    } finally {
        if ($child.HasExited -and (Test-Path -LiteralPath $Owned.StopFile)) { Remove-Item -LiteralPath $Owned.StopFile }
        $child.Dispose()
    }
}
