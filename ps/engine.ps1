<#
    vLab Portal engine: every lab operation the portal runs. Called by the job queue as
      powershell -File engine.ps1 -Action <action> -Lab <name> [-Template <name>] [-Snapshot <name>] [-Label <text>] [-NewName <name>]
    Output lines become the job log. Any error ends the job as failed (exit 1).
#>
param(
    [Parameter(Mandatory)][ValidateSet('provision', 'start', 'stop', 'kill', 'destroy',
        'lab-snapshot', 'lab-restore', 'lab-snapdelete', 'lab-rename', 'lab-split',
        'template-enable', 'template-disable', 'template-master')][string]$Action,
    [Parameter(Mandatory)][string]$Lab,
    [string]$Template = '',
    [string]$Snapshot = '',
    [string]$Label = '',
    [int]$MaxSnapshots = 0,         # lab-snapshot: refuse when the copy already has this many portal snapshots
    [string]$NewName = '',          # lab-rename: the copy's new name; lab-split: the new template's name
    [string]$Former = ''            # lab-restore: comma-separated earlier names of the copy (see lab-rename)
)
. (Join-Path $PSScriptRoot 'common.ps1')

trap { Write-Output "ERROR: $($_.Exception.Message)"; exit 1 }

Assert-LabName $Lab
if ($Template) { Assert-LabName $Template }
if ($NewName) { Assert-LabName $NewName }
$FormerNames = @($Former -split ',' | Where-Object { $_ })
foreach ($f in $FormerNames) { Assert-LabName $f }
if ($Snapshot -and $Snapshot -notmatch '^[A-Za-z0-9_.:+-]{1,255}$') { throw "Invalid snapshot name '$Snapshot'." }
$svm = $Cfg.ontap.svm

Say "Connecting to $($Cfg.vcenter.server) and $($Cfg.ontap.cluster)..."
Connect-Lab

function Get-Vol([string]$name) { Get-NcVol -Name $name -Vserver $svm -ErrorAction SilentlyContinue }

