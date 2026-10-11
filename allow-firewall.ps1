# Opens the active game server port so an iPad or iPhone on the same Wi-Fi can reach the game.
# Right-click this file and choose "Run with PowerShell", or just run:
#   powershell -ExecutionPolicy Bypass -File allow-firewall.ps1

$ErrorActionPreference = 'Stop'
$port = 8080
$portFile = Join-Path $PSScriptRoot '.blocky-world-data\port.txt'
if ($env:BLOCKY_PORT -match '^\d+$') {
    $port = [int]$env:BLOCKY_PORT
} elseif (Test-Path -LiteralPath $portFile) {
    $savedPort = (Get-Content -LiteralPath $portFile -Raw).Trim()
    if ($savedPort -match '^\d+$') { $port = [int]$savedPort }
}
$rule = 'Blocky World (local network)'

# The server uses this documented range for its default port and fallback.
# Refuse stale or altered values so the helper cannot open an unrelated port.
if ($port -lt 8080 -or $port -gt 8090) {
    Write-Host 'The saved server port is outside Blocky World’s allowed range (8080–8090). Start the game server again, then retry.' -ForegroundColor Red
    pause
    exit 1
}

# Refuse to open a stale port when the manually started game server is offline.
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    Write-Host 'The server is not running yet. Double-click start.bat first, then run this script again.' -ForegroundColor Yellow
    pause
    exit 1
}

# Ask for admin once, at the top, so the rest of the script can just work.
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ''
    Write-Host 'This needs administrator rights. Opening an elevated window...' -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '"' + $PSCommandPath + '"'
    )
    return
}

Write-Host ''
Write-Host 'Blocky World - opening the firewall port' -ForegroundColor Cyan
Write-Host '------------------------------------------------'

# Remove any older copy so re-running never stacks up duplicate rules.
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule -DisplayName $rule `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $port `
    -Profile Private `
    -RemoteAddress LocalSubnet | Out-Null

Write-Host 'Rule added:' -ForegroundColor Green
Get-NetFirewallRule -DisplayName $rule |
    Format-Table DisplayName, Enabled, Direction, Action, Profile -AutoSize

# Report the addresses to use.
$addresses = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' }

Write-Host ''
Write-Host 'Open one of these in Safari on the iPad:' -ForegroundColor Cyan
$addresses | ForEach-Object { Write-Host ('   http://' + $_.IPAddress + ':' + $port) }

Write-Host ''
Write-Host 'The game server is listening - you are ready to play.' -ForegroundColor Green

Write-Host ''
pause
