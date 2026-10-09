[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $MongoDPath,

    [string] $MongoShellPath = "mongosh",
    [string] $NodePath = "node",

    [ValidateRange(1024, 65535)]
    [int] $MongoPort = 40917,

    [ValidateRange(1024, 65535)]
    [int] $HttpPort = 43100,

    [ValidateRange(1024, 65535)]
    [int] $HttpsPort = 43101,

    [string] $OutputRoot = ".\local-evidence/test-output\api-listener-failclosed"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$workspaceRoot = (Resolve-Path (Join-Path $packageRoot ".." )).Path
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot "local-evidence/test-output"))

function Resolve-Executable([string] $Path, [string] $Label) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        return (Resolve-Path -LiteralPath $Path).Path
    }
    $command = Get-Command $Path -ErrorAction Stop
    if (-not $command.Source) { throw "$Label did not resolve to an executable" }
    return (Resolve-Path -LiteralPath $command.Source).Path
}

function Assert-UnderAllowedRoot([string] $Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "refusing to use a path outside ${allowedRoot}: $full"
    }
    return $full
}

function Write-Utf8NoBom([string] $Path, [string] $Content) {
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Invoke-MongoShell([string] $Shell, [string] $Uri, [string] $Expression) {
    $output = @(& $Shell --quiet $Uri --eval $Expression 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "mongosh failed with exit code $LASTEXITCODE" }
    return $output
}

$mongoD = Resolve-Executable $MongoDPath "MongoDB server"
$mongoShell = Resolve-Executable $MongoShellPath "MongoDB shell"
$node = Resolve-Executable $NodePath "Node.js"
$outputBase = Assert-UnderAllowedRoot (Join-Path $workspaceRoot $OutputRoot)
$runRoot = Join-Path $outputBase ("run-" + [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + ([Guid]::NewGuid().ToString("N").Substring(0, 8)))
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$dbPath = Join-Path $runRoot "mongo"
New-Item -ItemType Directory -Path $dbPath -Force | Out-Null
$dbName = "mysticparadox_listener_" + ([Guid]::NewGuid().ToString("N").Substring(0, 10))
$replicaSet = "listenerTest"
$mongoUri = "mongodb://127.0.0.1:$MongoPort/$($dbName)?replicaSet=$replicaSet"
$mongoDirectUri = "mongodb://127.0.0.1:$MongoPort/admin?directConnection=true"
$mongoOut = Join-Path $runRoot "mongod.out.log"
$mongoErr = Join-Path $runRoot "mongod.err.log"
$apiOut = Join-Path $runRoot "api.out.log"
$apiErr = Join-Path $runRoot "api.err.log"
$apiEnv = Join-Path $runRoot "api.env"
$apiWrapper = Join-Path $runRoot "run-api.cjs"
$apiExitFile = Join-Path $runRoot "api.exit.json"
$authJson = Join-Path $runRoot "auth.json"
$authGenerator = Join-Path $runRoot "generate-auth.cjs"
$mongoProcess = $null
$apiProcess = $null
$tcpListener = $null
$result = $null

try {
    $mongoProcess = Start-Process -FilePath $mongoD -ArgumentList @(
        "--dbpath", $dbPath, "--replSet", $replicaSet, "--port", "$MongoPort",
        "--bind_ip", "127.0.0.1"
    ) -RedirectStandardOutput $mongoOut -RedirectStandardError $mongoErr -PassThru -WindowStyle Hidden

    $mongoReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $null = Invoke-MongoShell $mongoShell $mongoDirectUri "db.runCommand({ping:1})"
            $mongoReady = $true
            break
        } catch { }
    }
    if (-not $mongoReady) { throw "local mongod did not accept connections within 15 seconds" }
    $null = Invoke-MongoShell $mongoShell $mongoDirectUri "rs.initiate({_id:'$replicaSet',members:[{_id:0,host:'127.0.0.1:$MongoPort'}]})"

    $primaryReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $hello = (Invoke-MongoShell $mongoShell $mongoDirectUri "db.hello().isWritablePrimary") -join " "
            if ($hello -match "true") { $primaryReady = $true; break }
        } catch { }
    }
    if (-not $primaryReady) { throw "local mongod did not become primary within 15 seconds" }

    $authGeneratorSource = @'
