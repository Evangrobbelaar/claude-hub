# Makes the Claude Hub start (hidden) every time you log in to Windows, and starts it now.
# Re-run any time; it replaces the existing task.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$config = Join-Path $root 'hub\hub.config.json'
if (-not (Test-Path $config)) {
    Copy-Item (Join-Path $root 'hub\hub.config.example.json') $config
    Write-Host "Created $config - edit localProjects to list your project folders."
}

$start = Join-Path $PSScriptRoot 'start-hub.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Claude Hub' -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Pulls your projects and runs instructions sent from the Claude Hub phone app.' -Force | Out-Null

Start-ScheduledTask -TaskName 'Claude Hub'
Write-Host "Claude Hub installed and started. Log: $env:USERPROFILE\.claude-hub\hub.log"
