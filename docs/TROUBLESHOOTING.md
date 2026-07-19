# Troubleshooting

- `ERR_PNPM_IGNORED_BUILDS`: use pnpm 11.9+ and retain the explicit `allowBuilds` map; do not enable every build script.
- Desktop blank page: run `pnpm build:desktop` before `pnpm desktop`; Electron loads built assets.
- API database failure: verify PostgreSQL health and `DATABASE_URL`, then run migration `001_initial.sql`.
- Signature failure: confirm canonical manifest bytes, signature base64, key ID/public key match, activation window, expiry, client version, and sequence.
- Resume restarts at zero: server ignored Range or validator changed; restart is intentional and safe.
- PS4 build failure: verify OpenOrbis v0.5.4, LLVM 18, `OO_PS4_TOOLCHAIN`, `LLVM_BIN`, and the `create-fself`/`create-gp4`/PkgTool files. This release uses direct Clang/LLD commands, not a CMake toolchain file. Do not substitute proprietary headers or tools.
