param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release"
)

# Builds libjuice (static), ParadoxTransport.dll (the ICE co-op transport, ABI 3) and ParadoxTransportTest.exe.
# Exit code 0 only when every step succeeded; the DLL's SHA-256 is printed at the end. Runs unchanged on a developer PC and on a
# CI runner: MSBuild is found with vswhere (installed with every Visual Studio and Build Tools since 2017), or from PATH when a
# setup action such as microsoft/setup-msbuild put it there. See README.md "CI" for what the runner needs (toolset v145).
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-MsBuild {
    $ProgramFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
    $VsWhere = Join-Path $ProgramFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $VsWhere) {
        # The newest installation that has MSBuild (Community, Professional, Enterprise or Build Tools).
        $Found = & $VsWhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" |
            Select-Object -First 1
        if ($Found -and (Test-Path -LiteralPath $Found)) { return $Found }
    }
    $OnPath = Get-Command MSBuild.exe -ErrorAction SilentlyContinue
    if ($null -ne $OnPath) { return $OnPath.Source }
    throw "MSBuild was not found: install the Visual Studio C++ build tools (toolset v145), or put MSBuild.exe on PATH."
}

try {
    # A failure inside prepare-dependencies.ps1 is a terminating error here (it runs with -ErrorAction Stop semantics), so no exit
    # code is checked: the script returns without one when libjuice is already in place.
    & (Join-Path $ProjectRoot "prepare-dependencies.ps1")

    $MsBuild = Find-MsBuild
    Write-Host "MSBuild: $MsBuild"

    foreach ($Project in @("ParadoxTransport.vcxproj", "ParadoxTransportTest.vcxproj")) {
        & $MsBuild (Join-Path $ProjectRoot $Project) /m /t:Build "/p:Configuration=$Configuration" /p:Platform=x64 /nologo /v:minimal
        if ($LASTEXITCODE -ne 0) { throw "MSBuild failed for $Project (exit $LASTEXITCODE)" }
    }

    $Dll = Join-Path $ProjectRoot "build\$Configuration\ParadoxTransport.dll"
    $Test = Join-Path $ProjectRoot "build\$Configuration\ParadoxTransportTest.exe"
    if (-not (Test-Path -LiteralPath $Dll)) { throw "ParadoxTransport.dll was not produced: $Dll" }
    if (-not (Test-Path -LiteralPath $Test)) { throw "ParadoxTransportTest.exe was not produced: $Test" }

    Write-Host "Built transport module: $Dll"
    Write-Host "Built self-test:        $Test"
    Write-Host "ParadoxTransport.dll SHA-256 ($Configuration): $((Get-FileHash -LiteralPath $Dll -Algorithm SHA256).Hash)"
    exit 0
} catch {
    Write-Error $_
    exit 1
}
