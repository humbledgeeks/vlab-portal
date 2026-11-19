<#
    vLab Portal engine: every lab operation the portal runs. Called by the job queue as
      powershell -File engine.ps1 -Action <action> -Lab <name> [-Template <name>] [-Snapshot <name>] [-Label <text>]
    Output lines become the job log. Any error ends the job as failed (exit 1).
#>
param(
    [Parameter(Mandatory)][ValidateSet('provision', 'start', 'stop', 'kill', 'destroy',
        'lab-snapshot', 'lab-restore', 'lab-snapdelete',
        'template-enable', 'template-disable', 'template-master')][string]$Action,
    [Parameter(Mandatory)][string]$Lab,
    [string]$Template = '',
    [string]$Snapshot = '',
    [string]$Label = '',
    [int]$MaxSnapshots = 0          # lab-snapshot: refuse when the copy already has this many portal snapshots
)
. (Join-Path $PSScriptRoot 'common.ps1')

trap { Write-Output "ERROR: $($_.Exception.Message)"; exit 1 }

Assert-LabName $Lab
if ($Template) { Assert-LabName $Template }
if ($Snapshot -and $Snapshot -notmatch '^[A-Za-z0-9_.:+-]{1,255}$') { throw "Invalid snapshot name '$Snapshot'." }
$svm = $Cfg.ontap.svm

Say "Connecting to $($Cfg.vcenter.server) and $($Cfg.ontap.cluster)..."
Connect-Lab

function Get-Vol([string]$name) { Get-NcVol -Name $name -Vserver $svm -ErrorAction SilentlyContinue }
function Assert-Clone([string]$name) {
    $v = Get-Vol $name
    if (-not $v) { throw "Volume $name does not exist." }
    if (-not $v.VolumeCloneAttributes.VolumeCloneParentAttributes.Name) { throw "$name is a template, not a lab copy; refusing." }
    return $v
}

