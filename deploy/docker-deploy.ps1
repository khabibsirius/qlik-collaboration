<#
.SYNOPSIS
    Builds and starts the Qlik Collaboration API in Docker on a Windows server.
.DESCRIPTION
    Detects whether the Docker engine is in Windows-container or Linux-container
    mode and uses the matching compose file and Dockerfile. Assumes PostgreSQL is
    already installed on the host (the container connects out to it).

    Run the preflight first to catch the usual blockers before building:
        .\deploy\docker-deploy.ps1 -Preflight
.EXAMPLE
    .\deploy\docker-deploy.ps1 -Preflight
.EXAMPLE
    .\deploy\docker-deploy.ps1
.EXAMPLE
    .\deploy\docker-deploy.ps1 -Down          # stop (attachments volume is kept)
#>
[CmdletBinding()]
param(
    [switch] $Preflight,
    [switch] $Down,
    [switch] $Logs,
    # Build the app inside Docker instead of publishing locally first.
    # Needs no .NET SDK on this machine, but pulls a large SDK base image.
    [switch] $MultiStage
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$envFile = Join-Path $root ".env"

function Get-DockerOsType {
    $t = & docker info --format "{{.OSType}}" 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Cannot talk to the Docker engine. Is Docker running?" }
    return $t.Trim()
}

function Get-EnvValue($name, $default) {
    if (-not (Test-Path $envFile)) { return $default }
    foreach ($line in Get-Content $envFile) {
        if ($line -match "^\s*$([regex]::Escape($name))\s*=\s*(.*)$") { return $Matches[1].Trim() }
    }
    return $default
}

$osType      = Get-DockerOsType
$composeFile = if ($osType -eq 'windows') { "docker-compose.windows.yml" } else { "docker-compose.hostdb.yml" }
$composePath = Join-Path $root $composeFile

Write-Host "Docker engine mode : $osType containers" -ForegroundColor Cyan
Write-Host "Compose file       : $composeFile" -ForegroundColor Cyan

# ---------------------------------------------------------------- preflight ---
if ($Preflight) {
    $problems = @()   # must be fixed before deploying
    $notes    = @()   # conditional - may or may not apply to this engine

    if (-not (Test-Path $envFile)) {
        $problems += ".env is missing. Copy .env.example to .env and set DB_PASSWORD."
    } elseif (-not (Get-EnvValue 'DB_PASSWORD' $null)) {
        $problems += "DB_PASSWORD is not set in .env -- the stack will refuse to start."
    }

    if ($osType -eq 'windows') {
        $os  = (Get-ComputerInfo -Property OsName -ErrorAction SilentlyContinue).OsName
        $tag = Get-EnvValue 'WINDOWS_TAG' 'ltsc2022'
        Write-Host "Host OS            : $os"
        Write-Host "WINDOWS_TAG        : $tag"
        $expected = switch -Regex ($os) {
            '2019' { 'ltsc2019' }; '2022' { 'ltsc2022' }; '2025' { 'ltsc2025' }; default { $null }
        }
        if ($expected -and $tag -ne $expected) {
            $problems += "WINDOWS_TAG is '$tag' but the host looks like $os -- set WINDOWS_TAG=$expected in .env, or the container will not start."
        }
    }

    # database reachability from the host (the container needs a bit more, see below)
    $dbHost = Get-EnvValue 'DB_HOST' 'host.docker.internal'
    $dbPort = [int](Get-EnvValue 'DB_PORT' '5432')
    $probeHost = if ($dbHost -eq 'host.docker.internal') { 'localhost' } else { $dbHost }
    $tcp = Test-NetConnection -ComputerName $probeHost -Port $dbPort -WarningAction SilentlyContinue
    if ($tcp.TcpTestSucceeded) {
        Write-Host "PostgreSQL         : reachable at ${probeHost}:$dbPort" -ForegroundColor Green
    } else {
        $problems += "PostgreSQL is not reachable at ${probeHost}:$dbPort from the host."
    }

    # listen_addresses: a container cannot reach a server bound to localhost only
    $conf = Get-ChildItem "C:\Program Files\PostgreSQL\*\data\postgresql.conf" -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($conf) {
        # Only uncommented lines count; when the setting is absent PostgreSQL
        # defaults to localhost only, which a container cannot reach.
        $listen = Select-String -Path $conf.FullName -Pattern "^\s*listen_addresses\s*=" |
                  Select-Object -Last 1
        if (-not $listen) {
            $problems += "postgresql.conf does not set listen_addresses, so it defaults to localhost only and containers cannot connect. Add listen_addresses = '*' and restart PostgreSQL. ($($conf.FullName))"
        } elseif ($listen.Line -notmatch "\*" -and $listen.Line -notmatch "0\.0\.0\.0") {
            $problems += "postgresql.conf has $($listen.Line.Trim()) -- containers cannot connect. Set listen_addresses = '*' and restart PostgreSQL."
        } else {
            Write-Host "listen_addresses   : $($listen.Line.Trim())" -ForegroundColor Green
        }

        # pg_hba.conf must allow the container subnet, otherwise the connection is
        # refused even when the port is open.
        $hba = Join-Path $conf.DirectoryName "pg_hba.conf"
        if (Test-Path $hba) {
            $open = Select-String -Path $hba -Pattern "^\s*host(ssl)?\s+.*\s(0\.0\.0\.0/0|172\.|10\.|192\.168\.)" |
                    Select-Object -First 1
            if ($open) {
                Write-Host "pg_hba.conf        : has a host rule covering a container subnet" -ForegroundColor Green
            } else {
                # Not always fatal: Docker Desktop proxies host.docker.internal via the
                # host loopback, so PostgreSQL sees 127.0.0.1 and the existing local
                # rule is enough. Other engines -- notably Windows containers on the
                # NAT network -- connect from the container subnet and get rejected.
                $notes += "pg_hba.conf only allows loopback. That is fine under Docker Desktop (it proxies through 127.0.0.1) but Windows containers connect from the NAT subnet and will be refused. If the container cannot connect, add e.g. 'host all all 172.16.0.0/12 scram-sha-256' and reload PostgreSQL."
            }
        }
    }

    if ($notes.Count -gt 0) {
        Write-Host "`nWorth knowing:" -ForegroundColor Cyan
        $notes | ForEach-Object { Write-Host "  - $_" -ForegroundColor Gray }
    }
    if ($problems.Count -eq 0) {
        Write-Host "`nPreflight passed -- run .\deploy\docker-deploy.ps1 to build and start." -ForegroundColor Green
    } else {
        Write-Host "`nPreflight found $($problems.Count) problem(s) to fix first:" -ForegroundColor Yellow
        $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    }
    return
}

# ------------------------------------------------------------------ actions ---
if ($Logs) { & docker compose -f $composePath logs -f api; return }

if ($Down) {
    & docker compose -f $composePath down
    Write-Host "Stopped. The 'uploads' volume was kept (use 'docker volume rm' to delete it)." -ForegroundColor Green
    return
}

if (-not (Test-Path $envFile)) {
    throw ".env is missing. Copy .env.example to .env and set DB_PASSWORD first."
}

# --------------------------------------------------------------- build mode ---
# Preferred: publish with the locally installed .NET SDK, then build a runtime-only
# image. Building inside Docker instead would pull an SDK base image -- ~800 MB on
# Linux, ~6-8 GB of Windows Server Core -- which is often impractical on a
# corporate network. -MultiStage forces the in-Docker build when there is no SDK.
$project    = Join-Path $root "backend\QlikCollaboration.Api"
$publishDir = Join-Path $project "publish"
$hasSdk     = $false
if (-not $MultiStage) {
    try { $hasSdk = [bool](& dotnet --version 2>$null) -and $LASTEXITCODE -eq 0 } catch { $hasSdk = $false }
    if (-not $hasSdk) {
        Write-Warning "No .NET SDK found -- falling back to building inside Docker."
        Write-Warning "That pulls a large SDK base image; install the .NET 8 SDK to avoid it."
    }
}

if ($hasSdk) {
    Write-Host "`nPublishing with the local .NET SDK..." -ForegroundColor Cyan
    if (Test-Path $publishDir) { Remove-Item $publishDir -Recurse -Force -Confirm:$false }
    & dotnet publish $project -c Release -o $publishDir --nologo
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed." }

    $env:DOCKERFILE = "Dockerfile.prebuilt"
    $tag = Get-EnvValue 'WINDOWS_TAG' 'ltsc2022'
    $env:RUNTIME_IMAGE = if ($osType -eq 'windows') {
        "mcr.microsoft.com/dotnet/aspnet:8.0-nanoserver-$tag"
    } else {
        "mcr.microsoft.com/dotnet/aspnet:8.0"
    }
    Write-Host "Runtime image      : $env:RUNTIME_IMAGE" -ForegroundColor Cyan
} else {
    # multi-stage: build the app inside Docker
    $env:DOCKERFILE = if ($osType -eq 'windows') { "Dockerfile.windows" } else { "Dockerfile" }
}
Write-Host "Dockerfile         : $env:DOCKERFILE" -ForegroundColor Cyan

Write-Host "`nBuilding and starting..." -ForegroundColor Cyan
& docker compose -f $composePath up -d --build
if ($LASTEXITCODE -ne 0) { throw "docker compose failed with exit code $LASTEXITCODE" }

# ------------------------------------------------------------------- verify ---
$port = [int](Get-EnvValue 'API_PORT' '5000')
$probe = "http://localhost:$port/health"
$ok = $false
foreach ($attempt in 1..15) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-RestMethod $probe -TimeoutSec 5
        if ($r.status -eq 'healthy') { $ok = $true; break }
    } catch { }
}

if ($ok) {
    Write-Host "`nRunning and connected to the database." -ForegroundColor Green
    Write-Host "  health : $probe"
    Write-Host "  Set the extension's Backend API URL to: http://<this-server>:$port"
    Write-Host "  Remember to open inbound TCP $port in the firewall for user workstations."
} else {
    Write-Warning "Container started but /health never reported healthy."
    Write-Warning "Look at the log:  .\deploy\docker-deploy.ps1 -Logs"
    Write-Warning "Most common cause: the container cannot reach the host PostgreSQL"
    Write-Warning "(listen_addresses, pg_hba.conf, or DB_HOST) -- see docs/Deployment.md."
}
