# Saves the GitHub token and/or Claude token on the VPS without them appearing on screen, in chat
# or in a file on this PC. Leave an answer blank to keep the token already saved there.
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

# Long tokens wrap across lines in a narrow terminal, and pasting them into a prompt breaks them.
# Reading from the clipboard and dropping all whitespace puts the pieces back together.
function Read-ClipboardToken([string]$what, [string]$prefix, [int]$minLength) {
    Write-Host "Copy the $what (all of it, even if it wraps onto two lines), then press Enter."
    Write-Host "Don't paste it here - just press Enter. Press Enter with nothing copied to keep the saved one."
    # Hidden input, so a token pasted here by mistake is never shown on screen.
    $typed = (Read-Secret ' ') -replace '\s', ''
    $tok = if ($typed.StartsWith($prefix) -and $typed.Length -ge $minLength) { $typed } else { ((Get-Clipboard -Raw) -replace '\s', '') }
    Set-Clipboard -Value ' '
    if (-not $tok -or -not $tok.StartsWith($prefix)) { Write-Host "  -> no $what on the clipboard, keeping the saved one."; return '' }
    if ($tok.Length -lt $minLength) { throw "That $what looks cut off ($($tok.Length) characters). Copy all of it and try again." }
    Write-Host "  -> got it ($($tok.Length) characters)."
    return $tok
}

$gh = Read-ClipboardToken 'GitHub token' 'github_pat_' 80
$cl = Read-ClipboardToken 'Claude token from "claude setup-token"' 'sk-ant-oat' 90
if (-not $gh -and -not $cl) { Write-Host 'Nothing to change.'; return }

$lines = @()
if ($gh) { $lines += "GITHUB_TOKEN=$gh" }
if ($cl) { $lines += "CLAUDE_CODE_OAUTH_TOKEN=$cl" }

$sshArgs = @()
if ($Key) { $sshArgs += @('-i', $Key) }
($lines -join "`n") | ssh @sshArgs $Server bash /opt/claude-hub/setup/save-secrets.sh
