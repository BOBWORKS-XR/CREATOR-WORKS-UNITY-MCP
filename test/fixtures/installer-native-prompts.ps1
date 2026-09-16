$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Native installer prompt acceptance requires a disposable GitHub-hosted Windows runner.'
}

function Test-InstallerRuntimePrompts {
    param([string]$Installer, [string]$InstallDir, [Diagnostics.Process]$First,
        [Diagnostics.Process]$Second, [Diagnostics.Process]$Unrelated, [scriptblock]$VerifyUnchanged)
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CreatorInstallerDialogs {
    private delegate bool Visit(IntPtr h, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit cb, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr root, Visit cb, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder value, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder value, int size);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    public static string Text(IntPtr h) { var b=new StringBuilder(32768); GetWindowText(h,b,b.Capacity); return b.ToString(); }
    public static string Class(IntPtr h) { var b=new StringBuilder(256); GetClassName(h,b,b.Capacity); return b.ToString(); }
    public static IntPtr[] Windows(uint expected) {
        var found=new List<IntPtr>();
        EnumWindows((h,_)=> { uint pid; GetWindowThreadProcessId(h,out pid); if(pid==expected && IsWindowVisible(h)) found.Add(h); return true; },IntPtr.Zero);
        return found.ToArray();
    }
    public static IntPtr[] Children(IntPtr root) {
        var found=new List<IntPtr>(); EnumChildWindows(root,(h,_)=> { found.Add(h); return true; },IntPtr.Zero); return found.ToArray();
    }
}
'@
    function Start-Setup {
        $psi = [Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $Installer
        $psi.Arguments = '/NS /D=' + $InstallDir
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        [Diagnostics.Process]::Start($psi)
    }
    function Dialogs([Diagnostics.Process]$setup) {
        if ($setup.HasExited) { return }
        $windows = @([CreatorInstallerDialogs]::Windows($setup.Id))
        if ($windows.Count -eq 0) { return }
        # A newly spawned Process object can cache an empty module list before
        # Windows loads the image. Resolve identity afresh once it owns a window.
        $image = (Get-Process -Id $setup.Id -ErrorAction SilentlyContinue).Path
        if ([string]::IsNullOrWhiteSpace($image)) { return }
        if ([IO.Path]::GetFullPath($image) -ine [IO.Path]::GetFullPath($Installer)) { throw 'Installer process identity changed.' }
        foreach ($handle in $windows) {
            if ([CreatorInstallerDialogs]::Class($handle) -ne '#32770') { continue }
            $controls = @([CreatorInstallerDialogs]::Children($handle) | ForEach-Object {
                [pscustomobject]@{ handle=$_; id=[CreatorInstallerDialogs]::GetDlgCtrlID($_); text=[CreatorInstallerDialogs]::Text($_); class=[CreatorInstallerDialogs]::Class($_) }
            })
            [pscustomobject]@{ handle=$handle; title=[CreatorInstallerDialogs]::Text($handle); text=($controls.text -join "`n"); controls=$controls }
        }
    }
    function Wait-Dialog([Diagnostics.Process]$setup, [scriptblock]$predicate) {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        do {
            $current = @(Dialogs $setup)
            $match = @($current | Where-Object $predicate)
            if ($match.Count -eq 1) { return $match[0] }
            if ($match.Count -gt 1) { throw 'Installer dialog is ambiguous.' }
            if ($setup.HasExited) { throw "Installer exited before the expected prompt: $($setup.ExitCode)." }
            Start-Sleep -Milliseconds 150
        } while ($timer.Elapsed.TotalSeconds -lt 45)
        throw ('Expected installer dialog was not observed: ' + ($current | ConvertTo-Json -Depth 5 -Compress))
    }
    function Click($dialog, [int]$id, [string]$caption) {
        $buttons = @($dialog.controls | Where-Object { $_.id -eq $id -and $_.class -eq 'Button' -and $_.text.Replace('&','') -ceq $caption })
        if ($buttons.Count -ne 1) { throw "Expected exactly one observed $caption button ($id)." }
        if (-not [CreatorInstallerDialogs]::PostMessage($dialog.handle, 0x111, [IntPtr]$id, $buttons[0].handle)) { throw 'Could not click the owned installer dialog.' }
    }
    $busy = { $_.text -like '*Creator Works MCP files are in use.*' }
    $setup = Start-Setup
    try {
        $dialog = Wait-Dialog $setup $busy
        Click $dialog 7 'No'
        # The read-only preflight closes and recreates the busy prompt.
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (@(Dialogs $setup | Where-Object $busy).Count -gt 0) {
            if ($timer.Elapsed.TotalSeconds -gt 5) { throw 'No did not dismiss the busy prompt.' }
            Start-Sleep -Milliseconds 50
        }
        $dialog = Wait-Dialog $setup $busy
        Require (-not $First.HasExited -and -not $Second.HasExited -and -not $Unrelated.HasExited) 'No stopped a process.'
        & $VerifyUnchanged
        Click $dialog 2 'Cancel'
        Require ($setup.WaitForExit(15000) -and $setup.ExitCode -eq 10) 'Busy Cancel did not exit without installation.'
        Require (-not $First.HasExited -and -not $Second.HasExited -and -not $Unrelated.HasExited) 'Cancel stopped a process.'
        & $VerifyUnchanged
    } finally { $setup.Dispose() }
    $setup = Start-Setup
    try {
        $dialog = Wait-Dialog $setup $busy
        Click $dialog 6 'Yes'
        Require ($First.WaitForExit(30000) -and $Second.WaitForExit(5000)) 'Native Yes did not stop both private runtimes.'
        Require (-not $Unrelated.HasExited) 'Native Yes stopped unrelated Node.'
        $wizard = Wait-Dialog $setup { $_.text -notlike '*files are in use*' -and @($_.controls | Where-Object { $_.id -eq 1 -and $_.class -eq 'Button' }).Count -eq 1 }
        & $VerifyUnchanged
        # Stop before the install section; silent installed-upgrade acceptance is separate.
        if (-not [CreatorInstallerDialogs]::PostMessage($wizard.handle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Cannot close the owned installer wizard.' }
        if (-not $setup.WaitForExit(2000)) {
            $quit = Wait-Dialog $setup { $_.text -match '(?i)quit|exit|cancel' -and @($_.controls | Where-Object { $_.id -eq 6 -and $_.class -eq 'Button' }).Count -eq 1 }
            Click $quit 6 'Yes'
        }
        Require ($setup.WaitForExit(15000)) 'Installer did not exit after the preflight-only UI test.'
        Require (-not $Unrelated.HasExited) 'Wizard cancellation stopped unrelated Node.'
        & $VerifyUnchanged
    } finally { $setup.Dispose() }
}
