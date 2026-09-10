param([Parameter(Mandatory = $true)][string]$InstallDir)

$ErrorActionPreference = 'Stop'
try {
    if ($InstallDir.Length -gt 32767 -or $InstallDir -notmatch '\A(?:[A-Za-z]:[\\/]|\\\\)') {
        throw 'The installation directory must be absolute.'
    }
    $root = [IO.Path]::GetFullPath($InstallDir)
    $targets = @(
        [IO.Path]::GetFullPath((Join-Path $root 'server\runtime\node.exe')),
        [IO.Path]::GetFullPath((Join-Path $root 'server\runtime\node')),
        [IO.Path]::GetFullPath((Join-Path $root 'creator-works-mcp-launcher.exe')),
        [IO.Path]::GetFullPath((Join-Path $root 'bantworks-mcp-launcher.exe')),
        [IO.Path]::GetFullPath((Join-Path $root 'banter-mcp-launcher.exe'))
    )
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'node' OR Name = 'creator-works-mcp-launcher.exe' OR Name = 'bantworks-mcp-launcher.exe' OR Name = 'banter-mcp-launcher.exe'" -OperationTimeoutSec 8 -ErrorAction Stop)
    $unknownPath = $false
    foreach ($process in $processes) {
        if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
            # CIM can retain a row after a short-lived process exits. Discard it
            # only when Windows confirms it is gone; an inaccessible live path
            # still fails closed. Never inspect a client command line or stop it.
            if ($process.ProcessId -gt 0) {
                $live = $null
                try {
                    $live = [Diagnostics.Process]::GetProcessById([int]$process.ProcessId)
                    if ($live.HasExited) { continue }
                } catch [ArgumentException] {
                    continue
                } finally {
                    if ($null -ne $live) { $live.Dispose() }
                }
            }
            $unknownPath = $true
            continue
        }
        $executable = [IO.Path]::GetFullPath($process.ExecutablePath)
        foreach ($target in $targets) {
            if ([string]::Equals($executable, $target, [StringComparison]::OrdinalIgnoreCase)) {
                Write-Output 'The selected MCP launcher or private runtime is still running.'
                exit 10
            }
        }
    }
    if ($unknownPath) {
        Write-Output 'Windows did not reveal a candidate process path; Setup cannot safely rule out this MCP runtime.'
        exit 11
    }
    # Test overwrite access without writing/truncating or holding a file across
    # user interaction. A file can still become locked after this check.
    foreach ($target in $targets) {
        if ([IO.File]::Exists($target)) {
            $handle = $null
            try {
                $handle = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            } catch [IO.IOException] {
                $code = $_.Exception.HResult -band 0xFFFF
                if ($code -eq 32 -or $code -eq 33) {
                    Write-Output 'An MCP file is locked by another process.'
                    exit 10
                }
                throw
            } finally {
                if ($null -ne $handle) { $handle.Dispose() }
            }
        }
    }
    exit 0
} catch {
    Write-Output 'Process or file-access verification failed. Check permissions and retry; no files were changed.'
    exit 11
}
