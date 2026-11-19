# Emits one JSON document describing templates (catalog), lab instances and capacity.
# Connects with Sean's connect-vlabresources.ps1 (uses C:\vlab\*.clixml creds), read-only queries.
param([string]$VlabRoot = 'C:\vlab')
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
Set-Location $VlabRoot
$data = & {
    $root = $VlabRoot
    . "$root\connect-vlabresources.ps1"
    $conf = Get-Content "$root\settings.cfg" | Out-String | ConvertFrom-StringData
    $vols = Get-NcVol -Volume 'lab_*' -Vserver $conf.vserver -WarningAction SilentlyContinue
    $vapps = @{}
    foreach ($a in (Get-VApp | Where-Object { $_.Name -like 'lab_*' })) {
        $gw = $a | Get-VM | Where-Object { $_.Name -like '*gateway*' } | Select-Object -First 1
        $ip = $null
        if ($gw -and $gw.Guest.IPAddress) { $ip = @($gw.Guest.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })[0] }
        $vapps[$a.Name] = @{ status = "$($a.Status)"; gatewayIp = $ip; vmCount = @($a | Get-VM).Count }
    }
    $hosts = Get-Cluster $conf.VICluster | Get-VMHost
    $aggrNames = @($vols.Aggregate | Sort-Object -Unique)
    $aggrs = foreach ($n in $aggrNames) { Get-NcAggr $n }
    $out = @{ templates = @(); instances = @() }
    foreach ($v in $vols) {
        $parent = $v.VolumeCloneAttributes.VolumeCloneParentAttributes.Name
        $item = @{
            name = $v.Name
            sizeGB = [math]::Round($v.TotalSize / 1GB, 1)
            usedPct = $v.Used
            vapp = $vapps[$v.Name]
        }
        if ($parent) { $item.parent = $parent; $out.instances += $item } else { $out.templates += $item }
    }
    $out.capacity = @{
        cpuUsedMhz  = ($hosts | Measure-Object CpuUsageMhz -Sum).Sum
        cpuTotalMhz = ($hosts | Measure-Object CpuTotalMhz -Sum).Sum
        memUsedGB   = [math]::Round(($hosts | Measure-Object MemoryUsageGB -Sum).Sum, 1)
        memTotalGB  = [math]::Round(($hosts | Measure-Object MemoryTotalGB -Sum).Sum, 1)
        diskTotalGB = [math]::Round(($aggrs | Measure-Object TotalSize -Sum).Sum / 1GB)
        diskFreeGB  = [math]::Round(($aggrs | Measure-Object Available -Sum).Sum / 1GB)
    }
    $out
}
[pscustomobject]$data | ConvertTo-Json -Depth 6 -Compress
