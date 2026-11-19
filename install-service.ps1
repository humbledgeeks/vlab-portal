# Registers the vLab Portal to start at boot as YOUR account (run in an elevated PowerShell).
# It must run as the same account that created C:\vlab\vicred.clixml / nccred.clixml,
# because those saved vCenter/ONTAP credentials can only be decrypted by that account.
$ErrorActionPreference = 'Stop'
$root = 'C:\vlab-portal'
$cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Windows password for the account that will run the portal'

# No quotes: cmd /c strips the first and last quote on the line, which breaks quoted paths.
# (C:\vlab-portal has no spaces, so none are needed.)
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $root `
  -Argument "/c $root\runtime\node\node.exe server.js >> $root\logs\portal.log 2>&1"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
New-Item -ItemType Directory -Force "$root\logs" | Out-Null

Register-ScheduledTask -TaskName 'vLab Portal' -Action $action -Trigger $trigger -Settings $settings `
  -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null

# stop any copy started by hand (e.g. during testing), then start the task
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -like "$root\runtime\*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 2
Start-ScheduledTask -TaskName 'vLab Portal'
Start-Sleep 5
Write-Host "Task state: $((Get-ScheduledTask -TaskName 'vLab Portal').State)"
Write-Host 'Portal: http://localhost:8090   Log: C:\vlab-portal\logs\portal.log'
