$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $RepoRoot "exports\live-backups\logs"
$LogFile = Join-Path $LogDir ("hourly-backup-" + (Get-Date -Format "yyyy-MM-dd") + ".log")
$Node = "C:\Program Files\nodejs\node.exe"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $RepoRoot

$Stamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
Add-Content -Path $LogFile -Value "[$Stamp] starting backup"

& $Node "scripts\backup-live.mjs" "--url" "https://cadbattle.vercel.app" "--out" "exports\live-backups" "--prune" "completed-hour" *>> $LogFile
$ExitCode = $LASTEXITCODE

$Done = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
Add-Content -Path $LogFile -Value "[$Done] finished backup exit=$ExitCode"

exit $ExitCode
