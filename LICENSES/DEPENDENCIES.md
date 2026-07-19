# Dependency inventory

| Dependency | Pinned version | Source | License | Purpose / attribution |
|---|---:|---|---|---|
| Fastify | 5.10.0 | https://github.com/fastify/fastify | MIT | HTTP API framework |
| node-postgres (`pg`) | 8.22.0 | https://github.com/brianc/node-postgres | MIT | PostgreSQL driver |
| Zod | 4.4.3 | https://github.com/colinhacks/zod | MIT | Request schema validation |
| sharp | 0.35.3 | https://github.com/lovell/sharp | Apache-2.0 | Deterministic image processing; includes libvips notices in its distribution |
| Electron | 43.1.1 | https://github.com/electron/electron | MIT | Windows/Linux desktop host |
| TypeScript | 7.0.2 | https://github.com/microsoft/TypeScript | Apache-2.0 | Strict compilation |
| Vite | 8.1.5 | https://github.com/vitejs/vite | MIT | Desktop/admin asset builds |
| Vitest | 4.1.10 | https://github.com/vitest-dev/vitest | MIT | Automated tests |
| tsx | 4.23.1 | https://github.com/privatenumber/tsx | MIT | TypeScript CLI/runtime |
| OpenOrbis PS4 Toolchain | 0.5.4 (`b458dfd`) | https://github.com/OpenOrbis/OpenOrbis-PS4-Toolchain | GPL-3.0 | PS4 headers, link script, stubs, SELF/GP4 tools, and sample runtime modules; build dependency, not vendored in source |
| LibOrbisPkg / PkgTool | 0.2.231.0 | https://github.com/OpenOrbis/LibOrbisPkg | LGPL-3.0 | SFO/GP4/fake-PKG build and validation; supplied by the pinned OpenOrbis release |
| LLVM / Clang / LLD | 18.1.8 | https://github.com/llvm/llvm-project | Apache-2.0 WITH LLVM-exception | PS4 cross-compiler and linker; host build tool, not included in the PKG |

Exact JavaScript transitive revisions and integrity hashes are pinned in `pnpm-lock.yaml`. The OpenOrbis release archive used for the PS4 artifact has SHA-256 `3c7cd5bb593ca74fa1c13fd59f3938dc0fc07985167f7275063019e63abe4526`. Release packaging must copy full applicable license texts; `pnpm run license-notices` generates the JavaScript summary notice. Inter is not vendored. If bundled later, record its exact revision and include SIL OFL 1.1.
