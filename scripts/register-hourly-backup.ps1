$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Runner = Join-Path $RepoRoot "scripts\run-hourly-backup.ps1"
$TaskName = "CadBattleHourlyBackup"
$Start = (Get-Date).AddHours(1)
$Start = Get-Date -Hour $Start.Hour -Minute 5 -Second 0
if ($Start -lt (Get-Date).AddMinutes(5)) {
  $Start = $Start.AddHours(1)
}

$TaskCommand = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`""

if (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) {
  $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $TaskCommand
  $Trigger = New-ScheduledTaskTrigger `
    -Once `
    -At $Start `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  $Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Force | Out-Host
} else {
  $LegacyCommand = "powershell.exe $TaskCommand"
  schtasks.exe /Create /TN $TaskName /TR $LegacyCommand /SC HOURLY /MO 1 /ST $Start.ToString("HH:mm") /F | Out-Host
}

Write-Host "Registered $TaskName to run hourly starting at $($Start.ToString("HH:mm"))."
