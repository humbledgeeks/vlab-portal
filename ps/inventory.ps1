# Emits one JSON document: templates (catalog), lab copies with their snapshots, and capacity.
# Read-only. Uses the portal's own settings (config.json) and credentials (data\*.cred.xml).
. (Join-Path $PSScriptRoot 'common.ps1')
Connect-Lab
$svm = $Cfg.ontap.svm

$vols = @(Get-NcVol -Name 'lab_*' -Vserver $svm)
$vapps = @{}
foreach ($a in @(Get-VApp | Where-Object { $_.Name -like 'lab_*' })) {
    $vms = @($a | Get-VM)
    $gw = $vms | Where-Object { $_.Name -like '*gateway*' } | Select-Object -First 1
    $ip = $null
    if ($gw -and $gw.Guest.IPAddress) { $ip = @($gw.Guest.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })[0] }
    $vapps[$a.Name] = @{ status = "$($a.Status)"; gatewayIp = $ip; vmCount = $vms.Count }
}

$templates = @(); $instances = @()
foreach ($v in $vols) {
    $parent = $v.VolumeCloneAttributes.VolumeCloneParentAttributes
    $item = @{ name = $v.Name; sizeGB = [math]::Round($v.TotalSize / 1GB, 1); usedPct = $v.Used; vapp = $vapps[$v.Name] }
    if ($parent.Name) {
        $item.parent = $parent.Name
        $item.baseSnapshot = $parent.SnapshotName
        # the clone's own snapshots: the inherited base ("original") plus portal snapshots (vlab_*)
        $item.snapshots = @(Get-NcSnapshot -Volume $v.Name -Vserver $svm | Where-Object { $_.Name -like 'vlab_*' -or $_.Name -eq $parent.SnapshotName } |
            ForEach-Object {
                $when = $null
                if ($_.AccessTimeDT) { $when = $_.AccessTimeDT.ToUniversalTime().ToString('o') }
                elseif ($_.AccessTime) {
                    # depending on the NetApp.ONTAP version this is an ISO date string or Unix seconds
                    $t = "$($_.AccessTime)"
                    $when = if ($t -match '^\d+$') { [DateTimeOffset]::FromUnixTimeSeconds([int64]$t).UtcDateTime.ToString('o') }
                            else { ([DateTimeOffset]::Parse($t)).UtcDateTime.ToString('o') }
                }
                @{ name = $_.Name; created = $when; comment = "$($_.Comment)"; sizeMB = [math]::Round([double]$_.Total / 1024) }
            })
        $instances += $item
    } else {
        $item.hasMaster = [bool](Get-NcSnapshot -Volume $v.Name -Vserver $svm -SnapName master -ErrorAction SilentlyContinue)
        $templates += $item
    }
}

$hosts = @(Get-LabHosts)
$aggrs = foreach ($n in @($vols.Aggregate | Sort-Object -Unique)) { Get-NcAggr $n }
$capacity = @{
    cpuUsedMhz  = ($hosts | Measure-Object CpuUsageMhz -Sum).Sum
    cpuTotalMhz = ($hosts | Measure-Object CpuTotalMhz -Sum).Sum
    memUsedGB   = [math]::Round(($hosts | Measure-Object MemoryUsageGB -Sum).Sum, 1)
    memTotalGB  = [math]::Round(($hosts | Measure-Object MemoryTotalGB -Sum).Sum, 1)
    diskTotalGB = [math]::Round(($aggrs | Measure-Object TotalSize -Sum).Sum / 1GB)
    diskFreeGB  = [math]::Round(($aggrs | Measure-Object Available -Sum).Sum / 1GB)
}
[pscustomobject]@{ templates = $templates; instances = $instances; capacity = $capacity } | ConvertTo-Json -Depth 6 -Compress
