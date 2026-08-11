# Redeploy the extension to Qlik Sense Desktop after changes.
# Then hard-refresh the Qlik client (Ctrl+F5).
# NOTE: this machine's Qlik Desktop uses a custom content folder (chosen at install).
$ErrorActionPreference = 'Stop'

# Refuse to deploy something Qlik cannot register (BOM, bad JSON, JS syntax error).
& (Join-Path $PSScriptRoot "deploy\Test-Extension.ps1")

$src = Join-Path $PSScriptRoot "extension\qlik-collaboration"
$dst = "C:\Qlik\doc\Sense\Extensions"
Copy-Item -Recurse -Force $src $dst
Write-Host "Deployed to $dst\qlik-collaboration" -ForegroundColor Green
