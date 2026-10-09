param(
  [string]$SigningKey = "$PSScriptRoot\..\.secrets\mystic-launcher.key",
  [string]$SigningPasswordFile = "$PSScriptRoot\..\.secrets\mystic-launcher.password",
  # Builds the P2P launcher (Steam transport, host/join sessions). Without it the build is the
  # default dedicated-only launcher.
  [switch]$P2P
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $SigningKey)) { throw "Missing Tauri signing key: $SigningKey" }
if (-not (Test-Path -LiteralPath $SigningPasswordFile)) { throw "Missing signing password file: $SigningPasswordFile" }

$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw -LiteralPath $SigningKey
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw -LiteralPath $SigningPasswordFile).Trim()
$previousLocation = Get-Location
try {
  # npm resolves package.json from the current directory.  The publish command is
  # intentionally callable from the workspace/deployment scripts, so pin its
  # working directory to the launcher rather than requiring callers to cd first.
  Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
  $buildArgs = @("--bundles", "nsis")
  if ($P2P) { $buildArgs += @("--features", "p2p") }
  npm.cmd run tauri build -- @buildArgs
  if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed with exit code $LASTEXITCODE" }

  # Tauri patches a small bundle-type marker in the executable copied into the NSIS
  # installer. Guard must bind that installed payload, not target\release\launcher.exe.
  $config = Get-Content -Raw -LiteralPath "src-tauri\tauri.conf.json" | ConvertFrom-Json
  $installer = Join-Path (Get-Location) "src-tauri\target\release\bundle\nsis\$($config.productName)_$($config.version)_x64-setup.exe"
  $installedLauncher = Join-Path (Get-Location) "src-tauri\target\release\installed\launcher.exe"
  node "$PSScriptRoot\..\..\scripts\extract-nsis-launcher-payload.mjs" --installer $installer --output $installedLauncher --replace
  if ($LASTEXITCODE -ne 0) { throw "Failed to extract the final NSIS launcher payload (exit code $LASTEXITCODE)" }
} finally {
  Set-Location -LiteralPath $previousLocation
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
