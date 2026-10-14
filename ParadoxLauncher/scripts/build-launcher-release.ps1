param(
  [string]$SigningKey = "$PSScriptRoot\..\.secrets\mystic-launcher.key",
  [string]$SigningPasswordFile = "$PSScriptRoot\..\.secrets\mystic-launcher.password",
  # Reports where the signing inputs come from and stops before the build. No value is printed.
  [switch]$CheckSigningInputs
)
# The optional modules are compiled in when their folders are present (src-tauri\build.rs): src-tauri\src\p2p (co-op
# hunts, used only while the runtime co-op switch is on) and src-tauri\src\anticheat. Without them the build is the
# dedicated-only launcher with Guard Lite.

$ErrorActionPreference = "Stop"

# CI (GitHub Actions secrets) provides the signing key in the environment. When TAURI_SIGNING_PRIVATE_KEY is already set, that
# key and TAURI_SIGNING_PRIVATE_KEY_PASSWORD are used and the .secrets files are not read. A missing password variable counts as
# empty (an unencrypted key); an encrypted key without its password fails the Tauri build. Without the variable, the local files
# are used exactly as before. Values are never printed.
$SetSigningEnv = [string]::IsNullOrEmpty($env:TAURI_SIGNING_PRIVATE_KEY)
if ($SetSigningEnv) {
  if (-not (Test-Path -LiteralPath $SigningKey)) { throw "Missing Tauri signing key: $SigningKey" }
  if (-not (Test-Path -LiteralPath $SigningPasswordFile)) { throw "Missing signing password file: $SigningPasswordFile" }
  $SigningSource = "files in .secrets"
} else {
  $SigningSource = "environment (TAURI_SIGNING_PRIVATE_KEY)"
}
Write-Host "Tauri signing inputs: $SigningSource"
if ($CheckSigningInputs) {
  Write-Host "Check only: nothing was built."
  return
}
if ($SetSigningEnv) {
  $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw -LiteralPath $SigningKey
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw -LiteralPath $SigningPasswordFile).Trim()
}
$previousLocation = Get-Location
try {
  # npm resolves package.json from the current directory.  The publish command is
  # intentionally callable from the workspace/deployment scripts, so pin its
  # working directory to the launcher rather than requiring callers to cd first.
  Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
  $buildArgs = @("--bundles", "nsis")
  $coop = if (Test-Path -LiteralPath "src-tauri\src\p2p\mod.rs") { "included" } else { "absent (dedicated-only)" }
  $antiCheat = if ($coop -eq "included" -and (Test-Path -LiteralPath "src-tauri\src\anticheat\mod.rs")) { "included" } else { "absent (Guard Lite)" }
  Write-Host "Launcher build; co-op module: $coop; anti-cheat module: $antiCheat"
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
  # Only the values this script wrote are removed; CI-provided variables stay as the runner set them.
  if ($SetSigningEnv) {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  }
}
