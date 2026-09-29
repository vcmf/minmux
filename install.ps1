# minmux installer for Windows (PowerShell).
#   irm https://raw.githubusercontent.com/vcmf/minmux/main/install.ps1 | iex
# Downloads the newest release's installer from GitHub and runs it. Fetched from the
# terminal, so it skips the browser SmartScreen prompt you'd get from a manual download.
$ErrorActionPreference = "Stop"
$repo = "vcmf/minmux"

Write-Host "`nInstalling minmux..."
$rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=1"
$release = $rel[0]
Write-Host "  latest release: $($release.tag_name)"

$asset = $release.assets | Where-Object { $_.name -like "*Setup*.exe" } | Select-Object -First 1
if (-not $asset) { throw "no Windows build found in $($release.tag_name)" }

$out = Join-Path $env:TEMP $asset.name
Write-Host "  downloading $($asset.name)"
Invoke-WebRequest $asset.browser_download_url -OutFile $out

Write-Host "  launching the installer..."
Start-Process -FilePath $out -Wait
Write-Host "`nDone. minmux should be in your Start menu.`n"
# The app used to be called smterm, a separate install: say so rather than remove it unasked
# (minmux copies its settings and layout on first launch).
if (Test-Path (Join-Path $env:LOCALAPPDATA "Programs\smterm")) {
  Write-Host "The old smterm app is still installed. Once minmux has your layout, remove it in"
  Write-Host "Settings > Apps > Installed apps (your settings stay in minmux).`n"
}
