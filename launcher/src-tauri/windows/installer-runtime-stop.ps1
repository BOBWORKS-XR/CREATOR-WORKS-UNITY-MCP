param([Parameter(Mandatory = $true)][string]$InstallDir)

$ErrorActionPreference = 'Stop'
try {
    if ($InstallDir.Length -gt 32767 -or $InstallDir -notmatch '\A(?:[A-Za-z]:[\\/]|\\\\)') {
        throw 'The installation directory must be absolute.'
    }
    $root = [IO.Path]::GetFullPath($InstallDir)
    $targets = @('node.exe', 'node') | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $root "server\runtime\$_")) }
    foreach ($target in $targets) {
        $part = $target
        while ($part) {
            if (Test-Path -LiteralPath $part) {
                if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw 'MCP runtime paths must not contain junctions or symbolic links.'
                }
            }
            $part = [IO.Path]::GetDirectoryName($part)
        }
    }
    # This helper is only invoked after the interactive installer confirmation.
    # Keep the verified kernel handle: never terminate by process name or a PID
    # looked up again after verifying its executable.
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public sealed class CreatorRuntimeHandles : IDisposable {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    readonly List<IntPtr> handles = new List<IntPtr>();
    public void Add(uint pid, string expected) {
        IntPtr handle = OpenProcess(0x1000 | 0x0001 | 0x100000, false, pid);
        if (handle == IntPtr.Zero) {
            if (Marshal.GetLastWin32Error() == 87) return;
            throw new Win32Exception();
        }
        try {
            if (WaitForSingleObject(handle, 0) == 0) return;
            var name = new StringBuilder(32768); uint length = 32768;
            if (!QueryFullProcessImageName(handle, 0, name, ref length)) throw new Win32Exception();
            if (!String.Equals(name.ToString(), expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("MCP process identity changed. Retry the check.");
            handles.Add(handle); handle = IntPtr.Zero;
        } finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
    }
    public int Stop() {
        int stopped = 0;
        foreach (IntPtr handle in handles) {
            if (WaitForSingleObject(handle, 0) == 0) continue;
            if (!TerminateProcess(handle, 0) && WaitForSingleObject(handle, 0) != 0) throw new Win32Exception();
            stopped++;
        }
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        foreach (IntPtr handle in handles) {
            uint remaining = (uint)Math.Max(0, 5000 - elapsed.ElapsedMilliseconds);
            if (WaitForSingleObject(handle, remaining) != 0) throw new InvalidOperationException("An MCP runtime is still exiting. Wait and retry.");
        }
        return stopped;
    }
    public void Dispose() { foreach (IntPtr handle in handles) CloseHandle(handle); handles.Clear(); }
}
'@
    $owned = [CreatorRuntimeHandles]::new()
    try {
        $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'node'" -OperationTimeoutSec 8)
        foreach ($process in $processes) {
            if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) { continue }
            $path = [IO.Path]::GetFullPath($process.ExecutablePath)
            if ($targets -contains $path) { $owned.Add($process.ProcessId, $path) }
        }
        $count = $owned.Stop()
        Write-Output "Disconnected $count private MCP runtime(s). AI apps and other Node processes were not closed."
    } finally { $owned.Dispose() }
    # Do not chase a reconnecting client and repeatedly terminate new sessions.
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'node'" -OperationTimeoutSec 8)) {
        if ($process.ExecutablePath -and $targets -contains [IO.Path]::GetFullPath($process.ExecutablePath)) {
            Write-Output 'An AI client reopened MCP. Pause or disable this MCP in that client before retrying.'
            exit 10
        }
    }
    exit 0
} catch {
    Write-Output 'MCP disconnect could not complete. Pause or disable MCP in its AI client, then retry. Installation has not started.'
    exit 11
}
