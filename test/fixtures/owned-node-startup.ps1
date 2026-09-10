param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'owned-node.ps1')
$owned = Start-OwnedNode $NodePath
try {
    if ($owned.Process.WaitForExit(1000)) { throw 'Owned fixture exited before receiving its stop file.' }
    Write-Output 'Owned Node fixture started and stayed alive.'
} finally {
    Close-OwnedNode $owned
}
