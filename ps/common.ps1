# Shared helpers for the vLab Portal engine: settings, credentials, connections.
# Dot-source this file. Settings come from ..\config.json; credentials from ..\data\*.cred.xml
# (Export-Clixml, encrypted for the Windows account that runs the portal).
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$PortalRoot = Split-Path $PSScriptRoot -Parent
$Cfg = Get-Content (Join-Path $PortalRoot 'config.json') -Raw | ConvertFrom-Json
$LabNamePattern = '^lab_[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$'

function Assert-LabName([string]$name) {
    if ($name -notmatch $LabNamePattern) { throw "Invalid lab name '$name'." }
}

function Say([string]$text) { Write-Output $text }   # job log line

function Connect-Lab {
    Import-Module VMware.VimAutomation.Core -WarningAction SilentlyContinue
    Import-Module NetApp.ONTAP -WarningAction SilentlyContinue
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $null = Set-PowerCLIConfiguration -Scope Session -InvalidCertificateAction Ignore -ParticipateInCEIP $false `
        -DisplayDeprecationWarnings $false -Confirm:$false
    $vc = Import-Clixml (Join-Path $PortalRoot 'data\vcenter.cred.xml')
    $nc = Import-Clixml (Join-Path $PortalRoot 'data\ontap.cred.xml')
    $null = Connect-VIServer -Server $Cfg.vcenter.server -Credential $vc
    $null = Connect-NcController $Cfg.ontap.cluster -Vserver $Cfg.ontap.svm -Credential $nc
}

function Get-LabCluster { Get-Cluster -Name $Cfg.vcenter.cluster }
function Get-LabHosts { Get-LabCluster | Get-VMHost }
function Get-JunctionRoot {
    if ($Cfg.ontap.junctionRoot) { return $Cfg.ontap.junctionRoot.TrimEnd('/') }
    return '/' + $Cfg.ontap.datastore
}

# The cluster host with the most free memory (where new copies are registered).
function Get-TargetHost {
    Get-LabHosts | Where-Object { $_.ConnectionState -eq 'Connected' } |
        Sort-Object { $_.MemoryTotalGB - $_.MemoryUsageGB } | Select-Object -Last 1
}

# Standard port groups named like $prefix* on EVERY host vCenter knows (not only the cluster),
# so leftovers on hosts outside the cluster are found too.
function Get-PortGroupsLike([string]$prefix) {
    foreach ($h in Get-VMHost) {
        $h | Get-VirtualPortGroup -Standard -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix*" } |
            ForEach-Object { [pscustomobject]@{ Host = $h; PortGroup = $_ } }
    }
}

# All VLAN IDs in use on the lab vSwitch of any host (avoid reusing one anywhere).
function Get-UsedVlans {
    $used = @{}
    foreach ($h in Get-VMHost) {
        $h | Get-VirtualPortGroup -Standard -ErrorAction SilentlyContinue | ForEach-Object { $used[[int]$_.VLanId] = $true }
    }
    return $used
}

# Re-registers every VM found in the lab's folder on the datastore into the vApp.
function Register-LabVMs([string]$labName, $vapp, $vmHost) {
    $ds = Get-Datastore -Name $Cfg.ontap.datastore | ForEach-Object { Get-View $_.Id }
    $spec = New-Object VMware.Vim.HostDatastoreBrowserSearchSpec
    $spec.MatchPattern = '*.vmx'
    $browser = Get-View $ds.Browser
    $results = $browser.SearchDatastoreSubFolders("[$($ds.Summary.Name)] $labName", $spec) |
        Where-Object { $_.FolderPath -notmatch '\.snapshot' }
    foreach ($folder in $results) {
        foreach ($file in $folder.File) {
            $vmx = $folder.FolderPath.TrimEnd('/') + '/' + $file.Path
            $vm = New-VM -VMFilePath $vmx -VMHost $vmHost -ResourcePool $vapp
            # New-VM can leave the VM in the cluster's root pool; move it into the vApp explicitly
            $move = New-Object VMware.Vim.VirtualMachineRelocateSpec
            $move.Pool = $vapp.ExtensionData.MoRef
            $vm.ExtensionData.RelocateVM($move, [VMware.Vim.VirtualMachineMovePriority]::defaultPriority)
            Say ":: registered $($vm.Name)"
        }
    }
}

# Every VM belonging to a lab: members of its vApp plus any VM whose files live in the lab's
# folder on the datastore (catches VMs that ended up outside the vApp).
function Get-LabVMs([string]$labName) {
    $byId = @{}
    foreach ($vm in @(Get-VApp -Name $labName -ErrorAction SilentlyContinue | Get-VM)) { $byId[$vm.Id] = $vm }
    $prefix = "[$($Cfg.ontap.datastore)] $labName/"
    # StartsWith, not -like: '[datastore]' would be read as a wildcard character set
    foreach ($vm in @(Get-VM | Where-Object { "$($_.ExtensionData.Config.Files.VmPathName)".StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })) { $byId[$vm.Id] = $vm }
    return @($byId.Values)
}

# Makes a lab copy's VMs use the copy's own networks, serial pipes and uuid policy.
# Idempotent: run after provisioning and again after every restore (a restored .vmx
# may point at the template's networks again).
function Repair-LabCopy([string]$copy, [string]$template) {
    $vapp = Get-VApp -Name $copy
    $vms = @(Get-LabVMs $copy)
    foreach ($vm in $vms) {
        if ($vm.ExtensionData.ResourcePool.Value -ne $vapp.ExtensionData.MoRef.Value) {
            $move = New-Object VMware.Vim.VirtualMachineRelocateSpec
            $move.Pool = $vapp.ExtensionData.MoRef
            $vm.ExtensionData.RelocateVM($move, [VMware.Vim.VirtualMachineMovePriority]::defaultPriority)
            Say ":: moved $($vm.Name) into vApp $copy"
        }
        $isGateway = $vm.Name -like '*gateway*'
        $wanDone = $false
        foreach ($nic in @($vm | Get-NetworkAdapter)) {
            $net = $nic.NetworkName
            if ($net -like "$copy*") { continue }                                       # already the copy's network
            if ($net -like "$template*") {
                $target = $copy + $net.Substring($template.Length)
                if ($nic.NetworkName -ne $target) {
                    $null = $nic | Set-NetworkAdapter -NetworkName $target -Confirm:$false
                    Say ":: $($vm.Name): $net -> $target"
                }
            } elseif ($isGateway -and -not $wanDone) {
                if ($net -ne $Cfg.vcenter.wanPortgroup) {
                    $null = $nic | Set-NetworkAdapter -NetworkName $Cfg.vcenter.wanPortgroup -Confirm:$false
                    Say ":: $($vm.Name): WAN $net -> $($Cfg.vcenter.wanPortgroup)"
                }
                $wanDone = $true
            }
        }
        # serial ports wired as named pipes (e.g. ONTAP simulators) must not collide with the template
        foreach ($dev in @($vm.ExtensionData.Config.Hardware.Device | Where-Object { $_ -is [VMware.Vim.VirtualSerialPort] })) {
            $pipe = $dev.Backing.PipeName
            if ($pipe -and $pipe -like "*$template*" -and $pipe -notlike "*$copy*") {
                $newPipe = $pipe.Replace($template, $copy)
                $change = New-Object VMware.Vim.VirtualDeviceConfigSpec
                $change.Operation = 'edit'; $change.Device = $dev; $change.Device.Backing.PipeName = $newPipe
                $cfgSpec = New-Object VMware.Vim.VirtualMachineConfigSpec; $cfgSpec.DeviceChange = $change
                $vm.ExtensionData.ReconfigVM($cfgSpec)
                Say ":: $($vm.Name): serial pipe $pipe -> $newPipe"
            }
        }
        $null = $vm | New-AdvancedSetting -Name uuid.action -Value keep -Confirm:$false -Force -WarningAction SilentlyContinue
    }
    # keep a copy's VMs on one host (internal lab networks are host-local port groups)
    $cluster = Get-LabCluster
    Get-DrsRule -Cluster $cluster -Name $copy -ErrorAction SilentlyContinue | Remove-DrsRule -Confirm:$false
    if ($vms.Count -gt 1) { $null = New-DrsRule -Cluster $cluster -Name $copy -KeepTogether $true -VM (Get-LabVMs $copy) }
}

function Stop-LabVMs([string]$name, [switch]$Hard) {
    $vms = @(Get-LabVMs $name | Where-Object { $_.PowerState -ne 'PoweredOff' })
    if (-not $vms.Count) { Say 'All VMs are already off.'; return }
    if ($Hard) {
        foreach ($vm in $vms) { $null = Stop-VM -VM $vm -Confirm:$false; Say ":: powered off $($vm.Name)" }
        return
    }
    foreach ($vm in $vms) {
        try { $null = Stop-VMGuest -VM $vm -Confirm:$false; Say ":: shutdown requested: $($vm.Name)" }
        catch { Say ":: $($vm.Name): no VMware Tools, powering off"; $null = Stop-VM -VM $vm -Confirm:$false }
    }
}
