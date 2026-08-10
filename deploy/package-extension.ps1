<#
.SYNOPSIS
    Zips the Qlik extension for import into Qlik Sense Enterprise (QMC).
.DESCRIPTION
    Produces dist\qlik-collaboration.zip. In the QMC:
        Extensions -> Import -> pick the zip.
    Qlik distributes it to every node automatically — never copy files to nodes by hand.
.EXAMPLE
    .\deploy\package-extension.ps1
#>
[CmdletBinding()]
param(
    [string] $OutputDir = (Join-Path $PSScriptRoot "..\dist")
)

$ErrorActionPreference = 'Stop'

$source = Resolve-Path (Join-Path $PSScriptRoot "..\extension\qlik-collaboration")
$qext   = Join-Path $source "qlik-collaboration.qext"

if (-not (Test-Path $qext)) { throw "Not an extension folder (no .qext): $source" }

$version = (Get-Content $qext -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force $OutputDir | Out-Null
$zip = Join-Path (Resolve-Path $OutputDir) "qlik-collaboration.zip"

if (Test-Path $zip) { Remove-Item $zip -Force -Confirm:$false }
Compress-Archive -Path $source -DestinationPath $zip -CompressionLevel Optimal

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "Packaged qlik-collaboration v$version -> $zip ($size KB)" -ForegroundColor Green
Write-Host "Import it in the QMC: Extensions -> Import" -ForegroundColor Gray
