<#
.SYNOPSIS
    Installs vLab Portal (vLab 2.0) on a Windows Server. Self-contained: does not need vlab 1.x.

.DESCRIPTION
    GREENFIELD  - nothing installed yet. The installer asks for your vCenter / ONTAP settings and
                  credentials (like vlab 1.x's install), installs the VCF.PowerCLI and NetApp.ONTAP
                  PowerShell modules, and sets everything up.

    BROWNFIELD  - vlab 1.x is installed (default C:\vlab, detected by its settings.cfg). The installer
                  imports its settings, its saved vCenter/ONTAP credentials, lab descriptions, diagrams
                  and per-lab RDP overrides, once. Existing lab templates and lab copies show up in the
                  portal automatically. vlab 1.x itself is left untouched and keeps working.

    Then, in both cases it:
      * downloads a private Node.js 24 LTS runtime into .\runtime (checksum verified; nothing is
        installed system-wide, an existing Node.js is not touched)
      * installs the portal's one npm dependency (express)
      * writes config.json and saves credentials in .\data (encrypted for this Windows account)
      * opens the portal port in Windows Firewall
      * registers a scheduled task "vLab Portal" that starts the portal at boot as YOU

    Run from an elevated Windows PowerShell, signed in as the account the portal should run as.
    Safe to re-run: existing settings, credentials and users are kept.

.EXAMPLE
    .\install.ps1
.EXAMPLE
    .\install.ps1 -GuacamoleUrl http://10.0.0.5:8085/guacamole -GuacamoleKey 0123456789abcdef0123456789abcdef
.EXAMPLE
    .\install.ps1 -LegacyVlabRoot D:\vlab        # brownfield with vlab 1.x somewhere else
#>
[CmdletBinding()]
param(
    [string]$LegacyVlabRoot = 'C:\vlab',
    [int]$Port = 8090,
    [string]$GuacamoleUrl = '',
    [string]$GuacamoleKey = '',
    [string]$NodeVersion = 'v24.22.3',
    [switch]$SkipService,        # don't register the scheduled task (e.g. to test)
    [switch]$SkipCredentials,    # don't prompt for vCenter/ONTAP credentials
    [switch]$Greenfield,         # ignore a legacy vlab even if one is found
    [string]$SettingsFile = ''   # greenfield, unattended: JSON file with the settings (see README)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$PortalRoot = $PSScriptRoot
$DataDir = Join-Path $PortalRoot 'data'
$CatalogDir = Join-Path $PortalRoot 'catalog'
$CfgPath = Join-Path $PortalRoot 'config.json'

function Step($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "    $text" }
function Warn($text) { Write-Host "    ! $text" -ForegroundColor Yellow }
function Ask($prompt, $default) {
    $suffix = ''; if ("$default") { $suffix = " [$default]" }
    $answer = Read-Host "    $prompt$suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return "$default" }
    return $answer.Trim()
}
function AskRequired($prompt, $default) { do { $v = Ask $prompt $default } while ([string]::IsNullOrWhiteSpace($v)); return $v }
function ReadKV($file) {
    $h = @{}
    foreach ($line in Get-Content $file) {
        $i = $line.IndexOf('='); if ($i -gt 0) { $h[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim() }
    }
    return $h
}
function Lock-Down($path) {
    # only this account, SYSTEM and Administrators
    & icacls $path /inheritance:r /grant "$($identity.Name):(OI)(CI)F" /grant '*S-1-5-18:(OI)(CI)F' /grant '*S-1-5-32-544:(OI)(CI)F' | Out-Null
}

# ------------------------------------------------------------------------------- checks
Step 'Checking prerequisites'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (Run as administrator).'
}
if ($PSVersionTable.PSVersion.Major -ne 5) { Warn "Use 'Windows PowerShell' 5.1 (powershell.exe), not pwsh $($PSVersionTable.PSVersion)." }
if ($PortalRoot -match '\s') { throw "Install the portal in a path without spaces (now: $PortalRoot). C:\vlab-portal is recommended." }
New-Item -ItemType Directory -Force $DataDir, $CatalogDir, (Join-Path $PortalRoot 'logs') | Out-Null
Lock-Down $DataDir
Info "Portal folder : $PortalRoot"
Info "Runs as      : $($identity.Name)"

$cfg = $null
if (Test-Path $CfgPath) { $cfg = Get-Content $CfgPath -Raw | ConvertFrom-Json }
$configured = $cfg -and $cfg.vcenter -and $cfg.vcenter.server
$legacyCfg = Join-Path $LegacyVlabRoot 'settings.cfg'
$mode = if ($configured) { 'reinstall' } elseif ((Test-Path $legacyCfg) -and -not $Greenfield) { 'brownfield' } else { 'greenfield' }
Info "Mode         : $mode"

# ------------------------------------------------------------------------------ settings
if (-not $configured) {
    $oldCfg = $cfg
    $s = [ordered]@{}
    if ($mode -eq 'brownfield') {
        Step "Brownfield: importing settings from $legacyCfg"
        $old = ReadKV $legacyCfg
        $s.siteName = $old.sitename; $s.vcenter = $old.vCenter; $s.cluster = $old.VICluster; $s.vswitch = $old.vswitch
        $s.wanPortgroup = $old.VIPortgroup; $s.vlanBase = $old.vlanbase; $s.ontapCluster = $old.cluster_mgmt
        $s.svm = $old.vserver; $s.datastore = $old.VIDatastore; $s.firstId = $old.newID; $s.autostart = $old.autostart
        $s.rdpDomain = $old.rdpdomain; $s.rdpUser = $old.rdpuser; $s.rdpPassword = $old.rdppassword
        foreach ($k in $s.Keys) { if ($k -ne 'rdpPassword') { Info ("{0,-13} {1}" -f $k, $s[$k]) } }
    } else {
        Step 'Greenfield: lab infrastructure settings'
        $preset = @{}
        if ($SettingsFile) { (Get-Content $SettingsFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $preset[$_.Name] = [string]$_.Value } }
        $fields = [ordered]@{
            siteName     = @('Portal name shown in the browser', 'vLab Portal')
            vcenter      = @('vCenter server (FQDN or IP)', '')
            cluster      = @('vSphere cluster that runs the labs', '')
            vswitch      = @('Standard vSwitch for lab port groups (must exist on every host of that cluster)', 'vSwitch0')
            wanPortgroup = @('Port group for the lab gateways'' WAN side', 'VM Network')
            vlanBase     = @('Lab VLANs are allocated above this number (your switches must trunk the range)', '1000')
            ontapCluster = @('ONTAP cluster management address', '')
            svm          = @('ONTAP SVM that holds the lab volumes', '')
            datastore    = @('NFS datastore (from that SVM) whose junction holds the lab volumes', '')
            firstId      = @('Lab copies are numbered after this', '1000')
            autostart    = @('Start lab copies right after provisioning (true/false)', 'false')
            rdpDomain    = @('Default RDP domain for lab jumphosts', 'lab')
            rdpUser      = @('Default RDP user for lab jumphosts', 'administrator')
        }
        foreach ($k in $fields.Keys) {
            if ($preset.ContainsKey($k)) { $s[$k] = $preset[$k] } else { $s[$k] = AskRequired $fields[$k][0] $fields[$k][1] }
        }
        if ($preset.ContainsKey('rdpPassword')) { $s.rdpPassword = $preset.rdpPassword } else {
            $sec = Read-Host '    Default RDP password for lab jumphosts' -AsSecureString
            $s.rdpPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
        }
    }
    $cfg = [pscustomobject][ordered]@{
        port = $Port; inventoryIntervalSec = 60; maxConcurrentJobs = 2; secureCookies = $false
        site    = [pscustomobject][ordered]@{ name = $(if ($s.siteName) { $s.siteName } else { 'vLab Portal' }) }
        vcenter = [pscustomobject][ordered]@{ server = $s.vcenter; cluster = $s.cluster; vswitch = $s.vswitch; wanPortgroup = $s.wanPortgroup; vlanBase = [int]$s.vlanBase }
        ontap   = [pscustomobject][ordered]@{ cluster = $s.ontapCluster; svm = $s.svm; datastore = $s.datastore; junctionRoot = '' }
        labs    = [pscustomobject][ordered]@{ firstId = [int]$s.firstId; autostart = ("$($s.autostart)" -eq 'true'); maxSnapshotsPerLab = 5 }
        rdp     = [pscustomobject][ordered]@{ domain = $s.rdpDomain; user = $s.rdpUser; password = $s.rdpPassword }
        guacamole = [pscustomobject][ordered]@{ url = ''; jsonSecretKey = '' }
    }
    # an older config.json (portal 0.1) may already hold the Guacamole settings: keep them
    if ($oldCfg -and $oldCfg.guacamole) { $cfg.guacamole = $oldCfg.guacamole; Info 'Kept Guacamole settings from the previous config.json' }
    if ($oldCfg -and $oldCfg.port) { $cfg.port = [int]$oldCfg.port }
    foreach ($k in 'vcenter', 'cluster', 'ontapCluster', 'svm', 'datastore') { if (-not $s[$k]) { throw "Setting '$k' is empty." } }
} else {
    Step 'Keeping existing settings (config.json)'
    Info "vCenter $($cfg.vcenter.server) / cluster $($cfg.vcenter.cluster); ONTAP $($cfg.ontap.cluster) / SVM $($cfg.ontap.svm)"
}

# ------------------------------------------------------ brownfield: descriptions & diagrams
if ($mode -eq 'brownfield') {
    $cmdb = Join-Path $LegacyVlabRoot 'cmdb'
    if (Test-Path $cmdb) {
        Step "Brownfield: importing catalog descriptions and diagrams from $cmdb"
        $n = 0
        foreach ($f in Get-ChildItem $cmdb -File | Where-Object { $_.Extension -in '.jpg', '.png', '.conf' -or $_.Name -eq 'descriptions.tbl' }) {
            $dest = Join-Path $CatalogDir $f.Name
            if (-not (Test-Path $dest)) { Copy-Item $f.FullName $dest; $n++ }
        }
        Info "$n file(s) copied to $CatalogDir"
    }
}

# --------------------------------------------------------------------- PowerShell modules
Step 'PowerShell modules (VCF.PowerCLI, NetApp.ONTAP)'
$need = @()
if (-not (Get-Module -ListAvailable VMware.VimAutomation.Core)) { $need += 'VCF.PowerCLI' }
if (-not (Get-Module -ListAvailable NetApp.ONTAP)) { $need += 'NetApp.ONTAP' }
if ($need.Count) {
    if (-not (Get-PackageProvider -ListAvailable -Name NuGet -ErrorAction SilentlyContinue | Where-Object { $_.Version -ge '2.8.5.201' })) {
        Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force | Out-Null
    }
    foreach ($m in $need) {
        Info "Installing $m from the PowerShell Gallery (a few minutes)..."
        Install-Module -Name $m -Scope AllUsers -Force -AllowClobber -Repository PSGallery
    }
} else { Info 'Already installed.' }
Import-Module VMware.VimAutomation.Core -WarningAction SilentlyContinue
Set-PowerCLIConfiguration -Scope AllUsers -ParticipateInCEIP $false -InvalidCertificateAction Ignore `
    -DisplayDeprecationWarnings $false -Confirm:$false | Out-Null

# ---------------------------------------------------------------------------- credentials
$credFiles = @(
    @{ File = Join-Path $DataDir 'vcenter.cred.xml'; Legacy = Join-Path $LegacyVlabRoot 'vicred.clixml'; What = "vCenter $($cfg.vcenter.server)" },
    @{ File = Join-Path $DataDir 'ontap.cred.xml'; Legacy = Join-Path $LegacyVlabRoot 'nccred.clixml'; What = "ONTAP cluster $($cfg.ontap.cluster)" }
)
if (-not $SkipCredentials) {
    Step 'vCenter / ONTAP credentials (saved in .\data, encrypted for this Windows account only)'
    foreach ($c in $credFiles) {
        $ok = $false
        if (Test-Path $c.File) {
            try { $null = Import-Clixml $c.File; $ok = $true; Info "Using saved credentials for $($c.What)" }
            catch { Warn "Can't read saved credentials for $($c.What): $($_.Exception.Message)" }
        }
        if (-not $ok -and $mode -eq 'brownfield' -and (Test-Path $c.Legacy)) {
            try { $cred = Import-Clixml $c.Legacy; $cred | Export-Clixml $c.File; $ok = $true; Info "Imported vlab 1.x credentials for $($c.What)" }
            catch { Warn "Can't read vlab 1.x credentials for $($c.What): $($_.Exception.Message)"; Warn 'Run the installer from a normal (RDP/console) logon as the account that saved them, or enter them again below.' }
        }
        if (-not $ok) {
            $cred = Get-Credential -Message "Credentials for $($c.What)"
            if (-not $cred) { throw "No credentials entered for $($c.What)." }
            $cred | Export-Clixml $c.File
            Info "Saved credentials for $($c.What)"
        }
    }
    Step 'Testing the connections'
    try {
        Import-Module NetApp.ONTAP -WarningAction SilentlyContinue
        $null = Connect-VIServer -Server $cfg.vcenter.server -Credential (Import-Clixml $credFiles[0].File) -ErrorAction Stop
        $cl = Get-Cluster -Name $cfg.vcenter.cluster -ErrorAction Stop
        Info "vCenter OK: cluster $($cl.Name), $(@($cl | Get-VMHost).Count) host(s)"
        $null = Connect-NcController $cfg.ontap.cluster -Vserver $cfg.ontap.svm -Credential (Import-Clixml $credFiles[1].File) -ErrorAction Stop
        Info "ONTAP OK: $(@(Get-NcVol -Name 'lab_*' -Vserver $cfg.ontap.svm).Count) lab volume(s) on SVM $($cfg.ontap.svm)"
    } catch {
        Warn "Connection test failed: $($_.Exception.Message)"
        Warn 'Fix the setting or credentials (re-run with the right values, or delete data\*.cred.xml), then re-run.'
    }
}

# ------------------------------------------------------------------------ Node.js runtime
Step "Node.js $NodeVersion (private copy in .\runtime\node)"
$nodeExe = Join-Path $PortalRoot 'runtime\node\node.exe'
$have = if (Test-Path $nodeExe) { (& $nodeExe -v) } else { '' }
if ($have -ne $NodeVersion) {
    $zipName = "node-$NodeVersion-win-x64.zip"
    $zip = Join-Path $env:TEMP $zipName
    Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$zipName" -OutFile $zip -UseBasicParsing
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
    $expected = (($sums -split "`n") | Where-Object { $_ -match " $([regex]::Escape($zipName))$" }) -split '\s+' | Select-Object -First 1
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) { throw "Node.js download failed its checksum ($actual)." }
    Info 'Checksum verified.'
    $rt = Join-Path $PortalRoot 'runtime'
    if (Test-Path "$rt\node") { Remove-Item "$rt\node" -Recurse -Force }
    New-Item -ItemType Directory -Force $rt | Out-Null
    Expand-Archive $zip $rt -Force
    Rename-Item (Join-Path $rt "node-$NodeVersion-win-x64") 'node'
    Remove-Item $zip
}
Info ((& $nodeExe -v) + ' ready.')

