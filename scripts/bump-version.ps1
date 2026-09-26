param([string]$Root = "$PSScriptRoot\..")

# Bump the cache-busting version in AssetManagement.html and APP_VERSION in
# app.js so they always agree. Run before committing a release.
#
# WHY: GitHub Pages and the browser both cache app.js. Without the ?v= query a
# push can go live while the page still runs the previous file, which looks
# exactly like the change never worked -- we lost time to that once already.
# The sidebar prints APP_VERSION so the running copy can be checked at a glance.
#
# ASCII only on purpose: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.

$Root = (Resolve-Path $Root).Path
$html = Join-Path $Root 'AssetManagement.html'
$js   = Join-Path $Root 'app.js'
foreach ($f in @($html, $js)) {
  if (-not (Test-Path -LiteralPath $f)) { throw "missing $f" }
}

# Today plus a letter, so several releases in one day still differ.
$today = Get-Date -Format 'yyyyMMdd'
$cur = [IO.File]::ReadAllText($js, [Text.Encoding]::UTF8)
$letter = 'a'
if ($cur -match "APP_VERSION\s*=\s*'$today([a-z])'") {
  $letter = [char]([int][char]$matches[1] + 1)
}
$ver = "$today$letter"

$h = [IO.File]::ReadAllText($html, [Text.Encoding]::UTF8)
$h = [regex]::Replace($h, '(?<=(?:app|i18n|flows|assetops|pricedb|meetings)\.js\?v=)[0-9a-z]+', $ver)
[IO.File]::WriteAllText($html, $h, (New-Object Text.UTF8Encoding $false))

$j = [regex]::Replace($cur, "(?<=APP_VERSION = ')[0-9a-z]+", $ver)
[IO.File]::WriteAllText($js, $j, (New-Object Text.UTF8Encoding $false))

Write-Host "version -> $ver"
Select-String -Path $html -Pattern '\.js\?v=' | ForEach-Object { '  ' + $_.Line.Trim() }
Select-String -Path $js -Pattern "APP_VERSION = " | ForEach-Object { '  ' + $_.Line.Trim() }
