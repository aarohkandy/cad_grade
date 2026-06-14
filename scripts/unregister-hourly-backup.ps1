$ErrorActionPreference = "Stop"

$TaskName = "CadBattleHourlyBackup"
schtasks.exe /Delete /TN $TaskName /F | Out-Host
Write-Host "Unregistered $TaskName."
