# Build the Windows NSIS installer from an app we stage ourselves.
# electron-builder's extract-then-rename step can hit EPERM on machines with
# real-time antivirus; staging the Electron runtime first avoids that.

param([string]$OutputDirectory = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$allowedOutput = [IO.Path]::GetFullPath((Join-Path $root 'dist'))
$dist = if ($OutputDirectory) {
    [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $root $OutputDirectory }))
} else { $allowedOutput }
if ($dist -ne $allowedOutput -and -not $dist.StartsWith($allowedOutput + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Build output must stay inside this workspace dist directory.'
}

function Assert-BuildPath([string]$Target) {
    $resolved = [IO.Path]::GetFullPath($Target)
    if (-not $resolved.StartsWith($dist + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Build target is outside its output directory: $resolved"
    }
    $probe = $resolved
    while ($probe.Length -ge $allowedOutput.Length) {
        if (Test-Path -LiteralPath $probe) {
            $item = Get-Item -LiteralPath $probe -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Build target traverses a link: $probe" }
        }
        if ($probe -eq $allowedOutput) { break }
        $probe = Split-Path -Parent $probe
    }
}

$unpacked = Join-Path $dist 'win-unpacked'
$electron = Join-Path $root 'node_modules\electron\dist'

if (-not (Test-Path (Join-Path $electron 'electron.exe'))) {
    throw 'Electron is not installed. Run npm install first.'
}

Assert-BuildPath $unpacked
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
Assert-BuildPath $app
if (Test-Path $app) { Remove-Item -LiteralPath $app -Recurse -Force }
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item (Join-Path $root 'src') $app -Recurse -Force
Copy-Item (Join-Path $root 'web') $app -Recurse -Force
Copy-Item (Join-Path $root 'plugin') $app -Recurse -Force
Copy-Item (Join-Path $root 'assets') $app -Recurse -Force
Copy-Item (Join-Path $root 'package.json') $app -Force
Copy-Item (Join-Path $root 'LICENSE') $app -Force

# Runtime dependencies (electron-updater and what it imports) are not dev
# tooling, but this build stages the app by hand, so electron-builder never
# collects them: copy the production tree in, nesting kept.
$modules = Join-Path $app 'node_modules'
New-Item -ItemType Directory -Force $modules | Out-Null
Push-Location $root
$production = & npm ls --omit=dev --all --parseable 2>$null
Pop-Location
foreach ($pkg in $production) {
    if (-not $pkg -or $pkg.Trim() -eq $root.Trim()) { continue }
    if (-not ([IO.Path]::GetFullPath($pkg)).StartsWith((Join-Path $root 'node_modules') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Runtime dependency is outside node_modules: $pkg"
    }
    $relative = $pkg.Substring($root.Length).TrimStart('\', '/')
    $target = Join-Path $app $relative
    Assert-BuildPath $target
    $parent = Split-Path $target -Parent
    New-Item -ItemType Directory -Force $parent | Out-Null
    if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-Item -LiteralPath $pkg -Destination $target -Recurse -Force
}

# electron-updater reads its provider from resources\app-update.yml, which
# electron-builder writes when it packages by itself. This build stages the app
# itself (to dodge the EPERM some antivirus causes), so write the same file
# from the "publish" block in package.json.
$publish = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).build.publish | Select-Object -First 1
if ($publish) {
    $updateYml = @(
        "provider: $($publish.provider)"
        "owner: $($publish.owner)"
        "repo: $($publish.repo)"
        'updaterCacheDirName: busy-magpie-updater'
    ) -join "`n"
    Set-Content -LiteralPath (Join-Path $unpacked 'resources\app-update.yml') -Value $updateYml -Encoding utf8
}

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

& $builder --win nsis --x64 --prepackaged $unpacked --publish never "--config.directories.output=$dist"
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with code $LASTEXITCODE" }

Get-ChildItem $dist -Filter '*.exe' | ForEach-Object { Write-Host "built $($_.FullName)" }
