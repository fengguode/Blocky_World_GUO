# Opens port 8080 so an iPad or iPhone on the same Wi-Fi can reach the game.
# Right-click this file and choose "Run with PowerShell", or just run:
#   powershell -ExecutionPolicy Bypass -File allow-firewall.ps1

$ErrorActionPreference = 'Stop'
$port = 8080
$rule = 'Blocky World (local network)'

# Ask for admin once, at the top, so the rest of the script can just work.
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ''
    Write-Host 'This needs administrator rights. Opening an elevated window...' -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '"' + $PSCommandPath + '"', '-NoRelaunch'
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
    -Program 'C:\Program Files\nodejs\node.exe' | Out-Null

Write-Host 'Rule added:' -ForegroundColor Green
Get-NetFirewallRule -DisplayName $rule |
    Format-Table DisplayName, Enabled, Direction, Action, Profile -AutoSize

# Report the addresses to use.
$addresses = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' }

Write-Host ''
Write-Host 'Open one of these in Safari on the iPad:' -ForegroundColor Cyan
$addresses | ForEach-Object { Write-Host ('   http://' + $_.IPAddress + ':' + $port) }

# Confirm something is actually listening, so the advice is never a dead end.
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host ''
    Write-Host 'The game server is listening - you are ready to play.' -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host 'The server is not running yet. Double-click start.bat first,' -ForegroundColor Yellow
    Write-Host 'then run this script again.' -ForegroundColor Yellow
}

Write-Host ''
pause
