<#
.SYNOPSIS
    Zips the Qlik extension for import into Qlik Sense Enterprise (QMC).
.DESCRIPTION
    Produces dist\qlik-collaboration.zip. In the QMC:
        Extensions -> Import -> pick the zip.
    Qlik distributes it to every node automatically -- never copy files to nodes by hand.
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

# Never ship a package Qlik cannot register.
& (Join-Path $PSScriptRoot "Test-Extension.ps1") -ExtensionPath $source

$version = (Get-Content $qext -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force $OutputDir | Out-Null
$zip = Join-Path (Resolve-Path $OutputDir) "qlik-collaboration.zip"

if (Test-Path $zip) { Remove-Item $zip -Force -Confirm:$false }

# The four files must sit at the ROOT of the archive. Compress-Archive on the folder
# puts them one level down inside "qlik-collaboration/", and Qlik then fails to find
# the .qext and registers nothing. Listing the files explicitly also keeps the
# previously built zip -- which lives in this same folder -- from being packed into
# the new one.
$payload = @(
    "qlik-collaboration.js",
    "qlik-collaboration.css",
    "qlik-collaboration.qext",
    "signalr.min.js"
) | ForEach-Object {
    $p = Join-Path $source $_
    if (-not (Test-Path $p)) { throw "Missing extension file: $_" }
    $p
}
Compress-Archive -Path $payload -DestinationPath $zip -CompressionLevel Optimal

# Prove the layout rather than trust it: a nested zip imports without error and then
# simply does not appear in the app.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
    $nested = $archive.Entries | Where-Object { $_.FullName -match '/' }
    $names  = $archive.Entries.FullName
} finally { $archive.Dispose() }
if ($nested) { throw "Files are nested inside a folder: $($nested.FullName -join ', ')" }
if ($names -notcontains "qlik-collaboration.qext") { throw "qlik-collaboration.qext is not at the archive root." }

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "Packaged qlik-collaboration v$version -> $zip ($size KB)" -ForegroundColor Green
Write-Host "Import it in the QMC: Extensions -> Import" -ForegroundColor Gray
