# Redeploy the extension to Qlik Sense Desktop after changes.
# NOTE: this machine's Qlik Desktop uses a custom content folder (chosen at install).
$ErrorActionPreference = 'Stop'

# Refuse to deploy something Qlik cannot register (BOM, bad JSON, JS syntax error).
& (Join-Path $PSScriptRoot "deploy\Test-Extension.ps1")

$src = Join-Path $PSScriptRoot "extension\qlik-collaboration"
$dst = "C:\Qlik\doc\Sense\Extensions"
$version = (Get-Content (Join-Path $src "qlik-collaboration.qext") -Raw | ConvertFrom-Json).version

Copy-Item -Recurse -Force $src $dst
Write-Host "Deployed v$version to $dst\qlik-collaboration" -ForegroundColor Green

# Ask the engine what it actually serves. Copying the file is not the same as Qlik
# handing it to the browser, and every stale-build hunt so far has been lost in that
# gap -- the panel shows an old version while the file on disk is correct.
$url = "http://localhost:4848/extensions/qlik-collaboration/qlik-collaboration.js"
try {
    $served = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).Content
    $servedVersion = ([regex]::Match($served, 'EXT_VERSION = "([^"]+)"')).Groups[1].Value
    if ($servedVersion -eq $version) {
        Write-Host "Engine serves v$servedVersion - matches." -ForegroundColor Green
    } else {
        Write-Host "Engine still serves v$servedVersion, expected v$version." -ForegroundColor Red
        Write-Host "Restart Qlik Sense Desktop so it re-reads the extensions folder." -ForegroundColor Red
    }
} catch {
    Write-Host "Qlik Sense Desktop is not running - skipped the served-version check." -ForegroundColor DarkGray
}

# Qlik sends no Cache-Control and no ETag for extension files, only Last-Modified.
# Browsers therefore cache them heuristically and can skip revalidating entirely, so
# a plain F5 may keep showing the previous build.
Write-Host ""
Write-Host "In Qlik: hard-reload with Ctrl+Shift+R, then check the panel header reads v$version." -ForegroundColor Cyan
Write-Host "If it still shows an older version, fully quit Qlik Sense Desktop and reopen it." -ForegroundColor Cyan
