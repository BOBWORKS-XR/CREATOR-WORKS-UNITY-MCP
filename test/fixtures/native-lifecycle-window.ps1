param(
    [Parameter(Mandatory=$true)][int]$TargetPid,
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256,
    [ValidateSet('state','close')][string]$Action = 'state'
)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'Native lifecycle acceptance requires a disposable GitHub-hosted Windows runner.' }
$process = Get-Process -Id $TargetPid -ErrorAction Stop
if ([IO.Path]::GetFullPath($process.Path) -ine [IO.Path]::GetFullPath($Executable)) { throw 'Native lifecycle process identity changed.' }
if ((Get-FileHash -LiteralPath $Executable).Hash.ToLowerInvariant() -cne $ExpectedSha256) { throw 'Unapproved lifecycle executable.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class McpLifecycleWindow {
    private delegate bool Visit(IntPtr h, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit cb, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr h, string name);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    public static IntPtr[] ForProcess(uint expected) {
        var found = new List<IntPtr>();
        EnumWindows((h, _) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid == expected && GetProp(h, "CreatorSuite.LifecycleProtocol").ToInt64() == 1) found.Add(h); return true; }, IntPtr.Zero);
        return found.ToArray();
    }
}
'@
$handles = @([McpLifecycleWindow]::ForProcess($TargetPid))
if ($handles.Count -ne 1) { throw 'Expected one exact owned lifecycle window.' }
$hwnd=$handles[0]
if ($Action -eq 'close' -and -not [McpLifecycleWindow]::PostMessage($hwnd,0x10,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'WM_CLOSE could not be posted.' }
[pscustomobject]@{ pid=$TargetPid; hwnd=$hwnd.ToInt64(); protocol=[McpLifecycleWindow]::GetProp($hwnd,'CreatorSuite.LifecycleProtocol').ToInt64(); busy=[McpLifecycleWindow]::GetProp($hwnd,'CreatorSuite.LauncherBusy').ToInt64(); closing=[McpLifecycleWindow]::GetProp($hwnd,'CreatorSuite.Closing').ToInt64() } | ConvertTo-Json -Compress
