<#
.SYNOPSIS
    Installs vLab Portal (vLab 2.0) on a Windows Server.

.DESCRIPTION
    Works for both kinds of site:

    BROWNFIELD  - madlabber/vlab is already installed (default C:\vlab with settings.cfg and
                  the saved vicred/nccred.clixml). The portal reuses it as-is: same settings,
                  same saved credentials, same lab templates and lab copies. The legacy portal
                  on port 8081 keeps working until you retire it.

    GREENFIELD  - no vlab yet. The installer downloads madlabber/vlab (pinned commit) into
                  C:\vlab, asks for your vCenter / ONTAP settings, installs the PowerCLI and
                  NetApp.ONTAP modules and saves the credentials.

    Then, in both cases it:
      * downloads a private Node.js 24 LTS runtime into .\runtime (checksum verified;
        nothing is installed system-wide, an existing Node.js is not touched)
      * installs the portal's one npm dependency (express)
      * writes config.json (port, vlab path, optional Guacamole remote-desktop settings)
      * enables PowerShell remoting on localhost if needed (vlab's scripts use it)
      * opens the portal port in Windows Firewall
      * registers a scheduled task "vLab Portal" that starts the portal at boot as YOU

    Run it from an elevated PowerShell, logged on as the account the portal should run as.
    That account must be the one that owns vlab's saved credentials (clixml files are
    encrypted for one Windows user only).

.EXAMPLE
    .\install.ps1
    Interactive install. Detects brownfield/greenfield by looking for C:\vlab\settings.cfg.

.EXAMPLE
    .\install.ps1 -GuacamoleUrl http://10.0.0.5:8085/guacamole -GuacamoleKey 0123456789abcdef0123456789abcdef
    Same, and enables the Connect (browser remote desktop) button.
#>
[CmdletBinding()]
param(
    [string]$VlabRoot = 'C:\vlab',
    [int]$Port = 8090,
    [string]$GuacamoleUrl = '',
    [string]$GuacamoleKey = '',
    [string]$NodeVersion = 'v24.22.3',
    [string]$VlabRepo = 'madlabber/vlab',
    [string]$VlabCommit = 'da460da10e8e8e6ac516439310334bacc049f385',
    [switch]$SkipService,        # don't register the scheduled task (e.g. to test)
    [switch]$SkipCredentials,    # don't prompt for vCenter/ONTAP credentials
    [string]$SettingsFile = ''   # greenfield, unattended: JSON file with settings.cfg values
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$PortalRoot = $PSScriptRoot

function Step($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "    $text" }
function Warn($text) { Write-Host "    ! $text" -ForegroundColor Yellow }
function Ask($prompt, $default) {
    $suffix = ''; if ($default) { $suffix = " [$default]" }
    $answer = Read-Host "    $prompt$suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim()
}

# ---------------------------------------------------------------------------------- checks
Step 'Checking prerequisites'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (Run as administrator).'
}
if ($PSVersionTable.PSVersion.Major -ne 5) {
    Warn "This is PowerShell $($PSVersionTable.PSVersion). vlab's scripts are written for Windows PowerShell 5.1; run the installer from 'Windows PowerShell', not pwsh."
}
if ($PortalRoot -match '\s') { throw "Install the portal in a path without spaces (now: $PortalRoot). C:\vlab-portal is recommended." }
Info "Portal folder : $PortalRoot"
Info "Runs as      : $($identity.Name)"

$mode = if (Test-Path (Join-Path $VlabRoot 'settings.cfg')) { 'brownfield' } else { 'greenfield' }
Info "vlab folder  : $VlabRoot  ($mode)"

