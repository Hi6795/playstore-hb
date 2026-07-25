[CmdletBinding()]
param(
  [string]$ToolchainRoot = $env:OO_PS4_TOOLCHAIN,
  [string]$LlvmBin = $env:LLVM_BIN,
  [string]$ToolchainArchive = $env:OO_PS4_TOOLCHAIN_ARCHIVE,
  [string]$ExpectedToolchainArchiveSha256,
  [string]$OpenOrbisRelease,
  [string]$OpenOrbisCommit,
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release',
  [string]$BuildDirectory = 'build/ps4',
  [switch]$NoOutputCopy
)

$ErrorActionPreference = 'Stop'

function Assert-NoReparsePointAncestors([string]$Path, [string]$Description) {
  $candidate = [IO.Path]::GetFullPath($Path)
  while ($true) {
    if (Test-Path -LiteralPath $candidate) {
      $item = Get-Item -LiteralPath $candidate -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Description traverses a reparse point and is rejected: '$($item.FullName)'."
      }
    }
    $parent = [IO.Directory]::GetParent($candidate)
    if ($null -eq $parent) { break }
    $candidate = $parent.FullName
  }
}

function Assert-CanonicalChildPath(
  [string]$Candidate,
  [string]$Parent,
  [string]$Description
) {
  $canonicalCandidate = [IO.Path]::GetFullPath($Candidate)
  $canonicalParent = [IO.Path]::GetFullPath($Parent).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  if (-not $canonicalCandidate.StartsWith(
      $canonicalParent + [IO.Path]::DirectorySeparatorChar,
      [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Description must resolve strictly below '$canonicalParent'."
  }
  Assert-NoReparsePointAncestors $canonicalCandidate $Description
  if (Test-Path -LiteralPath $canonicalCandidate) {
    $item = Get-Item -LiteralPath $canonicalCandidate -Force
    if (-not $item.PSIsContainer) {
      throw "$Description exists but is not a directory: '$canonicalCandidate'."
    }
    $resolved = (Resolve-Path -LiteralPath $canonicalCandidate).ProviderPath
    if (-not [string]::Equals(
        [IO.Path]::GetFullPath($resolved),
        $canonicalCandidate,
        [StringComparison]::OrdinalIgnoreCase)) {
      throw "$Description did not resolve to its canonical target: '$canonicalCandidate'."
    }
  }
  return $canonicalCandidate
}

function Assert-NoReparsePointsInTree([string]$Root, [string]$Description) {
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push([IO.Path]::GetFullPath($Root))
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($current)) {
      $entry = Get-Item -LiteralPath $entryPath -Force
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Description contains a reparse point and is rejected: '$($entry.FullName)'."
      }
      if ($entry.PSIsContainer) {
        $pending.Push($entry.FullName)
      }
    }
  }
}

$repoRootCandidate = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
Assert-NoReparsePointAncestors $repoRootCandidate 'Repository workspace'
$repoRoot = (Resolve-Path -LiteralPath $repoRootCandidate).ProviderPath
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

