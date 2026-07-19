# PS4 build with OpenOrbis

The verified build uses only open-source host tooling:

- OpenOrbis PS4 Toolchain v0.5.4, tag commit `b458dfd9d2f5c40aa249b127c9b9b4488afdc686`
- Official `toolchain-llvm-18.tar.gz`, SHA-256 `3c7cd5bb593ca74fa1c13fd59f3938dc0fc07985167f7275063019e63abe4526`
- LLVM/Clang 18.1.8
- LibOrbisPkg/PkgTool 0.2.231.0 from the OpenOrbis release

No Sony SDK, publishing key, retail entitlement, or proprietary build tool is used. The result is a homebrew fake PKG, not a retail-signed package.

## Windows build

Download the [official OpenOrbis v0.5.4 asset](https://github.com/OpenOrbis/OpenOrbis-PS4-Toolchain/releases/tag/v0.5.4), verify the hash above, and extract it. Install or locally extract [LLVM 18.1.8](https://github.com/llvm/llvm-project/releases/tag/llvmorg-18.1.8). Then configure the two paths:

```powershell
$env:OO_PS4_TOOLCHAIN = 'C:\OpenOrbis\PS4Toolchain'
$env:LLVM_BIN = 'C:\LLVM-18.1.8\bin'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-ps4.ps1
```

The script also detects the workspace-local toolchain locations used by the recorded build. It deliberately avoids global environment changes and does not download or install software by itself.

## What the script does

1. Validates `PSTB00001` and `IV0000-PSTB00001_00-PLAYSTOREHB00000`, including their cross-match.
2. Compiles maintained C++17 sources for `x86_64-pc-freebsd12-elf` with warnings-as-errors.
3. Links the native ELF against OpenOrbis system stubs.
4. Converts the ELF to `eboot.bin` with `create-fself`.
5. Generates `sce_sys/param.sfo` and the GP4 project.
6. Adds the original 512×512 RGB `icon0.png` and the OpenOrbis sample runtime modules.
7. Builds the fake PKG with LibOrbisPkg.
8. Runs verbose `pkg_validate` and records the package entry table.
9. Writes a SHA-256 file and a machine-readable build report.

The user-facing artifact is `outputs/Playstore-HB-v0.1.0-PSTB00001.pkg`. Intermediate ELF/OELF, package staging, validation logs, and reports are under `build/ps4`.

## Console requirement

The package can only be considered for a jailbroken PS4 environment that explicitly supports installing homebrew fake PKGs. It will not install on an unmodified retail console. Copy it by the method supported by the exact jailbreak/package-installer environment, install it as a homebrew package, and complete every row in `docs/HARDWARE_TESTING.md`.

The build status remains **PS4 build produced but not hardware tested** until an actual PS4 install and launch record exists. A successful package validator result proves package structure and internal digests; it does not prove that the app launches or behaves correctly on hardware.