# Gives lab $to its own copy of every network that lab $from's VMs use: a private vSwitch for
# "vSwitch backed" labs (trunked port groups), else port groups with free VLANs on the lab vSwitch.
function New-LabNetworks([string]$from, [string]$to, $srcVMs) {
    $trunked = @($srcVMs | Get-VirtualPortGroup | Where-Object { $_.VLanId -eq 4095 })
    if ($trunked.Count) {
        Say "$from uses trunked port groups: creating private vSwitches"
        $first = $true
        foreach ($vs in @($srcVMs | Where-Object { $_.Name -notlike '*gateway*' } | Get-VirtualSwitch | Sort-Object Name -Unique)) {
            # the first internal vSwitch is named after the lab; any others keep the old naming
            $vsNew = if ($first) { $to }
                     elseif ($vs.Name -like "$from*") { $to + $vs.Name.Substring($from.Length) }
                     else { "${to}_$($vs.Name)" }
            $first = $false
            Say ":: vSwitch $($vs.Name) -> $vsNew"
            $newVss = Get-LabHosts | New-VirtualSwitch -Name $vsNew -Mtu 9000
            $newVss | Get-SecurityPolicy | Set-SecurityPolicy -MacChanges $true -AllowPromiscuous $true -ForgedTransmits $true | Out-Null
            foreach ($pg in @($vs | Get-VirtualPortGroup | Sort-Object Name -Unique)) {
                $pgNew = if ($pg.Name -like "$from*") { $to + $pg.Name.Substring($from.Length) } else { "${to}_$($pg.Name)" }
                $null = $newVss | New-VirtualPortGroup -Name $pgNew -VLanId $pg.VLanId
                Say "   port group $pgNew (VLAN $($pg.VLanId))"
            }
        }
    } else {
        $used = Get-UsedVlans
        $vlan = [int]$Cfg.vcenter.vlanBase
        $hosts = @(Get-LabHosts)
        foreach ($pg in @($srcVMs | Get-VirtualPortGroup | Where-Object { $_.Name -like "$from*" } | Sort-Object Name -Unique)) {
            $pgNew = $to + $pg.Name.Substring($from.Length)
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
}

# Every standard vSwitch / port group of lab $name, on every host: the lab's own vSwitches are
# named $name or ${name}_*, its port groups ${name}_*.
function Get-LabVSwitches([string]$name) {
    foreach ($h in Get-VMHost) {
        $h | Get-VirtualSwitch -Standard -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $name -or $_.Name -like "${name}_*" } |
            ForEach-Object { [pscustomobject]@{ Host = $h; Switch = $_ } }
    }
}

# A new lab name must not clash with an existing lab. Networks are matched by name prefix
# (Repair-LabCopy, destroy), so it also must not be the start of another lab's name, nor start
# with the name of a lab copy (destroying that copy would remove the new lab's port groups).
function Assert-FreeName([string]$name) {
    if (Get-VApp -Name $name -ErrorAction SilentlyContinue) { throw "A vApp named $name already exists." }
    foreach ($v in @(Get-NcVol -Name 'lab_*' -Vserver $svm)) {
        if ($v.Name -eq $name) { throw "A volume named $name already exists." }
        if ($v.Name.StartsWith($name)) { throw "$name is the start of the existing lab $($v.Name); choose another name." }
        if ($v.VolumeCloneAttributes.VolumeCloneParentAttributes.Name -and $name.StartsWith($v.Name)) {
            throw "$name starts with the name of the lab copy $($v.Name); choose another name."
        }
    }
}

# Register-LabVMs, retried while the datastore catches up with a volume that was just mounted.
function Register-LabVMsWait([string]$labName, $vapp) {
    for ($i = 1; $i -le 12; $i++) {
        Register-LabVMs $labName $vapp (Get-TargetHost)
        if (@(Get-LabVMs $labName).Count) { return }
        Say ":: no VMs visible in [$($Cfg.ontap.datastore)] $labName yet; retrying in 10 s"
        Start-Sleep 10
    }
    throw "No VMs found in [$($Cfg.ontap.datastore)] $labName."
}

function Remove-LabVolume([string]$name) {
    $null = Dismount-NcVol -Name $name -VserverContext $svm
    $null = Set-NcVol -Name $name -Offline -VserverContext $svm
    Remove-NcVol -Name $name -VserverContext $svm -Confirm:$false
}
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

        New-LabNetworks $Template $Lab @($srcApp | Get-VM)

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
            foreach ($vs in @($h | Get-VirtualSwitch -Standard -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $Lab -or $_.Name -like "${Lab}_*" })) {
                if (-not @($vs | Get-VirtualPortGroup).Count) { $vs | Remove-VirtualSwitch -Confirm:$false; Say ":: removed vSwitch $($vs.Name) on $($h.Name)" }
            }
        }
        Remove-LabVolume $Lab
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
        # A snapshot taken before a rename still points at the lab's earlier networks and pipes.
        # Those names start with the template's name too, so reconnect them before the template's
        # (newest name first); otherwise the template pass would claim them.
        [array]::Reverse($FormerNames)
        foreach ($f in $FormerNames) { Repair-LabCopy $Lab $f }
        Repair-LabCopy $Lab $Template
        Say "Restored $Lab to $Snapshot. The lab is powered off."
    }

    'lab-rename' {
        # -Lab = current name, -NewName = new name. Renames the volume (and its folder), vApp,
        # vSwitches and port groups, then re-registers the VMs. The lab is powered off.
        $v = Assert-Clone $Lab
        if (-not $NewName -or $NewName -eq $Lab) { throw 'lab-rename needs a different -NewName.' }
        Assert-FreeName $NewName
        if ($Lab.StartsWith($NewName) -or $NewName.StartsWith($Lab)) { throw "One of $Lab and $NewName starts with the other; choose another name." }
        $vapp = Get-VApp -Name $Lab -ErrorAction SilentlyContinue
        if (-not $vapp) { throw "$Lab has no vApp in vCenter." }

        Say 'Powering off'
        Stop-LabVMs $Lab -Hard
        Say 'Removing VMs from inventory (files stay on the volume)'
        foreach ($vm in @(Get-LabVMs $Lab)) { Remove-VM -VM $vm -Confirm:$false; Say ":: $($vm.Name)" }
        Get-DrsRule -Cluster (Get-LabCluster) -Name $Lab -ErrorAction SilentlyContinue | Remove-DrsRule -Confirm:$false

        Say 'Renaming networks'
        # a standard vSwitch can't be renamed: build its twin under the new name, then remove it
        foreach ($s in @(Get-LabVSwitches $Lab)) {
            $vsNew = $NewName + $s.Switch.Name.Substring($Lab.Length)
            $sec = $s.Switch | Get-SecurityPolicy
            $nv = New-VirtualSwitch -VMHost $s.Host -Name $vsNew -Mtu $s.Switch.Mtu
            $nv | Get-SecurityPolicy | Set-SecurityPolicy -MacChanges $sec.MacChanges -AllowPromiscuous $sec.AllowPromiscuous -ForgedTransmits $sec.ForgedTransmits | Out-Null
            foreach ($pg in @($s.Switch | Get-VirtualPortGroup -Standard)) {
                $pgNew = if ($pg.Name.StartsWith($Lab)) { $NewName + $pg.Name.Substring($Lab.Length) } else { $pg.Name }
                $null = $nv | New-VirtualPortGroup -Name $pgNew -VLanId $pg.VLanId
            }
            $s.Switch | Remove-VirtualSwitch -Confirm:$false
            Say ":: vSwitch $($s.Switch.Name) -> $vsNew on $($s.Host.Name)"
        }
        foreach ($p in @(Get-PortGroupsLike "${Lab}_")) {
            $pgNew = $NewName + $p.PortGroup.Name.Substring($Lab.Length)
            $null = Set-VirtualPortGroup -VirtualPortGroup $p.PortGroup -Name $pgNew
            Say ":: port group $($p.PortGroup.Name) -> $pgNew on $($p.Host.Name)"
        }

        Say "Renaming volume $Lab -> $NewName"
        $null = Dismount-NcVol -Name $Lab -VserverContext $svm
        $null = Rename-NcVol -Name $Lab -NewName $NewName -VserverContext $svm
        $null = Mount-NcVol -Name $NewName -JunctionPath ((Get-JunctionRoot) + '/' + $NewName) -VserverContext $svm
        $vapp = Set-VApp -VApp $vapp -Name $NewName
        Say "Renamed vApp to $NewName"

        Say 'Registering VMs'
        Register-LabVMsWait $NewName $vapp
        Say 'Reconnecting networks'
        Repair-LabCopy $NewName $Lab
        Say "Renamed $Lab to $NewName. The lab is powered off."
    }

    'lab-split' {
        # -Lab = source lab copy (left as it is), -NewName = new catalog template.
        # FlexClone of the copy, split from it in ONTAP, then its own vApp, networks and master snapshot.
        $null = Assert-Clone $Lab
        if (-not $NewName) { throw 'lab-split needs -NewName.' }
        Assert-FreeName $NewName
        $srcApp = Get-VApp -Name $Lab -ErrorAction SilentlyContinue
        if (-not $srcApp) { throw "$Lab has no vApp in vCenter." }
        $srcVMs = @($srcApp | Get-VM)

        $running = @($srcVMs | Where-Object { $_.PowerState -eq 'PoweredOn' }).Count
        if ($running) { Say "Note: $running VM(s) running; the new template is crash-consistent. Shut the lab down first for a clean copy." }
        $snap = 'vlabsplit.' + (Get-Date -Format 'yyyyMMdd-HHmmss')
        $null = New-NcSnapshot -Volume $Lab -Snapshot $snap -VserverContext $svm
        Say "Snapshot $Lab@$snap"
        $junction = (Get-JunctionRoot) + '/' + $NewName
        $null = New-NcVolClone -CloneVolume $NewName -ParentVolume $Lab -ParentSnapshot $snap -JunctionPath $junction -Vserver $svm -VserverContext $svm
        Say "FlexClone $Lab@$snap -> $NewName at $junction"

        try {
            $est = Get-NcVolCloneSplitEstimate -Name $NewName -VserverContext $svm
            $aggr = Get-NcAggr (Get-Vol $NewName).Aggregate
            $needGB = [math]::Round([double]$est.EstimateBytes / 1GB, 1)
            $freeGB = [math]::Round([double]$aggr.Available / 1GB, 1)
            Say "Split needs about $needGB GB; aggregate $($aggr.Name) has $freeGB GB free"
            if ($needGB -ge $freeGB) { throw "Not enough space on $($aggr.Name) for the split ($needGB GB needed, $freeGB GB free)." }
            $null = Start-NcVolCloneSplit -Name $NewName -VserverContext $svm
        } catch {
            Say 'Removing the clone again'
            Remove-LabVolume $NewName
            Remove-NcSnapshot -Volume $Lab -Snapshot $snap -VserverContext $svm -Confirm:$false
            throw
        }
        Say 'Splitting (this copies every shared block; large labs take a while)'
        $deadline = (Get-Date).AddHours(24); $lastSay = Get-Date 0
        while ((Get-Vol $NewName).VolumeCloneAttributes.VolumeCloneParentAttributes.Name) {
            if ((Get-Date) -gt $deadline) { throw "The split of $NewName is still running after 24 hours; check it in ONTAP (volume clone split show)." }
            if (((Get-Date) - $lastSay).TotalMinutes -ge 2) {
                $p = Get-NcVolCloneSplit -Name $NewName -VserverContext $svm -ErrorAction SilentlyContinue
                # ONTAP reports each pass of the split separately, so the figure can drop back
                if ($p) { Say (":: split pass at {0}% ({1:N1} GB copied so far)" -f $p.BlockPercentageComplete, ([double]$p.BytesUpdated / 1GB)) }
                $lastSay = Get-Date
            }
            Start-Sleep 20
        }
        Say "Split finished: $NewName no longer depends on $Lab"
        Remove-NcSnapshot -Volume $Lab -Snapshot $snap -VserverContext $svm -Confirm:$false
        foreach ($s in @(Get-NcSnapshot -Volume $NewName -Vserver $svm)) {
            Remove-NcSnapshot -Volume $NewName -Snapshot $s.Name -VserverContext $svm -Confirm:$false
        }

        Say "Creating vApp $NewName"
        $vapp = New-VApp -Name $NewName -Location (Get-LabCluster)
        New-LabNetworks $Lab $NewName $srcVMs
        Say 'Registering VMs'
        Register-LabVMsWait $NewName $vapp
        Say 'Connecting networks'
        Repair-LabCopy $NewName $Lab
        $null = New-NcSnapshot -Volume $NewName -Snapshot master -VserverContext $svm
        Say "New template $NewName is in the catalog, with a 'master' snapshot. $Lab was not changed."
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
