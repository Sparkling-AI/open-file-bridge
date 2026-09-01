[CmdletBinding()]
param(
    [string]$IdentityName,

    [string]$Publisher,

    [string]$PublisherDisplayName,
    [string]$AppDirectory,
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StoreIdentityPath = Join-Path $RepoRoot "build\msix\store-identity.json"
if (Test-Path $StoreIdentityPath -PathType Leaf) {
    $StoreIdentity = Get-Content $StoreIdentityPath -Raw | ConvertFrom-Json
    if (-not $IdentityName) { $IdentityName = $StoreIdentity.identityName }
    if (-not $Publisher) { $Publisher = $StoreIdentity.publisher }
    if (-not $PublisherDisplayName) { $PublisherDisplayName = $StoreIdentity.publisherDisplayName }
}
if (-not $IdentityName -or -not $Publisher -or -not $PublisherDisplayName) {
    throw "Store identity is incomplete. Pass all three identity parameters or populate build\msix\store-identity.json."
}

if (-not $AppDirectory) {
    $AppDirectory = Join-Path $RepoRoot "dist\OpenFileBridge"
}
if (-not $OutputPath) {
    $OutputPath = Join-Path $RepoRoot "dist\OpenFileBridge-windows-x64.msix"
}

$ExePath = Join-Path $AppDirectory "OpenFileBridge.exe"
if (-not (Test-Path $ExePath -PathType Leaf)) {
    throw "PyInstaller output not found at $ExePath. Build the Windows app first."
}

$SourceText = Get-Content (Join-Path $RepoRoot "src\file_bridge.py") -Raw
$VersionMatch = [regex]::Match($SourceText, '(?m)^VERSION = "(?<version>\d+\.\d+\.\d+)"\r?$')
if (-not $VersionMatch.Success) {
    throw "Could not read VERSION from src\file_bridge.py"
}
$PackageVersion = "$($VersionMatch.Groups['version'].Value).0"

function Escape-Xml([string]$Value) {
    return [System.Security.SecurityElement]::Escape($Value)
}

$TemplatePath = Join-Path $RepoRoot "build\msix\AppxManifest.xml.in"
$Manifest = Get-Content $TemplatePath -Raw
$Manifest = $Manifest.Replace("@@IDENTITY_NAME@@", (Escape-Xml $IdentityName))
$Manifest = $Manifest.Replace("@@PUBLISHER@@", (Escape-Xml $Publisher))
$Manifest = $Manifest.Replace("@@PUBLISHER_DISPLAY_NAME@@", (Escape-Xml $PublisherDisplayName))
$Manifest = $Manifest.Replace("@@VERSION@@", $PackageVersion)

$Staging = Join-Path $RepoRoot "build\msix-staging"
if (Test-Path $Staging) {
    Remove-Item $Staging -Recurse -Force
}
New-Item -ItemType Directory -Path $Staging | Out-Null

Copy-Item (Join-Path $AppDirectory "*") $Staging -Recurse -Force

# Copy directory contents rather than the directory itself. The normal CI
# build already places these assets in AppDirectory; copying the source folder
# onto an existing destination would otherwise create wheels\wheels and
# tessdata\tessdata inside the package.
foreach ($AssetName in @("wheels", "tessdata")) {
    $AssetSource = Join-Path $RepoRoot "src\$AssetName"
    $AssetDestination = Join-Path $Staging $AssetName
    New-Item -ItemType Directory -Path $AssetDestination -Force | Out-Null
    Copy-Item (Join-Path $AssetSource "*") $AssetDestination -Recurse -Force
}
Copy-Item (Join-Path $RepoRoot "build\msix\Assets") (Join-Path $Staging "Assets") -Recurse -Force

# Include the optional Windows OCR engine when the release preparation step
# has populated build\bundle\tesseract. Core/PDF functionality does not
# depend on it.
$Tesseract = Join-Path $RepoRoot "build\bundle\tesseract"
if (Test-Path $Tesseract -PathType Container) {
    $TesseractDestination = Join-Path $Staging "tesseract"
    New-Item -ItemType Directory -Path $TesseractDestination -Force | Out-Null
    Copy-Item (Join-Path $Tesseract "*") $TesseractDestination -Recurse -Force
}

$Manifest | Set-Content (Join-Path $Staging "AppxManifest.xml") -Encoding utf8

$MakeAppx = Get-Command MakeAppx.exe -ErrorAction SilentlyContinue
if ($MakeAppx) {
    $MakeAppxPath = $MakeAppx.Source
} else {
    $KitsBin = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $MakeAppxPath = Get-ChildItem $KitsBin -Filter MakeAppx.exe -Recurse |
        Where-Object { $_.FullName -match '\\x64\\MakeAppx\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $MakeAppxPath) {
    throw "MakeAppx.exe was not found. Install the Windows 10/11 SDK."
}

$OutputDirectory = Split-Path $OutputPath -Parent
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

& $MakeAppxPath pack /v /o /h SHA256 /d $Staging /p $OutputPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $OutputPath -PathType Leaf)) {
    throw "MakeAppx failed to create $OutputPath"
}

Write-Output "Created $OutputPath"
Write-Output "Package identity: $IdentityName"
Write-Output "Publisher: $Publisher"
Write-Output "Version: $PackageVersion"