Step 'Portal dependencies (npm ci)'
Push-Location $PortalRoot
try {
    $env:Path = (Join-Path $PortalRoot 'runtime\node') + ';' + $env:Path
    cmd /c "npm ci --omit=dev --no-audit --no-fund --loglevel=error 2>&1"
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed (see above). The server needs HTTPS access to registry.npmjs.org.' }
} finally { Pop-Location }

# ---------------------------------------------------------------------- config.json + guac
Step 'Remote desktop (Apache Guacamole)'
if ($GuacamoleUrl) { $cfg.guacamole.url = $GuacamoleUrl }
if ($GuacamoleKey) { $cfg.guacamole.jsonSecretKey = $GuacamoleKey }
if (-not $cfg.guacamole.url) {
    Info 'Optional; see README "Remote desktop". Press Enter to skip for now.'
    $cfg.guacamole.url = Ask 'Guacamole URL, e.g. http://10.0.0.5:8085/guacamole' ''
    if ($cfg.guacamole.url -and -not $cfg.guacamole.jsonSecretKey) { $cfg.guacamole.jsonSecretKey = Ask 'Guacamole JSON secret key (32 hex characters)' '' }
}
if ($cfg.guacamole.jsonSecretKey -and $cfg.guacamole.jsonSecretKey -notmatch '^[0-9a-fA-F]{32}$') {
    throw 'The Guacamole key must be exactly 32 hex characters (printed by guacamole/install-guacamole.sh).'
}
Info $(if ($cfg.guacamole.url) { "Connect button uses $($cfg.guacamole.url)" } else { 'Connect button off until configured.' })
$cfg | ConvertTo-Json -Depth 5 | Set-Content $CfgPath -Encoding ASCII
& icacls $CfgPath /inheritance:r /grant "$($identity.Name):F" /grant '*S-1-5-18:F' /grant '*S-1-5-32-544:F' | Out-Null
$Port = [int]$cfg.port

