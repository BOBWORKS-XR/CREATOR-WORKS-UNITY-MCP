param([string]$Guard, [string]$InstallDir, [string]$Mode, [int]$GonePid)
function Get-CimInstance {
    if ($Mode -eq 'throw') { throw 'Simulated CIM failure' }
    if ($Mode -eq 'hidden') { [pscustomobject]@{ ProcessId = $PID; ExecutablePath = $null } }
    if ($Mode -eq 'exited') { [pscustomobject]@{ ProcessId = $GonePid; ExecutablePath = $null } }
}
& $Guard -InstallDir $InstallDir
exit $LASTEXITCODE
