param(
    [switch]$Force
)

# Restores the pinned libjuice source (ICE, STUN and TURN client; MPL-2.0) into third_party\, which git ignores.
# The archive hash was recorded on 13 October 2026 from the v1.7.4 tag on GitHub.
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ThirdPartyRoot = Join-Path $ProjectRoot "third_party"
$DependencyRoot = Join-Path $ThirdPartyRoot "libjuice-1.7.4"
$DownloadRoot = Join-Path $ThirdPartyRoot ".downloads"
$Archive = Join-Path $DownloadRoot "libjuice-v1.7.4.zip"
$StagingRoot = Join-Path $ThirdPartyRoot ".staging-libjuice-1.7.4"
$Url = "https://github.com/paullouisageneau/libjuice/archive/refs/tags/v1.7.4.zip"
$ExpectedSha256 = "02CCA69649A3163CE27BD59D9E04A5B69E39EB88BBE6BE89FC5F03B2D9A178FD"

if ((Test-Path -LiteralPath (Join-Path $DependencyRoot "include\juice\juice.h")) -and -not $Force) {
    Write-Host "libjuice is already prepared: $DependencyRoot"
    return
}

New-Item -ItemType Directory -Force -Path $DownloadRoot | Out-Null
if (-not (Test-Path -LiteralPath $Archive)) {
    Write-Host "Downloading pinned libjuice v1.7.4 source archive..."
    Invoke-WebRequest -Uri $Url -OutFile $Archive
}

$ActualSha256 = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToUpperInvariant()
if ($ActualSha256 -ne $ExpectedSha256) {
    throw "libjuice archive SHA-256 mismatch. Expected $ExpectedSha256, received $ActualSha256"
}

$ExpectedThirdPartyPrefix = [System.IO.Path]::GetFullPath($ThirdPartyRoot).TrimEnd('\') + '\'
foreach ($Target in @($StagingRoot, $DependencyRoot)) {
    $ResolvedTarget = [System.IO.Path]::GetFullPath($Target)
    if (-not $ResolvedTarget.StartsWith($ExpectedThirdPartyPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing dependency cleanup outside ParadoxTransport third_party: $ResolvedTarget"
    }
    if (Test-Path -LiteralPath $ResolvedTarget) {
        Remove-Item -LiteralPath $ResolvedTarget -Recurse -Force
    }
}

New-Item -ItemType Directory -Force -Path $StagingRoot | Out-Null
Expand-Archive -LiteralPath $Archive -DestinationPath $StagingRoot -Force
$ExtractedRoot = Join-Path $StagingRoot "libjuice-1.7.4"
if (-not (Test-Path -LiteralPath (Join-Path $ExtractedRoot "include\juice\juice.h"))) {
    throw "The pinned libjuice archive did not contain include\juice\juice.h"
}
Move-Item -LiteralPath $ExtractedRoot -Destination $DependencyRoot
Remove-Item -LiteralPath $StagingRoot -Recurse -Force

Write-Host "Prepared verified libjuice: $DependencyRoot"
Write-Host "Archive SHA-256: $ActualSha256"
