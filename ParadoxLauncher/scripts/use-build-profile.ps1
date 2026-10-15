param(
  # A file name in build-profiles\ (without .json), for example "official".
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[A-Za-z0-9_-]+$")]
  [string]$Name,
  # Where the Tauri configuration overlay is written; pass it to `tauri build --config <path>`.
  [Parameter(Mandatory = $true)]
  [string]$OverlayPath,
  # Optional JSON merged over the profile's overlay, for example '{"bundle":{"createUpdaterArtifacts":false}}'.
  [string]$Merge = ""
)
# [2026-10-16] Applies a launcher build profile ON PURPOSE. The source names no server: a release build needs
# MYSTICPARADOX_API_BASE_URL and MYSTICPARADOX_RUNTIME_PUBLIC_KEY_B64 (it does not compile without them), and its base
# tauri.conf.json has no update server. A profile supplies those build variables (set here for this process) and a Tauri
# overlay (update server and key, allowed connections). The official release workflow and `npm run release:launcher`
# apply build-profiles\official.json; a self-hosted server uses scripts\configure-selfhost.ps1 instead.
# Windows PowerShell 5.1 and PowerShell 7 both run this. Profiles hold public values only; nothing secret is printed.

$ErrorActionPreference = "Stop"

function ConvertTo-PlainTable($Value) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $Table = [ordered]@{}
    foreach ($Property in $Value.PSObject.Properties) { $Table[$Property.Name] = ConvertTo-PlainTable $Property.Value }
    return $Table
  }
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    # The comma keeps a one-element list a list (PowerShell unrolls arrays returned from a function).
    return ,@($Value | ForEach-Object { ConvertTo-PlainTable $_ })
  }
  return $Value
}

function Merge-Table($Base, $Over) {
  foreach ($Key in @($Over.Keys)) {
    if ($Base.Contains($Key) -and $Base[$Key] -is [System.Collections.IDictionary] -and $Over[$Key] -is [System.Collections.IDictionary]) {
      Merge-Table $Base[$Key] $Over[$Key]
    } else {
      $Base[$Key] = $Over[$Key]
    }
  }
}

$BuildProfilePath = Join-Path (Split-Path -Parent $PSScriptRoot) "build-profiles\$Name.json"
if (-not (Test-Path -LiteralPath $BuildProfilePath)) { throw "No launcher build profile '$Name' ($BuildProfilePath)." }
$BuildProfile = Get-Content -Raw -LiteralPath $BuildProfilePath | ConvertFrom-Json

foreach ($Required in @("MYSTICPARADOX_API_BASE_URL", "MYSTICPARADOX_RUNTIME_PUBLIC_KEY_B64")) {
  $Value = $BuildProfile.env.$Required
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "Profile '$Name' does not set $Required." }
}
foreach ($Property in $BuildProfile.env.PSObject.Properties) {
  [Environment]::SetEnvironmentVariable($Property.Name, [string]$Property.Value, "Process")
}

$Overlay = ConvertTo-PlainTable $BuildProfile.tauri
if ($null -eq $Overlay) { $Overlay = [ordered]@{} }
if (-not [string]::IsNullOrWhiteSpace($Merge)) { Merge-Table $Overlay (ConvertTo-PlainTable ($Merge | ConvertFrom-Json)) }
$OverlayDirectory = Split-Path -Parent $OverlayPath
if ($OverlayDirectory -and -not (Test-Path -LiteralPath $OverlayDirectory)) { New-Item -ItemType Directory -Path $OverlayDirectory | Out-Null }
[IO.File]::WriteAllText($OverlayPath, ($Overlay | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))

Write-Host "Launcher build profile '$Name': server $($BuildProfile.env.MYSTICPARADOX_API_BASE_URL); overlay $OverlayPath"
