<#
.SYNOPSIS
    Publishes the backend and installs it as a Windows Service. No Docker required.
.DESCRIPTION
    The path most bank IT departments approve on a Windows Server: a plain .NET
    service plus an existing PostgreSQL instance. Run from an elevated PowerShell.

    Credentials are written to the service's own environment block in the registry,
    not into appsettings.json, so they are not readable by everyone with file access.
.EXAMPLE
    # first install
    .\deploy\install-windows-service.ps1 -DbHost pg.bank.local -DbPassword 'S3cret!' `
        -QlikOrigin https://qlik.bank.local

.EXAMPLE
    # remove it again
    .\deploy\install-windows-service.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string] $ServiceName     = "QlikCollaboration",
    [string] $InstallPath     = "C:\Programs\QlikCollaboration",
    [string] $AttachmentsPath = "C:\Programs\QlikCollaboration\uploads",

    [string] $DbHost     = "localhost",
    [int]    $DbPort     = 5432,
    [string] $DbName     = "qlik_collaboration",
    [string] $DbUser     = "postgres",
    [string] $DbPassword,

    # http://+:5000 listens on every interface. Use https://+:5443 with a bound
    # certificate when Qlik Sense is served over HTTPS (browsers block mixed content).
    [string] $ListenUrl  = "http://+:5000",
    # Exact origin of the Qlik Sense server for the CORS allowlist, or * to allow any.
    [string] $QlikOrigin = "*",
    [switch] $EnableSwagger,
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
              [Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script from an elevated PowerShell (Run as Administrator)."
    }
}

function Remove-ServiceIfPresent($name) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $svc) { return }
    if ($svc.Status -ne 'Stopped') {
        Write-Host "Stopping $name..." -ForegroundColor Gray
        Stop-Service -Name $name -Force
        $svc.WaitForStatus('Stopped', '00:00:30')
    }
    & sc.exe delete $name | Out-Null
    Start-Sleep -Seconds 2      # SCM needs a moment before the name is free again
}

Assert-Admin

if ($Uninstall) {
    Remove-ServiceIfPresent $ServiceName
    Remove-NetFirewallRule -DisplayName "$ServiceName API" -ErrorAction SilentlyContinue
    Write-Host "Removed service '$ServiceName'. Files in $InstallPath were kept." -ForegroundColor Green
    return
}

if (-not $DbPassword) { throw "-DbPassword is required." }

$project = Resolve-Path (Join-Path $PSScriptRoot "..\backend\QlikCollaboration.Api")

# --- publish -----------------------------------------------------------------
Write-Host "Publishing $project ..." -ForegroundColor Cyan
$publishDir = Join-Path $env:TEMP "qlikcollab-publish-$(Get-Random)"
& dotnet publish $project -c Release -o $publishDir --nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed." }

# --- stop the old service before overwriting files ---------------------------
Remove-ServiceIfPresent $ServiceName

New-Item -ItemType Directory -Force $InstallPath     | Out-Null
New-Item -ItemType Directory -Force $AttachmentsPath | Out-Null
Copy-Item "$publishDir\*" $InstallPath -Recurse -Force
Remove-Item $publishDir -Recurse -Force -Confirm:$false

$exe = Join-Path $InstallPath "QlikCollaboration.Api.exe"
if (-not (Test-Path $exe)) { throw "Publish output is missing $exe" }

# --- create the service ------------------------------------------------------
Write-Host "Creating service '$ServiceName'..." -ForegroundColor Cyan
& sc.exe create $ServiceName binPath= "`"$exe`"" start= auto DisplayName= "Qlik Collaboration API" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed with exit code $LASTEXITCODE" }
& sc.exe description $ServiceName "REST API and SignalR hub for the Qlik Collaboration extension." | Out-Null
# restart automatically on crash: after 5s, 10s, then every 60s
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/60000 | Out-Null

# --- configuration via the service's environment block -----------------------
# ASP.NET Core reads these; "__" is the separator for nested config keys.
$connection = "Host=$DbHost;Port=$DbPort;Database=$DbName;Username=$DbUser;Password=$DbPassword"
$environment = @(
    "ASPNETCORE_ENVIRONMENT=Production"
    "ASPNETCORE_URLS=$ListenUrl"
    "ConnectionStrings__Postgres=$connection"
    "Storage__AttachmentsPath=$AttachmentsPath"
    "Cors__AllowedOrigins__0=$QlikOrigin"
    "Swagger__Enabled=$($EnableSwagger.IsPresent.ToString().ToLower())"
)
$regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
New-ItemProperty -Path $regPath -Name Environment -PropertyType MultiString `
                 -Value $environment -Force | Out-Null

# --- firewall ----------------------------------------------------------------
# The extension runs in each USER's browser, so the port must be reachable from
# the user subnet — not only from the Qlik servers.
$port = ([uri]($ListenUrl -replace '\+', 'localhost')).Port
Remove-NetFirewallRule -DisplayName "$ServiceName API" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "$ServiceName API" -Direction Inbound -Action Allow `
                    -Protocol TCP -LocalPort $port -Profile Any | Out-Null
Write-Host "Opened inbound TCP $port" -ForegroundColor Gray

# --- start and verify --------------------------------------------------------
Start-Service -Name $ServiceName
$probe = "http://localhost:$port/health"
$ok = $false
foreach ($attempt in 1..10) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-RestMethod $probe -TimeoutSec 5
        if ($r.status -eq 'healthy') { $ok = $true; break }
    } catch { }
}

if ($ok) {
    Write-Host "`n$ServiceName is running and reached the database." -ForegroundColor Green
    Write-Host "  health : $probe"
    Write-Host "  API URL for the extension setting: http://<this-server>:$port"
} else {
    Write-Warning "Service installed but /health did not report healthy."
    Write-Warning "Check: Get-EventLog -LogName Application -Source $ServiceName -Newest 20"
    Write-Warning "Most common cause: the database is unreachable or the password is wrong."
}
