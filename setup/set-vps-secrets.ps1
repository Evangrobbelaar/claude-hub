# Saves the GitHub token and Claude token on the VPS without them ever appearing on screen,
# in chat or in a file on this PC. Run it yourself in a terminal:
#   .\setup\set-vps-secrets.ps1 -Server root@YOUR.VPS.IP -Key $HOME\.ssh\your_key
param(
    [Parameter(Mandatory)] [string]$Server,
    [string]$Key
)
$ErrorActionPreference = 'Stop'

function Read-Secret([string]$prompt) {
    $s = Read-Host $prompt -AsSecureString
    $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}

$gh = Read-Secret 'Paste the GitHub token (github_pat_...)'
$cl = Read-Secret 'Paste the Claude token from "claude setup-token" (sk-ant-oat...)'
if (-not $gh -or -not $cl) { throw 'Both tokens are needed.' }

$sshArgs = @()
if ($Key) { $sshArgs += @('-i', $Key) }
"GITHUB_TOKEN=$gh`nCLAUDE_CODE_OAUTH_TOKEN=$cl`n" |
    ssh @sshArgs $Server "umask 077; tr -d '\r' > /etc/claude-hub.env && systemctl restart claude-hub && sleep 5 && systemctl is-active claude-hub && journalctl -u claude-hub -n 5 --no-pager -o cat"
