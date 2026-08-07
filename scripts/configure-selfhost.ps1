[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[A-Za-z0-9.-]+$")]
    [string]$PublicHost,

    [Parameter(Mandatory = $true)]
    [string]$GameServerBinaryPath,

    [Parameter(Mandatory = $true)]
    [string]$TlsCertificatePath,

    [Parameter(Mandatory = $true)]
    [string]$TlsPrivateKeyPath,

    [string]$TlsPrivateKeyPassphrase = "",
    [string]$MongoDbUri = "mongodb://127.0.0.1:27017",
    [string]$MongoDbName = "mysticparadox",
    [string]$GameServerPublicAddress = "127.0.0.1",
    [int]$BackendHttpPort = 3000,
    [int]$BackendHttpsPort = 443,
    [int]$DirectorPort = 3001,
    [int]$GamePortBegin = 8780,
    [int]$GamePortEnd = 8790,
    [switch]$UseSyntheticData,
    [switch]$InstallDependencies,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackendRoot = Join-Path $RepoRoot "ParadoxBackend"
$DirectorRoot = Join-Path $RepoRoot "ParadoxDirector"
$LauncherRoot = Join-Path $RepoRoot "ParadoxLauncher"
$RuntimeRoot = Join-Path $RepoRoot "ParadoxRuntime"

function Assert-File([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function New-RandomHex([int]$Bytes) {
    $Buffer = New-Object byte[] $Bytes
    $Generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $Generator.GetBytes($Buffer)
    }
    finally {
        $Generator.Dispose()
    }
    return ([BitConverter]::ToString($Buffer)).Replace("-", "").ToLowerInvariant()
}

function ConvertTo-DotEnvValue([string]$Name, [string]$Value) {
    if ($Value.Contains("`r") -or $Value.Contains("`n") -or $Value.Contains('"')) {
        throw "$Name contains a newline or double quote, which cannot be written safely to .env."
    }
    return '"' + $Value + '"'
}

function Set-EnvValue([string]$Path, [string]$Name, [string]$Value) {
    $Content = [IO.File]::ReadAllText($Path)
    $Pattern = "(?m)^" + [Text.RegularExpressions.Regex]::Escape($Name) + "=.*$"
    $SerializedValue = ConvertTo-DotEnvValue $Name $Value
    if ([Text.RegularExpressions.Regex]::IsMatch($Content, $Pattern)) {
        $Evaluator = [Text.RegularExpressions.MatchEvaluator]{
            param($Match)
            return $Name + "=" + $SerializedValue
        }
        $Content = [Text.RegularExpressions.Regex]::Replace($Content, $Pattern, $Evaluator, 1)
    }
    else {
        $Content = $Content.TrimEnd() + [Environment]::NewLine + $Name + "=" + $SerializedValue + [Environment]::NewLine
    }
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Initialize-EnvFile([string]$Example, [string]$Target) {
    if ((Test-Path -LiteralPath $Target) -and -not $Force) {
        throw "$Target already exists. Re-run with -Force only if replacing it is intentional."
    }
    Copy-Item -LiteralPath $Example -Destination $Target -Force
}

$GameServerBinaryPath = Assert-File $GameServerBinaryPath "Dauntless executable"
$TlsCertificatePath = Assert-File $TlsCertificatePath "TLS certificate"
$TlsPrivateKeyPath = Assert-File $TlsPrivateKeyPath "TLS private key"

if ($BackendHttpsPort -ne 443) {
    throw "The 1.12.0 runtime currently requires -BackendHttpsPort 443."
}
if ($GamePortEnd - $GamePortBegin -lt 2) {
    throw "The game port range needs at least three ports (hunts, Training Dojo, Ramsgate)."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 20 or newer is required."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is required."
}

$BackendEnv = Join-Path $BackendRoot ".env"
$DirectorEnv = Join-Path $DirectorRoot ".env"
Initialize-EnvFile (Join-Path $BackendRoot ".env.example") $BackendEnv
Initialize-EnvFile (Join-Path $DirectorRoot ".env.example") $DirectorEnv

$KeyPairJson = & node (Join-Path $PSScriptRoot "generate-selfhost-rsa-key.mjs")
if ($LASTEXITCODE -ne 0) {
    throw "JWT signing-key generation failed."
}
$KeyPair = $KeyPairJson | ConvertFrom-Json
$PrivateKeyB64 = [string]$KeyPair.privateKeyB64
$PublicKeyB64 = [string]$KeyPair.publicKeyB64
if ([string]::IsNullOrWhiteSpace($PrivateKeyB64) -or [string]::IsNullOrWhiteSpace($PublicKeyB64)) {
    throw "JWT signing-key generation returned an incomplete key pair."
}
$GameServerApiKey = New-RandomHex 32
$ExecutableHash = (Get-FileHash -LiteralPath $GameServerBinaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
$BaseUrl = "https://$PublicHost"

$BackendValues = [ordered]@{
    PORT = [string]$BackendHttpPort
    AUTH_MODE = "LAUNCHER"
    ALLOW_NO_AUTH_DEV_MODE = "false"
    AUTH_SIGNING_PRIVKEY_B64 = $PrivateKeyB64
    AUTH_SIGNING_PUBKEY_B64 = $PublicKeyB64
    MONGODB_URI = $MongoDbUri
    MONGODB_DB = $MongoDbName
    MONGODB_APP_NAME = "paradox-backend"
    MONGODB_CONNECT_TIMEOUT_MS = "5000"
    MONGODB_SERVER_SELECTION_TIMEOUT_MS = "5000"
    MONGODB_MAX_POOL_SIZE = "20"
    MONGODB_MAX_IDLE_TIME_MS = "60000"
    TARGET_CHANGELIST = "392819"
    QOS_TARGET_URL = "$BaseUrl/QoS"
    MATCHMAKING_MODE = "DEPLOYSERVER"
    DEPLOYSERVER_URL = "127.0.0.1:$DirectorPort"
    GAMESERVER_API_KEYS = $GameServerApiKey
    HTTPS_PORT = [string]$BackendHttpsPort
    PARADOX_CERT_PEM_PATH = $TlsCertificatePath
    PARADOX_KEY_PEM_PATH = $TlsPrivateKeyPath
    PARADOX_KEY_PASSPHRASE = $TlsPrivateKeyPassphrase
    LAUNCHER_ALLOWED_ORIGINS = "http://localhost:1420,https://$PublicHost"
    APPROVED_EXECUTABLE_SHA256 = $ExecutableHash
    UPDATE_PUBLIC_BASE_URL = $BaseUrl
    REALTIME_XMPP_ENABLED = "true"
    REALTIME_XMPP_CAPTURE = "false"
    REALTIME_XMPP_ALLOWED_HOSTS = $PublicHost
    REALTIME_XMPP_DEV_CITY_MUC = "false"
}
foreach ($Entry in $BackendValues.GetEnumerator()) {
    Set-EnvValue $BackendEnv $Entry.Key ([string]$Entry.Value)
}

$DirectorValues = [ordered]@{
    PORT = [string]$DirectorPort
    MY_IP = $GameServerPublicAddress
    PORT_RANGE_BEGIN = [string]$GamePortBegin
    PORT_RANGE_END = [string]$GamePortEnd
    GAMESERVER_BINARY_PATH = $GameServerBinaryPath
    METAGAME_API_KEY = $GameServerApiKey
    SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP = "3"
    GAMESERVER_READY_TIMEOUT_MS = "30000"
    MAX_CONCURRENT_HUNT_SERVERS = "3"
    SERVER_RUNTIME_AUTO_UPDATE = "false"
    SERVER_RUNTIME_UPDATE_REQUIRED = "false"
}
foreach ($Entry in $DirectorValues.GetEnumerator()) {
    Set-EnvValue $DirectorEnv $Entry.Key ([string]$Entry.Value)
}

$RuntimeConfig = @"
#pragma once

// Generated by scripts/configure-selfhost.ps1. Do not commit this file.
#define MP_PUBLIC_HOST L"$PublicHost"
"@
[IO.File]::WriteAllText(
    (Join-Path $RuntimeRoot "deployment_config.generated.h"),
    $RuntimeConfig,
    [Text.UTF8Encoding]::new($false)
)

$LauncherEnv = Join-Path $LauncherRoot ".env"
if ((Test-Path -LiteralPath $LauncherEnv) -and -not $Force) {
    throw "$LauncherEnv already exists. Re-run with -Force only if replacing it is intentional."
}
[IO.File]::WriteAllText(
    $LauncherEnv,
    "VITE_API_BASE_URL=$BaseUrl" + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
)

$SecretRoot = Join-Path $LauncherRoot ".secrets"
$RuntimeKeyBase = Join-Path $SecretRoot "selfhost-runtime-update"
$RuntimePrivateKey = "$RuntimeKeyBase.private.pem"
if (-not (Test-Path -LiteralPath $RuntimePrivateKey)) {
    Push-Location $LauncherRoot
    try {
        & node "scripts/generate-runtime-key.mjs" ".secrets/selfhost-runtime-update"
        if ($LASTEXITCODE -ne 0) {
            throw "Runtime signing-key generation failed."
        }
    }
    finally {
        Pop-Location
    }
}
$RuntimePublicKey = [IO.File]::ReadAllText("$RuntimeKeyBase.public.raw.b64").Trim()

$SelfHostRoot = Join-Path $RepoRoot ".selfhost"
New-Item -ItemType Directory -Force -Path $SelfHostRoot | Out-Null
$BuildEnvironment = [string]::Join([Environment]::NewLine, @(
    "# Dot-source this file before building or running the self-host launcher:",
    "#   . .\.selfhost\build-env.ps1",
    '$env:MYSTPAX_API_BASE_URL = "__BASE_URL__"',
    '$env:MYSTPAX_RUNTIME_ENDPOINT = "__BASE_URL__/launcher/v1/runtime"',
    '$env:MYSTPAX_RUNTIME_PUBLIC_KEY_B64 = "__RUNTIME_PUBLIC_KEY__"',
    'Write-Host "Mystic Paradox self-host launcher environment loaded for __PUBLIC_HOST__"',
    ""
))
$BuildEnvironment = $BuildEnvironment.Replace("__BASE_URL__", $BaseUrl)
$BuildEnvironment = $BuildEnvironment.Replace("__RUNTIME_PUBLIC_KEY__", $RuntimePublicKey)
$BuildEnvironment = $BuildEnvironment.Replace("__PUBLIC_HOST__", $PublicHost)
[IO.File]::WriteAllText(
    (Join-Path $SelfHostRoot "build-env.ps1"),
    $BuildEnvironment,
    [Text.UTF8Encoding]::new($false)
)

$SelfHostTauriConfig = @{
    app = @{
        security = @{
            csp = "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:3000 $BaseUrl; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'"
        }
    }
} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText(
    (Join-Path $SelfHostRoot "tauri.selfhost.conf.json"),
    $SelfHostTauriConfig,
    [Text.UTF8Encoding]::new($false)
)

if ($UseSyntheticData) {
    foreach ($Root in @($BackendRoot, $DirectorRoot)) {
        $GameDataRoot = Join-Path $Root "game-data"
        Get-ChildItem -LiteralPath $GameDataRoot -Filter "*.example.json" | ForEach-Object {
            $Destination = Join-Path $GameDataRoot ($_.Name -replace "\.example\.json$", ".json")
            Copy-Item -LiteralPath $_.FullName -Destination $Destination -Force
        }
    }
}

if ($InstallDependencies) {
    foreach ($Root in @($BackendRoot, $DirectorRoot, $LauncherRoot)) {
        Push-Location $Root
        try {
            & npm ci
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed in $Root" }
            & npm run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build failed in $Root" }
        }
        finally {
            Pop-Location
        }
    }
}

Write-Host ""
Write-Host "Self-host configuration created."
Write-Host "  Backend: $BackendEnv"
Write-Host "  Director: $DirectorEnv"
Write-Host "  Runtime host: $PublicHost"
Write-Host "  Approved executable SHA-256: $ExecutableHash"
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Generate real game data (or use -UseSyntheticData for build-only smoke tests)."
Write-Host "  2. Build ParadoxRuntime and place the DLLs beside the game executable."
Write-Host "  3. Start MongoDB, then ParadoxBackend, then ParadoxDirector."
Write-Host "  4. Dot-source .selfhost\build-env.ps1 before running the launcher."
Write-Host "  5. Run: npm run tauri -- dev --config ..\.selfhost\tauri.selfhost.conf.json"