# ------------------------------------------------------------------- greenfield: get vlab
if ($mode -eq 'greenfield') {
    Step "Greenfield: downloading $VlabRepo @ $($VlabCommit.Substring(0,7)) into $VlabRoot"
    if ((Test-Path $VlabRoot) -and (Get-ChildItem $VlabRoot -Force | Select-Object -First 1)) {
        throw "$VlabRoot exists but has no settings.cfg. Move it away or pass -VlabRoot <empty folder>."
    }
    $zip = Join-Path $env:TEMP "vlab-$VlabCommit.zip"
    Invoke-WebRequest "https://github.com/$VlabRepo/archive/$VlabCommit.zip" -OutFile $zip -UseBasicParsing
    $tmp = Join-Path $env:TEMP "vlab-extract-$([guid]::NewGuid().ToString('N'))"
    Expand-Archive $zip $tmp
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force $VlabRoot | Out-Null
    Get-ChildItem $inner.FullName -Force | Move-Item -Destination $VlabRoot
    Remove-Item $zip, $tmp -Recurse -Force
    Get-ChildItem $VlabRoot -Recurse -File | Unblock-File
    Info "vlab scripts installed in $VlabRoot"

    Step 'Greenfield: vlab settings (written to settings.cfg)'
    # Same keys as vlab's settings.cfg.sample. Values can come from -SettingsFile for unattended installs.
    $fields = [ordered]@{
        sitename     = @('Portal name shown in the browser', 'vLab Portal')
        vCenter      = @('vCenter server (FQDN or IP)', '')
        VICluster    = @('vSphere cluster that runs the labs', '')
        vswitch      = @('Standard vSwitch for lab port groups (on every host in the cluster)', 'vSwitch0')
        VIPortgroup  = @('Port group the lab gateways use as their WAN', 'VM Network')
        vlanbase     = @('First VLAN ID the lab networks may use', '1000')
        cluster_mgmt = @('ONTAP cluster management address', '')
        vserver      = @('ONTAP SVM (vserver) that holds the lab volumes', '')
        VIDatastore  = @('NFS datastore (from that SVM) whose junction holds the lab volumes', '')
        newID        = @('Lab copies are numbered after this', '1000')
        autostart    = @('Start labs automatically after provisioning (true/false)', 'false')
        rdpdomain    = @('Default RDP domain for lab jumphosts', 'lab')
        rdpuser      = @('Default RDP user for lab jumphosts', 'administrator')
        rdppassword  = @('Default RDP password for lab jumphosts', '')
    }
    $preset = @{}
    if ($SettingsFile) { (Get-Content $SettingsFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $preset[$_.Name] = [string]$_.Value } }
    $lines = foreach ($k in $fields.Keys) {
        $v = $preset[$k]
        if ($null -eq $v) {
            if ($k -eq 'rdppassword') {
                $sec = Read-Host "    $($fields[$k][0])" -AsSecureString
                $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
            } else {
                do { $v = Ask $fields[$k][0] $fields[$k][1] } while ([string]::IsNullOrWhiteSpace($v))
            }
        }
        "$k=$v"
    }
    Set-Content -Path (Join-Path $VlabRoot 'settings.cfg') -Value $lines -Encoding ASCII
    Info 'settings.cfg written. (rdppassword is stored in plain text, exactly like vlab 1.x.)'
    $cmdb = Join-Path $VlabRoot 'cmdb'
    if (-not (Test-Path "$cmdb\descriptions.tbl")) { Copy-Item "$cmdb\descriptions.tbl.sample" "$cmdb\descriptions.tbl" }
}

