# Keeps the hub running on the laptop and restarts it if it stops (no network yet, crash, ...).
# Started hidden at login by the "Claude Hub" scheduled task that install-laptop.ps1 creates.
$hub = Join-Path $PSScriptRoot '..\hub\hub.mjs'
while ($true) {
    & node $hub
    Start-Sleep -Seconds 30
}
