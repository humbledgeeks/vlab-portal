<#
.SYNOPSIS
    Removes the vLab Portal service and firewall rule. Run from an elevated PowerShell.
.DESCRIPTION
    Never touches vlab (C:\vlab), vCenter, ONTAP or any lab. Lab copies keep running.
    Only removes the scheduled task if it points at THIS folder, and only this install's
    firewall rule. By default the portal's data (users, permissions, job history) is kept
    in .\data; add -RemoveData to delete it too.
#>
param([switch]$RemoveData)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -like "$root\runtime\*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$task = Get-ScheduledTask -TaskName 'vLab Portal' -ErrorAction SilentlyContinue
if ($task -and $task.Actions[0].WorkingDirectory -eq $root) {
    Stop-ScheduledTask -TaskName 'vLab Portal' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'vLab Portal' -Confirm:$false
    Write-Host 'Removed scheduled task "vLab Portal".'
} elseif ($task) {
    Write-Host "Scheduled task 'vLab Portal' belongs to $($task.Actions[0].WorkingDirectory); left alone."
}

$port = 8090
if (Test-Path "$root\config.json") { $port = [int](Get-Content "$root\config.json" -Raw | ConvertFrom-Json).port }
Get-NetFirewallRule -Name "vLabPortal-$port" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "Removed firewall rule vLabPortal-$port."

if ($RemoveData) {
    Remove-Item (Join-Path $root 'data') -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'Deleted portal data (users, permissions, history).'
} else {
    Write-Host "Kept portal data in $root\data (use -RemoveData to delete)."
}
Write-Host 'You can now delete this folder. vlab, vCenter, ONTAP and all labs are unchanged.'
