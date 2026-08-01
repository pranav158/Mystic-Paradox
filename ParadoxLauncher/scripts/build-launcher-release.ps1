param(
  [string]$SigningKey = "$PSScriptRoot\..\.secrets\mystic-launcher.key",
  [string]$SigningPasswordFile = "$PSScriptRoot\..\.secrets\mystic-launcher.password"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $SigningKey)) { throw "Missing Tauri signing key: $SigningKey" }
if (-not (Test-Path -LiteralPath $SigningPasswordFile)) { throw "Missing signing password file: $SigningPasswordFile" }

$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw -LiteralPath $SigningKey
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw -LiteralPath $SigningPasswordFile).Trim()
try {
  npm.cmd run tauri build -- --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