const crypto = require("node:crypto");
const fs = require("node:fs");
const output = process.argv[2];
const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
fs.writeFileSync(output, JSON.stringify({
  privateKeyB64: Buffer.from(privatePem).toString("base64"),
  publicKeyB64: Buffer.from(publicPem).toString("base64")
}));
'@
    Write-Utf8NoBom $authGenerator $authGeneratorSource
    & $node $authGenerator $authJson | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "temporary auth key generation failed" }
    $auth = Get-Content -Raw -LiteralPath $authJson | ConvertFrom-Json

    $rootPosix = $workspaceRoot.Replace("\", "/")
    $envLines = @(
        "NODE_ENV=production",
        "AUTH_MODE=LAUNCHER",
        "AUTH_SIGNING_PRIVKEY_B64=$($auth.privateKeyB64)",
        "AUTH_SIGNING_PUBKEY_B64=$($auth.publicKeyB64)",
        "REALTIME_XMPP_DEV_CITY_MUC=false",
        "MYSTICPARADOX_SERVICE_ROLE=api",
        "MYSTICPARADOX_METRICS_TOKEN=listener-failclosed-test-token",
        "MONGODB_URI=$mongoUri",
        "MONGODB_DB=$dbName",
        "MONGODB_APP_NAME=listener-failclosed-test",
        "MONGODB_SERVER_SELECTION_TIMEOUT_MS=3000",
        "MONGODB_CONNECT_TIMEOUT_MS=3000",
        "MONGODB_TRANSACTION_MAX_COMMIT_TIME_MS=2000",
        "PORT=$HttpPort",
        "HTTPS_PORT=$HttpsPort",
        "PARADOX_CERT_PEM_PATH=$rootPosix/cert.pem",
        "PARADOX_KEY_PEM_PATH=$rootPosix/key.pem",
        "TARGET_CHANGELIST=392819",
        "REALTIME_XMPP_ENABLED=false",
        "LOG_LEVEL=info"
    )
    Write-Utf8NoBom $apiEnv ($envLines -join [Environment]::NewLine)

    $apiWrapperSource = @'
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [envFile, exitFile] = process.argv.slice(2);
const child = spawn(process.execPath, [`--env-file=${envFile}`, "build/server.js"], {
  stdio: "inherit"
});
child.on("exit", (code, signal) => {
  fs.writeFileSync(exitFile, JSON.stringify({ code, signal }));
  process.exit(code ?? 1);
});
'@
    Write-Utf8NoBom $apiWrapper $apiWrapperSource

    # Node's server.listen(port) selects the dual-stack wildcard on Windows. Hold
    # that exact address so the test cannot accidentally let the API bind IPv6 while
    # a loopback-only IPv4 fixture is listening.
    $tcpListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::IPv6Any, $HttpsPort)
    $tcpListener.Server.DualMode = $true
    $tcpListener.Start()

    $apiProcess = Start-Process -FilePath $node -WorkingDirectory $packageRoot -ArgumentList @($apiWrapper, $apiEnv, $apiExitFile) -RedirectStandardOutput $apiOut -RedirectStandardError $apiErr -PassThru -WindowStyle Hidden
    $completed = $apiProcess.WaitForExit(20000)
    $apiProcess.Refresh()
    if (-not $completed) { throw "production API did not terminate after HTTPS bind failure within 20 seconds" }
    $combinedLog = ((Get-Content $apiOut -ErrorAction SilentlyContinue) + (Get-Content $apiErr -ErrorAction SilentlyContinue)) -join [Environment]::NewLine
    $observedBindError = $combinedLog -match "HTTPS listener error|EADDRINUSE|HTTPS_LISTENER_ERROR"
    $apiExited = $apiProcess.HasExited
    $apiExitCode = $null
    if (Test-Path -LiteralPath $apiExitFile -PathType Leaf) {
        $apiExitCode = (Get-Content -Raw -LiteralPath $apiExitFile | ConvertFrom-Json).code
    }
    $result = [ordered]@{
        status = if ($apiExited -and $observedBindError) { "PASS" } else { "FAIL" }
        apiExited = $apiExited
        apiExitCode = $apiExitCode
        observedBindError = $observedBindError
        evidenceRoot = $runRoot
        logFiles = @("api.out.log", "api.err.log", "mongod.out.log", "mongod.err.log")
    }
    $result | ConvertTo-Json -Depth 8
    if ($result.status -ne "PASS") { throw "production listener fail-closed assertion failed" }
} finally {
    if ($apiProcess) {
        $apiProcess.Refresh()
        if (-not $apiProcess.HasExited) { Stop-Process -Id $apiProcess.Id -Force -ErrorAction SilentlyContinue }
    }
    if ($tcpListener) { try { $tcpListener.Stop() } catch { } }
    if ($mongoProcess) {
        $mongoProcess.Refresh()
        if (-not $mongoProcess.HasExited) {
            try { $null = Invoke-MongoShell $mongoShell $mongoDirectUri "db.adminCommand({shutdown:1})" } catch { }
            Start-Sleep -Seconds 1
            $mongoProcess.Refresh()
            if (-not $mongoProcess.HasExited) { Stop-Process -Id $mongoProcess.Id -Force -ErrorAction SilentlyContinue }
        }
    }
    Remove-Item -LiteralPath $apiEnv, $apiWrapper, $apiExitFile, $authJson, $authGenerator -Force -ErrorAction SilentlyContinue
}
