[CmdletBinding()]
param(
  [string]$ToolchainRoot = $env:OO_PS4_TOOLCHAIN,
  [string]$LlvmBin = $env:LLVM_BIN,
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release',
  [string]$BuildDirectory = 'build/ps4',
  [switch]$NoOutputCopy
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
Set-Location -LiteralPath $repoRoot

function Resolve-RequiredDirectory([string]$Path, [string]$Description) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Description was not found: '$Path'. See docs/PS4_BUILD.md."
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE`: $Program $($Arguments -join ' ')"
  }
}

if ([string]::IsNullOrWhiteSpace($ToolchainRoot)) {
  $bundledToolchain = 'work/openorbis-v0.5.4/extracted/OpenOrbis/PS4Toolchain'
  if (Test-Path -LiteralPath $bundledToolchain -PathType Container) {
    $ToolchainRoot = $bundledToolchain
  }
}
if ([string]::IsNullOrWhiteSpace($LlvmBin)) {
  $workspaceLlvm = 'work/llvm-18.1.8/portable/bin'
  if (Test-Path -LiteralPath $workspaceLlvm -PathType Container) {
    $LlvmBin = $workspaceLlvm
  } else {
    $clangCommand = Get-Command clang++.exe -ErrorAction SilentlyContinue
    if ($clangCommand) { $LlvmBin = Split-Path -Parent $clangCommand.Source }
  }
}

$sdk = Resolve-RequiredDirectory $ToolchainRoot 'OpenOrbis toolchain root'
$llvm = Resolve-RequiredDirectory $LlvmBin 'LLVM binary directory'
$clang = Join-Path $llvm 'clang++.exe'
$lld = Join-Path $llvm 'ld.lld.exe'
$toolBin = Join-Path $sdk 'bin/windows'
$createFself = Join-Path $toolBin 'create-fself.exe'
$createGp4 = Join-Path $toolBin 'create-gp4.exe'
$pkgTool = Join-Path $toolBin 'PkgTool.Core.exe'
foreach ($requiredFile in @($clang, $lld, $createFself, $createGp4, $pkgTool, (Join-Path $sdk 'link.x'), (Join-Path $sdk 'lib/crt1.o'))) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "Required PS4 build tool/file is missing: $requiredFile" }
}

$metadata = Get-Content -Raw -LiteralPath 'apps/ps4-client/sce_sys/param.json' | ConvertFrom-Json
if ($metadata.title_id -notmatch '^[A-Z]{4}[0-9]{5}$') { throw 'Title ID format is invalid.' }
if ($metadata.content_id -notmatch '^[A-Z]{2}[0-9]{4}-[A-Z]{4}[0-9]{5}_00-[A-Z0-9]{16}$') { throw 'Content ID format is invalid.' }
if ($metadata.content_id.Substring(7, 9) -ne $metadata.title_id) { throw 'Content ID does not contain the configured title ID.' }
if ($metadata.version -notmatch '^[0-9]{1,2}\.[0-9]{2}$') { throw 'PS4 package version must be N.NN or NN.NN.' }

$buildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $BuildDirectory))
$allowedBuildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build'))
if (-not $buildRoot.StartsWith($allowedBuildRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'BuildDirectory must resolve below the repository build directory.'
}
$objectRoot = Join-Path $buildRoot 'obj'
$packageRoot = Join-Path $buildRoot 'package'
$artifactRoot = Join-Path $buildRoot 'artifacts'
if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $objectRoot, $packageRoot, $artifactRoot, (Join-Path $packageRoot 'sce_sys/about'), (Join-Path $packageRoot 'sce_module') | Out-Null

$sourceRoot = Join-Path $repoRoot 'apps/ps4-client'
$sources = @(
  (Join-Path $sourceRoot 'src/main.cpp'),
  (Join-Path $sourceRoot 'src/ps4_shell.cpp'),
  (Join-Path $sourceRoot 'src/application.cpp'),
  (Join-Path $sourceRoot 'src/openorbis_platform.cpp')
)
foreach ($source in $sources) {
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required PS4 source is missing: $source" }
}

$compileFlags = @(
  '--target=x86_64-pc-freebsd12-elf',
  '-std=c++17',
  '-fPIC',
  '-funwind-tables',
  '-ffunction-sections',
  '-fdata-sections',
  '-Wall',
  '-Wextra',
  '-Wpedantic',
  '-Werror',
  '-DPLAYSTOREHB_PS4=1',
  '-isysroot', $sdk,
  '-isystem', (Join-Path $sdk 'include'),
  '-isystem', (Join-Path $sdk 'include/c++/v1'),
  '-I', (Join-Path $sourceRoot 'include')
)
if ($Configuration -eq 'Release') {
  $compileFlags += @('-O2', '-DNDEBUG')
} else {
  $compileFlags += @('-O0', '-g')
}

$objects = @()
foreach ($source in $sources) {
  $object = Join-Path $objectRoot (([IO.Path]::GetFileNameWithoutExtension($source)) + '.o')
  Invoke-Checked $clang ($compileFlags + @('-c', '-o', $object, $source))
  $objects += $object
}

$elf = Join-Path $artifactRoot 'playstore-hb.elf'
$oelf = Join-Path $artifactRoot 'playstore-hb.oelf'
$eboot = Join-Path $packageRoot 'eboot.bin'
$linkArgs = @(
  '-m', 'elf_x86_64',
  '-pie',
  '--script', (Join-Path $sdk 'link.x'),
  '--eh-frame-hdr',
  '--gc-sections',
  '-o', $elf,
  ('-L' + (Join-Path $sdk 'lib')),
  '-lc', '-lkernel', '-lc++',
  '-lSceSystemService', '-lSceVideoOut', '-lScePad', '-lSceUserService', '-lSceAppInstUtil',
  (Join-Path $sdk 'lib/crt1.o')
) + $objects
Invoke-Checked $lld $linkArgs

$env:OO_PS4_TOOLCHAIN = $sdk
Invoke-Checked $createFself @('-in', $elf, '--out', $oelf, '--eboot', $eboot, '--paid', '0x3800000000000011')

$iconSource = Join-Path $sourceRoot 'sce_sys/icon0.png'
$rightSource = Join-Path $sdk 'samples/hello_world/sce_sys/about/right.sprx'
$libcSource = Join-Path $sdk 'samples/hello_world/sce_module/libc.prx'
$fiosSource = Join-Path $sdk 'samples/hello_world/sce_module/libSceFios2.prx'
foreach ($asset in @($iconSource, $rightSource, $libcSource, $fiosSource)) {
  if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) { throw "Required package asset is missing: $asset" }
}
Copy-Item -LiteralPath $iconSource -Destination (Join-Path $packageRoot 'sce_sys/icon0.png')
Copy-Item -LiteralPath $rightSource -Destination (Join-Path $packageRoot 'sce_sys/about/right.sprx')
Copy-Item -LiteralPath $libcSource -Destination (Join-Path $packageRoot 'sce_module/libc.prx')
Copy-Item -LiteralPath $fiosSource -Destination (Join-Path $packageRoot 'sce_module/libSceFios2.prx')

$sfo = Join-Path $packageRoot 'sce_sys/param.sfo'
Invoke-Checked $pkgTool @('sfo_new', $sfo)
$sfoEntries = @(
  @('APP_TYPE', 'Integer', '4', '1'),
  @('APP_VER', 'Utf8', '8', [string]$metadata.version),
  @('ATTRIBUTE', 'Integer', '4', '0'),
  @('CATEGORY', 'Utf8', '4', 'gd'),
  @('CONTENT_ID', 'Utf8', '48', [string]$metadata.content_id),
  @('DOWNLOAD_DATA_SIZE', 'Integer', '4', '0'),
  @('SYSTEM_VER', 'Integer', '4', '0'),
  @('TITLE', 'Utf8', '128', [string]$metadata.title),
  @('TITLE_ID', 'Utf8', '12', [string]$metadata.title_id),
  @('VERSION', 'Utf8', '8', [string]$metadata.version)
)
foreach ($entry in $sfoEntries) {
  Invoke-Checked $pkgTool @('sfo_setentry', $sfo, $entry[0], '--type', $entry[1], '--maxsize', $entry[2], '--value', $entry[3])
}

$gp4 = Join-Path $packageRoot 'pkg.gp4'
$packageFiles = 'eboot.bin sce_sys/about/right.sprx sce_sys/param.sfo sce_sys/icon0.png sce_module/libc.prx sce_module/libSceFios2.prx'
Push-Location -LiteralPath $packageRoot
try {
  Invoke-Checked $createGp4 @('-out', 'pkg.gp4', ('--content-id=' + [string]$metadata.content_id), '--files', $packageFiles)
  Invoke-Checked $pkgTool @('pkg_build', 'pkg.gp4', '.')
} finally {
  Pop-Location
}

$generatedPkg = Join-Path $packageRoot ($metadata.content_id + '.pkg')
if (-not (Test-Path -LiteralPath $generatedPkg -PathType Leaf)) {
  $generatedPkg = Get-ChildItem -LiteralPath $packageRoot -Filter '*.pkg' -File | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $generatedPkg -or -not (Test-Path -LiteralPath $generatedPkg -PathType Leaf)) { throw 'PkgTool completed without producing a PKG.' }

$version = (Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json).version
$artifactName = "Playstore-HB-v$version-$($metadata.title_id).pkg"
$artifactPkg = Join-Path $artifactRoot $artifactName
Copy-Item -LiteralPath $generatedPkg -Destination $artifactPkg

$validationLog = Join-Path $artifactRoot 'pkg-validation.txt'
& $pkgTool pkg_validate --verbose $artifactPkg 2>&1 | Tee-Object -FilePath $validationLog
if ($LASTEXITCODE -ne 0) { throw "PKG validation failed with exit code $LASTEXITCODE." }
$entryLog = Join-Path $artifactRoot 'pkg-entries.txt'
& $pkgTool pkg_listentries $artifactPkg 2>&1 | Tee-Object -FilePath $entryLog
if ($LASTEXITCODE -ne 0) { throw "PKG entry inspection failed with exit code $LASTEXITCODE." }

$pkgHash = (Get-FileHash -LiteralPath $artifactPkg -Algorithm SHA256).Hash.ToLowerInvariant()
$pkgSize = (Get-Item -LiteralPath $artifactPkg).Length
$clangVersion = (& $clang --version | Select-Object -First 1)
$pkgToolVersion = (& $pkgTool version | Out-String).Trim()
$toolchainArchive = 'work/openorbis-v0.5.4/toolchain-llvm-18.tar.gz'
$toolchainHash = if (Test-Path -LiteralPath $toolchainArchive) { (Get-FileHash -LiteralPath $toolchainArchive -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
$report = [ordered]@{
  status = 'PS4 build produced but not hardware tested'
  generated_at = (Get-Date).ToUniversalTime().ToString('o')
  application_version = $version
  title_id = [string]$metadata.title_id
  content_id = [string]$metadata.content_id
  package = $artifactName
  package_size_bytes = $pkgSize
  package_sha256 = $pkgHash
  configuration = $Configuration
  openorbis_release = 'v0.5.4'
  openorbis_tag_commit = 'b458dfd9d2f5c40aa249b127c9b9b4488afdc686'
  openorbis_archive_sha256 = $toolchainHash
  llvm = $clangVersion
  pkgtool = $pkgToolVersion
  pkg_validation_passed = $true
  ps4_hardware_tested = $false
}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $artifactRoot 'build-report.json') -Encoding utf8
"$pkgHash  $artifactName" | Set-Content -LiteralPath (Join-Path $artifactRoot ($artifactName + '.sha256.txt')) -Encoding ascii

if (-not $NoOutputCopy) {
  $outputRoot = Join-Path $repoRoot 'outputs'
  New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
  Copy-Item -LiteralPath $artifactPkg -Destination (Join-Path $outputRoot $artifactName) -Force
  Copy-Item -LiteralPath (Join-Path $artifactRoot ($artifactName + '.sha256.txt')) -Destination (Join-Path $outputRoot ($artifactName + '.sha256.txt')) -Force
  Copy-Item -LiteralPath (Join-Path $artifactRoot 'build-report.json') -Destination (Join-Path $outputRoot 'ps4-build-report.json') -Force
}

Write-Host "PS4 PKG produced: $artifactPkg"
Write-Host "SHA-256: $pkgHash"
Write-Host 'Status: PS4 build produced but not hardware tested'
