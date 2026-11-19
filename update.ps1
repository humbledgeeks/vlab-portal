<#
.SYNOPSIS
    Updates vLab Portal in place. Run from an elevated PowerShell in the portal folder.
.DESCRIPTION
    1. git pull (if this folder is a git clone; otherwise copy the new files over first)
    2. npm ci
    3. restart the "vLab Portal" scheduled task
    Users, permissions, lab ownership and job history live in .\data and are kept.
#>
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (Test-Path .git) {
    Write-Host '==> git pull'
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'git pull failed; resolve it and run update.ps1 again.' }
}

Write-Host '==> Backing up data\portal.db'
if (Test-Path data\portal.db) {
    $stamp = Get-Date -Format yyyyMMdd-HHmmss
    Copy-Item data\portal.db "data\portal-$stamp.db.bak"
}

Write-Host '==> npm ci'
$env:Path = "$PSScriptRoot\runtime\node;" + $env:Path
cmd /c "npm ci --omit=dev --no-audit --no-fund --loglevel=error 2>&1"
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

Write-Host '==> Restarting the portal'
Stop-ScheduledTask -TaskName 'vLab Portal' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -like "$PSScriptRoot\runtime\*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName 'vLab Portal'
Start-Sleep 5
Write-Host "Task state: $((Get-ScheduledTask -TaskName 'vLab Portal').State). Log: $PSScriptRoot\logs\portal.log"
