# Release-readiness report — 2026-07-18

Classification: **PS4 build produced but not hardware tested**. Application version 0.1.0.

Implemented and built: reusable TypeScript core; strict schema; Ed25519 manifest workflow; atomic cache/settings; download queue/state machine; SHA-256 integrity; update rules; platform contracts; Electron/Vite desktop preview; native OpenOrbis storefront shell; compiled AppInstUtil adapter; admin web; Fastify API; memory/PostgreSQL repositories; migration; publisher/media CLI; Docker definitions; CI; policies; and release scripts.

Desktop verification on Windows/Node 24.14.0 completed with strict type checking, 7 test files / 43 passing tests, server emission, desktop/admin production bundles, an Electron smoke test, production empty-catalog validation, and a development signing round-trip. A 1,000-record development manifest validated in 169.1 ms on an Intel Pentium Silver N5030. No automated test failed in that recorded run.

PS4 build verification used OpenOrbis v0.5.4 and Clang/LLD 18.1.8. All maintained PS4 sources compiled with `-Wall -Wextra -Wpedantic -Werror`; the ELF linked and converted to an FSELF `eboot.bin`; LibOrbisPkg built the fake PKG; verbose `pkg_validate` reported every listed limit, hash, and fake-signature check as OK. A second extraction recovered the embedded `eboot.bin`, runtime modules, and rights module; extracted `eboot.bin` and `icon0.png` hashes matched their staging inputs. Extracted SFO entries matched title `Playstore HB`, title ID `PSTB00001`, content ID `IV0000-PSTB00001_00-PLAYSTOREHB00000`, category `gd`, and version `01.00`.

Skipped, not passed: every real PS4 hardware test; Docker compose/container execution; production S3 and external identity integration; production signing with an offline key; publication of any game; native console networking/download/cache integration; and third-party vulnerability/license scans beyond the generated inventory.

Security controls include signature-before-use, trusted key IDs/rotation windows, expiry/min-client/sequence checks, exact-size/streaming hash, constant-time digest comparison, HTTPS and host allowlist, manual redirects, safe filenames, partial recovery/removal, explicit install confirmation, role separation, scrypt helper, request/body/MIME limits, request IDs, audit, idempotency, transactions, log/secret policy, an empty production catalog, and no production private key.

Release blockers: complete the PS4 hardware checklist; wire and test console network/filesystem/title-service adapters; integrate managed object-storage promotion and external identity; provision protected offline production keys; approve a real package or intentionally publish a signed empty catalog; and run container, dependency, license, and security scans.