switch ($Action) {

    'provision' {
        # -Template = catalog lab to copy, -Lab = new copy name
        if (-not $Template) { throw 'provision needs -Template' }
        $tv = Get-Vol $Template
        if (-not $tv) { throw "Template volume $Template not found on $svm." }
        if ($tv.VolumeCloneAttributes.VolumeCloneParentAttributes.Name) { throw "$Template is itself a lab copy." }
        if (Get-Vol $Lab) { throw "A volume named $Lab already exists." }
        if (Get-VApp -Name $Lab -ErrorAction SilentlyContinue) { throw "A vApp named $Lab already exists." }
        $srcApp = Get-VApp -Name $Template -ErrorAction SilentlyContinue
        if (-not $srcApp) { throw "Template $Template is not enabled (no vApp). Enable it first." }

        $snap = Get-NcSnapshot -Volume $Template -Vserver $svm | Where-Object { $_.Name -eq 'master' }
        if (-not $snap) {
            $name = 'vlab_auto_' + (Get-Date -Format 'yyyyMMdd-HHmmss')
            Say "Template has no 'master' snapshot; taking $name"
            $snap = New-NcSnapshot -Volume $Template -Snapshot $name -VserverContext $svm
        }
        $junction = (Get-JunctionRoot) + '/' + $Lab
        Say "FlexClone $Template@$($snap.Name) -> $Lab at $junction"
        $null = New-NcVolClone -CloneVolume $Lab -ParentVolume $Template -ParentSnapshot $snap.Name -JunctionPath $junction -Vserver $svm -VserverContext $svm

        $targetHost = Get-TargetHost
        Say "Creating vApp $Lab (VMs on $($targetHost.Name))"
        $vapp = New-VApp -Name $Lab -Location (Get-LabCluster)

        $srcVMs = @($srcApp | Get-VM)
        $trunked = @($srcVMs | Get-VirtualPortGroup | Where-Object { $_.VLanId -eq 4095 })
        if ($trunked.Count) {
            # "vSwitch backed" labs: each internal vSwitch of the template gets a private copy
            Say 'Template uses trunked port groups: creating private vSwitches'
            foreach ($vs in @($srcVMs | Where-Object { $_.Name -notlike '*gateway*' } | Get-VirtualSwitch | Sort-Object Name -Unique)) {
                $vsNew = if ($vs.Name -like "$Template*") { $Lab + $vs.Name.Substring($Template.Length) } else { "${Lab}_$($vs.Name)" }
                Say ":: vSwitch $($vs.Name) -> $vsNew"
                $newVss = Get-LabHosts | New-VirtualSwitch -Name $vsNew -Mtu 9000
                $newVss | Get-SecurityPolicy | Set-SecurityPolicy -MacChanges $true -AllowPromiscuous $true -ForgedTransmits $true | Out-Null
                foreach ($pg in @($vs | Get-VirtualPortGroup | Sort-Object Name -Unique)) {
                    $pgNew = if ($pg.Name -like "$Template*") { $Lab + $pg.Name.Substring($Template.Length) } else { "${Lab}_$($pg.Name)" }
                    $null = $newVss | New-VirtualPortGroup -Name $pgNew -VLanId $pg.VLanId
                    Say "   port group $pgNew (VLAN $($pg.VLanId))"
                }
            }
        } else {
            $used = Get-UsedVlans
            $vlan = [int]$Cfg.vcenter.vlanBase
            $hosts = @(Get-LabHosts)
            foreach ($pg in @($srcVMs | Get-VirtualPortGroup | Where-Object { $_.Name -like "$Template*" } | Sort-Object Name -Unique)) {
                $pgNew = $Lab + $pg.Name.Substring($Template.Length)
                # a destroyed copy with the same name may have left this port group behind
                foreach ($stale in @(Get-PortGroupsLike $pgNew | Where-Object { $_.PortGroup.Name -eq $pgNew })) {
                    if (@($stale.Host | Get-VM | Get-NetworkAdapter | Where-Object NetworkName -eq $pgNew).Count) {
                        throw "Port group $pgNew already exists on $($stale.Host.Name) with VMs attached."
                    }
                    $stale.PortGroup | Remove-VirtualPortGroup -Confirm:$false
                    Say ":: removed stale port group $pgNew on $($stale.Host.Name)"
                }
                do { $vlan++ } while ($used[$vlan])
                $used[$vlan] = $true
                foreach ($h in $hosts) {
                    $vs = $h | Get-VirtualSwitch -Standard -Name $Cfg.vcenter.vswitch
                    $null = New-VirtualPortGroup -VirtualSwitch $vs -Name $pgNew -VLanId $vlan
                }
                Say ":: $($pg.Name) -> $pgNew (VLAN $vlan)"
            }
        }

        Say 'Registering VMs'
        Register-LabVMs $Lab $vapp $targetHost
        Say 'Connecting networks'
        Repair-LabCopy $Lab $Template
        if ("$($Cfg.labs.autostart)" -eq 'true') { Say 'Starting (autostart)'; $null = Get-LabVMs $Lab | Start-VM }
        Say "Lab copy $Lab is ready."
    }

    'start' {
        $vms = @(Get-LabVMs $Lab | Where-Object { $_.PowerState -ne 'PoweredOn' })
        foreach ($vm in $vms) { $null = Start-VM -VM $vm -Confirm:$false; Say ":: started $($vm.Name)" }
        if (-not $vms.Count) { Say 'All VMs are already on.' }
    }
    'stop' { Stop-LabVMs $Lab }
    'kill' { Stop-LabVMs $Lab -Hard }

    'destroy' {
        $null = Assert-Clone $Lab
        Stop-LabVMs $Lab -Hard
        Get-DrsRule -Cluster (Get-LabCluster) -Name $Lab -ErrorAction SilentlyContinue | Remove-DrsRule -Confirm:$false
        foreach ($vm in @(Get-LabVMs $Lab)) {
            Remove-VM -VM $vm -Confirm:$false               # inventory only; the files go with the volume
            Say ":: unregistered $($vm.Name)"
        }
        $vapp = Get-VApp -Name $Lab -ErrorAction SilentlyContinue
        if ($vapp) { Remove-VApp -VApp $vapp -Confirm:$false; Say "Removed vApp $Lab" }
        foreach ($p in @(Get-PortGroupsLike "${Lab}_")) {
            $p.PortGroup | Remove-VirtualPortGroup -Confirm:$false
            Say ":: removed port group $($p.PortGroup.Name) on $($p.Host.Name)"
        }
        foreach ($h in Get-VMHost) {
            foreach ($vs in @($h | Get-VirtualSwitch -Standard -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "${Lab}_*" })) {
                if (-not @($vs | Get-VirtualPortGroup).Count) { $vs | Remove-VirtualSwitch -Confirm:$false; Say ":: removed vSwitch $($vs.Name) on $($h.Name)" }
            }
        }
        $null = Dismount-NcVol -Name $Lab -VserverContext $svm
        $null = Set-NcVol -Name $Lab -Offline -VserverContext $svm
        Remove-NcVol -Name $Lab -VserverContext $svm -Confirm:$false
        Say "Deleted FlexClone volume $Lab"
    }

    'lab-snapshot' {
        $v = Assert-Clone $Lab
        if (-not $Snapshot) { throw 'lab-snapshot needs -Snapshot' }
        if ($MaxSnapshots -gt 0) {
            $base = $v.VolumeCloneAttributes.VolumeCloneParentAttributes.SnapshotName
            $have = @(Get-NcSnapshot -Volume $Lab -Vserver $svm | Where-Object { $_.Name -like 'vlab_*' -and $_.Name -ne $base }).Count
            if ($have -ge $MaxSnapshots) { throw "This lab already has $have snapshots (limit $MaxSnapshots). Delete one first." }
        }
        $running = @(Get-LabVMs $Lab | Where-Object { $_.PowerState -eq 'PoweredOn' }).Count
        if ($running) { Say "Note: $running VM(s) running; snapshot is crash-consistent." }
        $null = New-NcSnapshot -Volume $Lab -Snapshot $Snapshot -Comment ($Label.Substring(0, [Math]::Min(200, $Label.Length))) -VserverContext $svm
        Say "Snapshot $Snapshot taken of $Lab."
    }

    'lab-restore' {
        $v = Assert-Clone $Lab
        if (-not $Template) { $Template = $v.VolumeCloneAttributes.VolumeCloneParentAttributes.Name }
        if (-not (Get-NcSnapshot -Volume $Lab -Vserver $svm | Where-Object Name -eq $Snapshot)) { throw "Snapshot $Snapshot not found on $Lab." }
        $vapp = Get-VApp -Name $Lab
        Say 'Powering off'
        Stop-LabVMs $Lab -Hard
        Say 'Removing VMs from inventory (files stay on the volume)'
        foreach ($vm in @(Get-LabVMs $Lab)) { Remove-VM -VM $vm -Confirm:$false; Say ":: $($vm.Name)" }
        Say "Rolling $Lab back to $Snapshot (snapshots newer than it are removed by ONTAP)"
        $null = Restore-NcSnapshotVolume -Volume $Lab -SnapName $Snapshot -VserverContext $svm -Confirm:$false
        Say 'Registering VMs'
        Register-LabVMs $Lab $vapp (Get-TargetHost)
        Say 'Reconnecting networks'
        Repair-LabCopy $Lab $Template
        Say "Restored $Lab to $Snapshot. The lab is powered off."
    }

    'lab-snapdelete' {
        $v = Assert-Clone $Lab
        if ($Snapshot -eq $v.VolumeCloneAttributes.VolumeCloneParentAttributes.SnapshotName) { throw 'The original snapshot cannot be deleted.' }
        Remove-NcSnapshot -Volume $Lab -Snapshot $Snapshot -VserverContext $svm -Confirm:$false
        Say "Deleted snapshot $Snapshot of $Lab."
    }

    'template-enable' {
        $v = Get-Vol $Lab
        if (-not $v) { throw "Volume $Lab not found." }
        if (-not $v.JunctionPath) {
            $null = Mount-NcVol -Name $Lab -JunctionPath ((Get-JunctionRoot) + '/' + $Lab) -VserverContext $svm
            Say "Mounted $Lab"
        }
        $vapp = Get-VApp -Name $Lab -ErrorAction SilentlyContinue
        if (-not $vapp) { $vapp = New-VApp -Name $Lab -Location (Get-LabCluster); Say "Created vApp $Lab" }
        if (@($vapp | Get-VM).Count) { Say 'VMs already registered.' } else { Register-LabVMs $Lab $vapp (Get-TargetHost) }
    }

    'template-disable' {
        # Removes the template vApp from vCenter only. Volume, snapshots and port groups stay.
        $vapp = Get-VApp -Name $Lab -ErrorAction SilentlyContinue
        if (-not $vapp) { Say 'Already disabled.'; break }
        Stop-LabVMs $Lab -Hard
        Remove-VApp -VApp $vapp -Confirm:$false
        Say "Removed vApp $Lab from vCenter (volume kept). Enable re-imports it."
    }

    'template-master' {
        $old = Get-NcSnapshot -Volume $Lab -Vserver $svm | Where-Object Name -eq 'master'
        if ($old) {
            $keep = 'master.' + (Get-Date -Format 'yyyyMMdd-HHmmss')
            $null = Rename-NcSnapshot -Volume $Lab -Snapshot master -NewName $keep -VserverContext $svm
            Say "Previous master kept as $keep"
        }
        $null = New-NcSnapshot -Volume $Lab -Snapshot master -VserverContext $svm
        Say "New 'master' snapshot of $Lab. New copies start from this point."
    }
}
exit 0
