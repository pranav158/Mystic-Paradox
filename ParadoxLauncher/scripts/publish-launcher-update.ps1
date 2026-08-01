param(
  [Parameter(Mandatory = $true)]
  [string]$UpdateRoot,
  [string]$BaseUrl = "https://paradox.mysticfox.dev",
  [string]$Notes = "Mystic Paradox launcher update"
)

$ErrorActionPreference = "Stop"
$launcherRoot = (Resolve-Path "$PSScriptRoot\..").Path
$config = Get-Content "$launcherRoot\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$version = [string]$config.version
& "$PSScriptRoot\build-launcher-release.ps1"
if ($LASTEXITCODE -ne 0) { throw "Launcher build failed." }

$bundleDir = Join-Path $launcherRoot "src-tauri\target\release\bundle\nsis"
$artifact = Join-Path $bundleDir "Mystic Paradox Launcher_${version}_x64-setup.exe"
$signatureFile = "$artifact.sig"
if (-not (Test-Path $artifact) -or -not (Test-Path $signatureFile)) {
  throw "Signed NSIS updater artifacts were not produced."
}

$releaseDir = Join-Path $UpdateRoot "launcher\windows\x86_64\$version"
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
$fileName = Split-Path $artifact -Leaf
Copy-Item $artifact (Join-Path $releaseDir $fileName) -Force
$signature = (Get-Content -Raw $signatureFile).Trim()
$manifest = [ordered]@{
  version = $version
  notes = $Notes
  pub_date = (Get-Date).ToUniversalTime().ToString("o")
  file = $fileName
  url = "$BaseUrl/launcher/v1/updates/windows/x86_64/download"
  signature = $signature
}
$latestDir = Join-Path $UpdateRoot "launcher\windows\x86_64"
New-Item -ItemType Directory -Path $latestDir -Force | Out-Null
$manifest | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $releaseDir "manifest.json")
$manifest | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $latestDir "latest.json")
Write-Host "Published launcher $version to $latestDir"
