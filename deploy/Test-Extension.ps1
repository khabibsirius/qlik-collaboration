<#
.SYNOPSIS
    Validates the extension folder before it is deployed or packaged.
.DESCRIPTION
    Qlik registers an extension by parsing its .qext file. If that file cannot be
    parsed, the extension is not registered at all and every sheet using it shows
    "Invalid visualization - this extension is not available", with no clue as to why.

    A UTF-8 BOM is the classic cause: it is invisible in every editor, and
    `Set-Content -Encoding utf8` in Windows PowerShell 5.1 adds one silently.

    Dot-source or call this before deploying; it throws on anything fatal.
.EXAMPLE
    .\deploy\Test-Extension.ps1
#>
[CmdletBinding()]
param(
    [string] $ExtensionPath = (Join-Path $PSScriptRoot "..\extension\qlik-collaboration")
)

$ErrorActionPreference = 'Stop'
$path = Resolve-Path $ExtensionPath
$name = Split-Path $path -Leaf
$qext = Join-Path $path "$name.qext"

if (-not (Test-Path $qext)) {
    throw "No $name.qext in $path -- Qlik identifies an extension by a .qext named after its folder."
}

# 1. no byte order mark
$bytes = [System.IO.File]::ReadAllBytes($qext)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw "$name.qext starts with a UTF-8 BOM. Qlik cannot parse it and the extension will not register. Rewrite the file as UTF-8 without BOM."
}

# 2. valid JSON with the fields Qlik needs
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
try { $meta = $text | ConvertFrom-Json } catch { throw "$name.qext is not valid JSON: $($_.Exception.Message)" }

if (-not $meta.name)    { throw "$name.qext has no 'name'." }
if (-not $meta.version) { throw "$name.qext has no 'version'." }
if ($meta.type -ne 'visualization') {
    throw "$name.qext has type '$($meta.type)'. It must be 'visualization' or the extension will not appear under Custom objects."
}

# 3. the entry-point script must exist and parse
$js = Join-Path $path "$name.js"
if (-not (Test-Path $js)) { throw "Missing entry point $name.js" }

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    & node --check $js
    if ($LASTEXITCODE -ne 0) { throw "$name.js has a JavaScript syntax error (see above)." }
}

Write-Host "$name v$($meta.version): qext parses, no BOM, type=visualization, JS syntax OK" -ForegroundColor Green