$resolvedToolchainArchive = $null
$toolchainArchiveHash = $null
if (-not [string]::IsNullOrWhiteSpace($ToolchainArchive)) {
  if (-not (Test-Path -LiteralPath $ToolchainArchive -PathType Leaf)) {
    throw "OpenOrbis toolchain archive was not found: '$ToolchainArchive'."
  }
  $resolvedToolchainArchive = (Resolve-Path -LiteralPath $ToolchainArchive).ProviderPath
  $toolchainArchiveHash =
    (Get-FileHash -LiteralPath $resolvedToolchainArchive -Algorithm SHA256).Hash.ToLowerInvariant()
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedToolchainArchiveSha256)) {
  $normalizedExpectedToolchainHash =
    $ExpectedToolchainArchiveSha256.Trim().ToLowerInvariant()
  if ($normalizedExpectedToolchainHash -notmatch '^[0-9a-f]{64}$') {
    throw 'ExpectedToolchainArchiveSha256 must contain exactly 64 hexadecimal characters.'
  }
  if ($null -eq $toolchainArchiveHash) {
    throw 'ExpectedToolchainArchiveSha256 requires ToolchainArchive.'
  }
  if ($toolchainArchiveHash -ne $normalizedExpectedToolchainHash) {
    throw "OpenOrbis archive SHA-256 mismatch. Expected $normalizedExpectedToolchainHash but found $toolchainArchiveHash."
  }
}
if (-not [string]::IsNullOrWhiteSpace($OpenOrbisCommit) -and
    $OpenOrbisCommit -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'OpenOrbisCommit must be a full 40-character commit hash when supplied.'
}
if (-not [string]::IsNullOrWhiteSpace($OpenOrbisRelease) -and
    $OpenOrbisRelease -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
  throw 'OpenOrbisRelease must use a vN.N.N tag when supplied.'
}
$trustedOpenOrbisRelease = 'v0.5.4'
$trustedOpenOrbisCommit = 'b458dfd9d2f5c40aa249b127c9b9b4488afdc686'
$trustedOpenOrbisArchiveSha256 =
  '3c7cd5bb593ca74fa1c13fd59f3938dc0fc07985167f7275063019e63abe4526'
if ($OpenOrbisRelease -eq $trustedOpenOrbisRelease) {
  if ($null -eq $toolchainArchiveHash) {
    throw "Verified $trustedOpenOrbisRelease provenance requires ToolchainArchive."
  }
  if ($toolchainArchiveHash -ne $trustedOpenOrbisArchiveSha256) {
    throw "The supplied archive is not the pinned $trustedOpenOrbisRelease release asset."
  }
  if ([string]::IsNullOrWhiteSpace($OpenOrbisCommit) -or
      $OpenOrbisCommit.ToLowerInvariant() -ne $trustedOpenOrbisCommit) {
    throw "OpenOrbisCommit does not match the pinned $trustedOpenOrbisRelease tag."
  }
}

$metadata = Get-Content -Raw -LiteralPath 'apps/ps4-client/sce_sys/param.json' | ConvertFrom-Json
if ($metadata.title_id -notmatch '^[A-Z]{4}[0-9]{5}$') { throw 'Title ID format is invalid.' }
if ($metadata.content_id -notmatch '^[A-Z]{2}[0-9]{4}-[A-Z]{4}[0-9]{5}_00-[A-Z0-9]{16}$') { throw 'Content ID format is invalid.' }
if ($metadata.content_id.Substring(7, 9) -ne $metadata.title_id) { throw 'Content ID does not contain the configured title ID.' }
if ($metadata.version -notmatch '^[0-9]{1,2}\.[0-9]{2}$') { throw 'PS4 package version must be N.NN or NN.NN.' }

if ([string]::IsNullOrWhiteSpace($BuildDirectory) -or
    [IO.Path]::IsPathRooted($BuildDirectory) -or
    $BuildDirectory.Contains(':')) {
  throw 'BuildDirectory must be a non-rooted workspace-relative path.'
}
$allowedBuildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build'))
$buildRootCandidate = [IO.Path]::GetFullPath((Join-Path $repoRoot $BuildDirectory))
$buildRoot = Assert-CanonicalChildPath $buildRootCandidate $allowedBuildRoot 'BuildDirectory'
$objectRoot = Join-Path $buildRoot 'obj'
$packageRoot = Join-Path $buildRoot 'package'
$artifactRoot = Join-Path $buildRoot 'artifacts'
if (Test-Path -LiteralPath $buildRoot) {
  # Re-evaluate immediately before the only recursive deletion. This rejects
  # junctions/symlinks at the target or any existing ancestor.
  $verifiedDeleteTarget =
    Assert-CanonicalChildPath $buildRoot $allowedBuildRoot 'BuildDirectory deletion target'
  Assert-NoReparsePointsInTree $verifiedDeleteTarget 'BuildDirectory deletion target'
  Remove-Item -LiteralPath $verifiedDeleteTarget -Recurse -Force
  if (Test-Path -LiteralPath $verifiedDeleteTarget) {
    throw "BuildDirectory deletion did not remove '$verifiedDeleteTarget'."
  }
}
New-Item -ItemType Directory -Force -Path $objectRoot, $packageRoot, $artifactRoot, (Join-Path $packageRoot 'sce_sys/about'), (Join-Path $packageRoot 'sce_module') | Out-Null
$createdBuildRoot =
  Assert-CanonicalChildPath $buildRoot $allowedBuildRoot 'Created BuildDirectory'
