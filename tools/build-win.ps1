# Build the Windows NSIS installer from an app we stage ourselves.
# electron-builder's extract-then-rename step can hit EPERM on machines with
# real-time antivirus; staging the Electron runtime first avoids that.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$unpacked = Join-Path $dist 'win-unpacked'
$electron = Join-Path $root 'node_modules\electron\dist'

if (-not (Test-Path (Join-Path $electron 'electron.exe'))) {
    throw 'Electron is not installed. Run npm install first.'
}

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $unpacked) {
    Remove-Item -LiteralPath $unpacked -Recurse -Force
}
New-Item -ItemType Directory -Force $unpacked | Out-Null

$rc = robocopy $electron $unpacked /E /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with code $LASTEXITCODE"
}

$defaultApp = Join-Path $unpacked 'resources\default_app.asar'
if (Test-Path $defaultApp) { Remove-Item -LiteralPath $defaultApp -Force }

$exe = Join-Path $unpacked 'electron.exe'
$namedExe = Join-Path $unpacked 'Busy Magpie.exe'
if (Test-Path $namedExe) { Remove-Item -LiteralPath $namedExe -Force }
Rename-Item -LiteralPath $exe -NewName 'Busy Magpie.exe'

$app = Join-Path $unpacked 'resources\app'
if (Test-Path $app) { Remove-Item -LiteralPath $app -Recurse -Force }
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item (Join-Path $root 'src') $app -Recurse -Force
Copy-Item (Join-Path $root 'web') $app -Recurse -Force
Copy-Item (Join-Path $root 'assets') $app -Recurse -Force
Copy-Item (Join-Path $root 'package.json') $app -Force
Copy-Item (Join-Path $root 'LICENSE') $app -Force

$rcedit = Join-Path $root 'node_modules\electron-winstaller\vendor\rcedit.exe'
# The exe's version comes from package.json, so a release only bumps one place.
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if (Test-Path $rcedit) {
    # rcedit edits the PE in place. Real-time antivirus can briefly hold the
    # freshly copied electron.exe; retry rather than failing the build.
    $stamped = $false
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        & $rcedit $namedExe `
            --set-icon (Join-Path $root 'assets\busy-magpie.ico') `
            --set-file-version $version `
            --set-product-version $version `
            --set-version-string 'ProductName' 'Busy Magpie' `
            --set-version-string 'FileDescription' 'Busy Magpie' `
            --set-version-string 'CompanyName' 'Busy Magpie'
        if ($LASTEXITCODE -eq 0) {
            $stamped = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $stamped) {
        Write-Warning 'rcedit could not stamp the executable; using the Electron icon.'
    }
}

$builder = Join-Path $root 'node_modules\.bin\electron-builder.cmd'
if (-not (Test-Path $builder)) {
    throw 'electron-builder is not installed. Run npm install first.'
}

& $builder --win nsis --x64 --prepackaged $unpacked --publish never
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with code $LASTEXITCODE" }

Get-ChildItem $dist -Filter '*.exe' | ForEach-Object { Write-Host "built $($_.FullName)" }