# ------------------------------------------------------------------------------- firewall
Step "Windows Firewall: allow TCP $Port"
$ruleName = "vLabPortal-$Port"
if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName "vLab Portal (TCP $Port)" -Protocol TCP -LocalPort $Port -Direction Inbound -Action Allow | Out-Null
}
Info 'Done.'

# ------------------------------------------------------------------------- scheduled task
if ($SkipService) {
    Step 'Skipping the scheduled task (-SkipService). Start by hand with: .\runtime\node\node.exe server.js'
} else {
    Step "Scheduled task 'vLab Portal' (starts at boot as $($identity.Name))"
    $cred = Get-Credential -UserName $identity.Name -Message "Windows password for $($identity.Name) (the task runs as this account)"
    if (-not $cred) { throw 'A password is needed to run the portal at boot.' }
    # No quotes inside /c: cmd strips the first and last quote on the line. The path has no spaces (checked above).
    $arg = "/c $PortalRoot\runtime\node\node.exe --disable-warning=ExperimentalWarning server.js >> $PortalRoot\logs\portal.log 2>&1"
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg -WorkingDirectory $PortalRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Stop-ScheduledTask -TaskName 'vLab Portal' -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -like "$PortalRoot\runtime\*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Register-ScheduledTask -TaskName 'vLab Portal' -Action $action -Trigger $trigger -Settings $settings `
        -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null
    Start-ScheduledTask -TaskName 'vLab Portal'
    $ok = $false
    for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
        Start-Sleep 1
        try { $ok = (Invoke-WebRequest "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { }
    }
    if ($ok) { Info 'Portal is running.' } else { Warn "Portal did not answer yet. Check $PortalRoot\logs\portal.log" }
}

# ---------------------------------------------------------------------------------- done
$hostName = ([System.Net.Dns]::GetHostEntry($env:COMPUTERNAME)).HostName
Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host " vLab Portal installed ($mode)" -ForegroundColor Green
Write-Host "   URL : http://$hostName`:$Port"
$pw = Join-Path $DataDir 'initial-admin-password.txt'
if ((Test-Path $pw) -or -not (Test-Path (Join-Path $DataDir 'portal.db'))) {
    Write-Host "   First sign-in: user 'admin', one-time password in $pw (created when the portal first starts)"
}
if ($mode -eq 'brownfield') { Write-Host '   vlab 1.x was not changed; its portal (port 8081) can be retired. See README.' }
if (-not $cfg.guacamole.url) { Write-Host '   Connect button is off until Guacamole is set up; see README "Remote desktop".' }
Write-Host '============================================================' -ForegroundColor Green
