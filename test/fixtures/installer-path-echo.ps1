param([Parameter(Mandatory = $true)][string]$InstallDir)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[pscustomobject]@{ received = $InstallDir; normalized = [IO.Path]::GetFullPath($InstallDir); extra = @($args) } | ConvertTo-Json -Compress