if (-not [string]::Equals(
    $createdBuildRoot,
    $buildRoot,
    [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Created BuildDirectory does not match the verified deletion target.'
}

$sourceRoot = Join-Path $repoRoot 'apps/ps4-client'
$sources = @(
  (Join-Path $sourceRoot 'src/main.cpp'),
  (Join-Path $sourceRoot 'src/ps4_shell.cpp'),
  (Join-Path $sourceRoot 'src/application.cpp'),
  (Join-Path $sourceRoot 'src/ps4_download.cpp'),
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
  '-lSceSystemService', '-lSceVideoOut', '-lScePad', '-lSceUserService',
  '-lSceNet', '-lSceSsl', '-lSceHttp', '-lSceSysmodule', '-lSceAppInstUtil',
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
$reportedRelease =
  if ([string]::IsNullOrWhiteSpace($OpenOrbisRelease)) { $null } else { $OpenOrbisRelease }
$reportedCommit =
  if ([string]::IsNullOrWhiteSpace($OpenOrbisCommit)) { $null } else { $OpenOrbisCommit.ToLowerInvariant() }
$archiveProvenanceVerified =
  $reportedRelease -eq $trustedOpenOrbisRelease -and
  $reportedCommit -eq $trustedOpenOrbisCommit -and
  $toolchainArchiveHash -eq $trustedOpenOrbisArchiveSha256
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
  openorbis_release = $reportedRelease
  openorbis_tag_commit = $reportedCommit
  openorbis_archive = $resolvedToolchainArchive
  openorbis_archive_sha256 = $toolchainArchiveHash
  openorbis_archive_provenance_verified = $archiveProvenanceVerified
  openorbis_provenance_verified = $false
  openorbis_provenance_source = if ($archiveProvenanceVerified) {
    'https://github.com/OpenOrbis/OpenOrbis-PS4-Toolchain/releases/tag/v0.5.4'
  } else {
    $null
  }
  toolchain_root = $sdk
  toolchain_root_provenance_verified = $false
  toolchain_root_provenance_note =
    'The release archive is pinned, but this script does not prove that the caller-supplied ToolchainRoot was extracted from that archive. Exact consumed binaries are hashed below.'
  linker_script_sha256 = (Get-FileHash -LiteralPath (Join-Path $sdk 'link.x') -Algorithm SHA256).Hash.ToLowerInvariant()
  crt1_sha256 = (Get-FileHash -LiteralPath (Join-Path $sdk 'lib/crt1.o') -Algorithm SHA256).Hash.ToLowerInvariant()
  llvm = $clangVersion
  clang_path = $clang
  clang_sha256 = (Get-FileHash -LiteralPath $clang -Algorithm SHA256).Hash.ToLowerInvariant()
  lld_path = $lld
  lld_sha256 = (Get-FileHash -LiteralPath $lld -Algorithm SHA256).Hash.ToLowerInvariant()
  pkgtool = $pkgToolVersion
  pkgtool_sha256 = (Get-FileHash -LiteralPath $pkgTool -Algorithm SHA256).Hash.ToLowerInvariant()
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
