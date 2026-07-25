# Playstore HB v1 baseline audit

Audit date: 2026-07-24
Repository: `https://github.com/Hi6795/playstore-hb`
Starting branch: `main`
Starting commit: `0089c7baa9226fc9e8283852434690319c08ec69`
Working branch: `release/v1-official-quality`
Baseline package version: `0.1.0`

## Scope inspected

The audit inspected all 129 tracked files, including the root policies and package configuration; every existing document; all scripts; the complete catalog API, migration, repository, and model; the administration and desktop applications; the native PS4 headers, sources, build definitions, assets, and metadata; core catalog/signing/download/persistence/update code; publisher tooling; tests; CI; Compose; containers; and deployment notes.

Required files explicitly read before implementation:

- `README.md`
- `CONTENT_POLICY.md`
- `SECURITY.md`
- `docs/ARCHITECTURE.md`
- `docs/KNOWN_LIMITATIONS.md`
- `docs/RELEASE_READINESS.md`
- `docs/HARDWARE_TESTING.md`
- every file under `scripts/`
- `apps/catalog-api/migrations/001_initial.sql`
- every API route and repository/model source
- every native client platform interface and implementation source

## Environment

| Tool | Baseline |
| --- | --- |
| Windows | `10.0.26200` |
| Node.js | `v24.14.0` |
| pnpm | `11.9.0` |
| Git | `2.54.0.windows.1` |
| Docker | Unavailable |
| OpenOrbis | Unavailable in the fresh checkout |
| Clang/LLD | Unavailable |

The first direct bootstrap attempt failed because Node/pnpm were not on `PATH` and the host PowerShell execution policy blocked `.ps1` files. The documented script then succeeded using the bundled Node/pnpm paths and `powershell.exe -ExecutionPolicy Bypass`. This invocation difference is environmental and is retained as evidence.

## Reproduced command results

| Command | Result | Evidence |
| --- | --- | --- |
| `scripts/bootstrap.ps1` | Pass with adjusted runtime path/policy | Frozen lockfile installed 130 packages; development-only keys generated; Docker warning emitted |
| `pnpm format:check` | Pass | 128 tracked text files passed |
| `pnpm lint` | Pass | Node, desktop, and admin TypeScript checks exited 0 |
| `pnpm test` | **Fail** | 42/43 passed; `tests/integration/api.test.ts` first health/catalog test exceeded the 15-second timeout; total 146.12 seconds |
| `pnpm build` | Pass | Server TypeScript, desktop Vite, and admin Vite builds exited 0 |
| `pnpm desktop` | Partial smoke only | Electron downloaded, launched, and remained alive; it was intentionally terminated. No visual or interaction claim is made |
| `pnpm publisher validate content/production/catalog.json` | Pass | Production catalog sequence 0, zero games, no validation errors |
| `pnpm benchmark:catalog` | Pass, desktop-only measurement | 1,000 development records in 89.436 ms on Node 24.14.0 / Intel Pentium Silver N5030 |
| `pnpm audit --prod --audit-level high` | **Fail** | Three high advisories in `fast-uri` and `find-my-way` |
| `pnpm licenses list --json --long` | Pass as inventory only | Does not establish release-notice completeness |
| `scripts/build-ps4.ps1` | **Blocked** | OpenOrbis toolchain root was not found |
| `docker compose up --build` | **Blocked** | Docker is unavailable |

No failure or skipped command is counted as passed.

## Architecture findings

### Reusable pieces worth preserving

- Catalog/domain types, canonical JSON, Ed25519 helpers, exact hashing, update identity rules, and the empty production fixture.
- Desktop download and UI state-machine concepts.
- Memory and PostgreSQL repository boundaries, while replacing their prototype data model.
- Original branding and the independent-project disclaimer.
- OpenOrbis package metadata, framebuffer bootstrap, controller input foundation, and narrow AppInstUtil boundary.
- Content policy requiring real, authorized, redistributable packages and authentic media.

### Critical security findings

1. `tokens[header.slice(7)]` performs prototype-chain lookup. `Bearer __proto__` can produce a truthy non-principal, and the rank comparison then fails open. Protected API routes are therefore bypassable.
2. Rank-based authorization lets publisher/administrator identities perform reviewer actions. Publication does not enforce that publisher, submitter, reviewer, and hardware tester satisfy separation-of-duties rules.
3. Package/media routes trust client-supplied hashes, dimensions, MIME values, and quarantine keys without transferring or validating objects.
4. The publisher filesystem command checks only that a signature file exists; it does not verify that signature before promotion.
5. Production may silently use volatile `MemoryRepository` storage when `DATABASE_URL` is absent.
6. Submission state can regress, ownership/state checks are missing on attachment routes, idempotency is globally scoped, and database uniqueness is raceable.
7. Public manifest and signature are fetched separately and the default stable catalog has an empty signature.
8. The written atomic-cache claim exceeds the implementation: manifest and signature are promoted separately and no verified load/highest-sequence recovery is present.
9. A fixed 30-second timer covers the entire desktop transfer rather than inactivity, making large downloads fail even while progressing.

### Backend gap

The API exposes only 15 routes, five submission states, four roles, and four database tables. None of the required multipart endpoints, storage adapters, normalized workflow tables, sessions, scanner workers, immutable validation reports, hardware reports, background publication jobs, revocations, rollback records, backups, or metrics exist. The admin application is one development form whose file inputs become filename strings.

### Native PS4 gap

The PS4 executable calls only a static six-tab framebuffer shell. No platform service graph is instantiated. AppInstUtil has a class implementation but no factory or caller and may be removed by linker garbage collection. SceNet/SceHttp/SceSsl are not linked. Catalog, HTTPS, signature, persistence, download, hash, media, installed-title, update, and diagnostic adapters do not exist. The current UI incorrectly labels the catalog online and claims resume/SHA behavior is built in.

### Infrastructure and release gap

- The Kubernetes file explicitly says it is non-deployable.
- MinIO is unused by the API, and Compose has no workers, scanner, proxy/TLS, monitoring, or backups.
- Admin API/CSP endpoints are hardcoded to localhost.
- No `.dockerignore` prevents ignored local secrets from entering build context.
- CI omits audit, SAST, database/object integration, container, SBOM, complete license, provenance, and artifact-signing gates; the PS4 job is disabled.
- The secret regex misses standard PKCS#8/EC keys and GitHub tokens.
- The release script accepts the first stale PKG, does not require a clean tree or matching source commit, and creates an incomplete source archive.

## Dependency audit failures

- `fast-uri` 3.1.3 and 4.1.0: host-confusion advisory `GHSA-v2hh-gcrm-f6hx`; patched in 3.1.4 and 4.1.1.
- `find-my-way` 9.6.0: HTTP/2 denial-of-service advisory `GHSA-c96f-x56v-gq3h`; patched in 9.6.1.

These are release blockers until the lockfile resolves patched versions and the production audit exits successfully.

## Repository posture

At baseline, the public repository had only `main`, no tags/releases, no branch protection, and disabled Dependabot/security-scanning features. The latest narrow CI run passed, but its missing gates prevent that result from demonstrating production readiness.

## Baseline conclusion

The repository is a credible prototype, not a production storefront. The immediate implementation order is:

1. Close authentication and role-separation failures.
2. Normalize workflow data and enforce state/identity invariants.
3. Implement direct multipart storage and hostile-input validation.
4. Add immutable publication/signing/revocation/rollback.
5. Wire the native PS4 client and make all UI claims accurate.
6. Complete deployability, recovery, monitoring, scans, and release provenance.

The production game catalog remains empty.