# -------------------------------------------------------------------- PowerShell modules
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
    Import-Module VMware.VimAutomation.Core
    Set-PowerCLIConfiguration -Scope AllUsers -ParticipateInCEIP $false -InvalidCertificateAction Ignore `
        -DisplayDeprecationWarnings $false -DefaultVIServerMode Multiple -Confirm:$false | Out-Null
} else { Info 'Already installed.' }

# ---------------------------------------------------------------------------- credentials
$conf = Get-Content (Join-Path $VlabRoot 'settings.cfg') | Out-String | ConvertFrom-StringData
if (-not $SkipCredentials) {
    Step 'vCenter / ONTAP credentials (saved encrypted for this Windows account only)'
    $vi = Join-Path $VlabRoot 'vicred.clixml'
    $nc = Join-Path $VlabRoot 'nccred.clixml'
    foreach ($pair in @(@($vi, "vCenter $($conf.vCenter)"), @($nc, "ONTAP cluster $($conf.cluster_mgmt)"))) {
        $file = $pair[0]; $what = $pair[1]
        $usable = $false
        if (Test-Path $file) {
            try { $null = Import-Clixml $file; $usable = $true; Info "Using existing $(Split-Path $file -Leaf)" }
            catch { Warn "$(Split-Path $file -Leaf) was saved by a different Windows account; it must be re-entered." }
        }
        if (-not $usable) {
            $c = Get-Credential -Message "Credentials for $what"
            if (-not $c) { throw "No credentials entered for $what." }
            if (Test-Path $file) { Copy-Item $file "$file.bak" -Force }
            $c | Export-Clixml $file
            Info "Saved $(Split-Path $file -Leaf)"
        }
    }
}

# ------------------------------------------------------------------------- PS remoting
Step 'PowerShell remoting on localhost (vlab scripts keep a local session to vCenter/ONTAP)'
try { $null = Test-WSMan -ComputerName localhost -ErrorAction Stop; Info 'Already enabled.' }
catch { Enable-PSRemoting -Force -SkipNetworkProfileCheck | Out-Null; Info 'Enabled.' }

# ---------------------------------------------------------------------- Node.js runtime
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

# ------------------------------------------------------------------------ npm packages
Step 'Portal dependencies (npm ci)'
Push-Location $PortalRoot
try {
    $env:Path = (Join-Path $PortalRoot 'runtime\node') + ';' + $env:Path
    cmd /c "npm ci --omit=dev --no-audit --no-fund --loglevel=error 2>&1"
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed (see output above). The server needs HTTPS access to registry.npmjs.org.' }
} finally { Pop-Location }

# ------------------------------------------------------------------------- config.json
Step 'Portal configuration (config.json)'
$cfgPath = Join-Path $PortalRoot 'config.json'
if (Test-Path $cfgPath) {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    Info 'Keeping existing config.json'
    if ($GuacamoleUrl) { $cfg.guacamole.url = $GuacamoleUrl }
    if ($GuacamoleKey) { $cfg.guacamole.jsonSecretKey = $GuacamoleKey }
} else {
    if (-not $GuacamoleUrl) {
        Info 'Browser remote desktop (Apache Guacamole) is optional. See README "Remote desktop".'
        $GuacamoleUrl = Ask 'Guacamole URL, e.g. http://10.0.0.5:8085/guacamole (Enter to skip for now)' ''
    }
    if ($GuacamoleUrl -and -not $GuacamoleKey) { $GuacamoleKey = Ask 'Guacamole JSON secret key (32 hex characters)' '' }
    $cfg = [pscustomobject][ordered]@{
        port = $Port; vlabRoot = $VlabRoot; inventoryIntervalSec = 60; maxConcurrentJobs = 2; secureCookies = $false
        guacamole = [pscustomobject][ordered]@{ url = $GuacamoleUrl; jsonSecretKey = $GuacamoleKey }
    }
}
if ($cfg.guacamole.jsonSecretKey -and $cfg.guacamole.jsonSecretKey -notmatch '^[0-9a-fA-F]{32}$') {
    throw 'The Guacamole key must be exactly 32 hex characters (JSON_SECRET_KEY on the Guacamole host).'
}
$cfg | ConvertTo-Json | Set-Content $cfgPath -Encoding ASCII
# config.json holds the Guacamole key: only this account, SYSTEM and Administrators may read it
& icacls $cfgPath /inheritance:r /grant "$($identity.Name):F" /grant '*S-1-5-18:F' /grant '*S-1-5-32-544:F' | Out-Null
$Port = [int]$cfg.port
Info "Port $Port, vlab at $($cfg.vlabRoot), remote desktop: $(if ($cfg.guacamole.url) { $cfg.guacamole.url } else { 'not configured' })"

# ---------------------------------------------------------------------------- firewall
Step "Windows Firewall: allow TCP $Port"
$ruleName = "vLabPortal-$Port"
if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName "vLab Portal (TCP $Port)" -Protocol TCP -LocalPort $Port -Direction Inbound -Action Allow | Out-Null
}
Info 'Done.'

# --------------------------------------------------------------------- scheduled task
New-Item -ItemType Directory -Force (Join-Path $PortalRoot 'logs') | Out-Null
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
    if ($ok) { Info "Portal is running." } else { Warn "Portal did not answer yet. Check $PortalRoot\logs\portal.log" }
}

# ------------------------------------------------------------------------------- done
$hostName = ([System.Net.Dns]::GetHostEntry($env:COMPUTERNAME)).HostName
Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host " vLab Portal installed ($mode)" -ForegroundColor Green
Write-Host "   URL : http://$hostName`:$Port"
$pw = Join-Path $PortalRoot 'data\initial-admin-password.txt'
if ((Test-Path $pw) -or -not (Test-Path (Join-Path $PortalRoot 'data\portal.db'))) {
    Write-Host "   First sign-in: user 'admin', one-time password in $pw (created when the portal first starts)"
}
if ($mode -eq 'brownfield') { Write-Host '   The legacy vlab portal (port 8081) still runs; see README "Retiring the legacy portal".' }
if (-not $cfg.guacamole.url) { Write-Host '   Connect button is off until Guacamole is set up; see README "Remote desktop".' }
Write-Host '============================================================' -ForegroundColor Green
