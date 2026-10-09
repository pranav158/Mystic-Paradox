param(
  [string]$UpdateRoot = "$PSScriptRoot\..\..\ParadoxBackend\updates",
  [string]$BaseUrl = "https://paradox.mysticfox.dev",
  [string]$Notes = "Mystic Paradox launcher update",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$launcherRoot = (Resolve-Path "$PSScriptRoot\..").Path
$config = Get-Content "$launcherRoot\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$version = [string]$config.version
$productName = [string]$config.productName
if (-not $SkipBuild) {
  & "$PSScriptRoot\build-launcher-release.ps1"
  if ($LASTEXITCODE -ne 0) { throw "Launcher build failed." }
}

$bundleDir = Join-Path $launcherRoot "src-tauri\target\release\bundle\nsis"
$artifact = Join-Path $bundleDir "${productName}_${version}_x64-setup.exe"
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
$manifestJson = ($manifest | ConvertTo-Json) + [Environment]::NewLine
[System.IO.File]::WriteAllText((Join-Path $releaseDir "manifest.json"), $manifestJson, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $latestDir "latest.json"), $manifestJson, [System.Text.UTF8Encoding]::new($false))
Write-Host "Published launcher $version to $latestDir"
