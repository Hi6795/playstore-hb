# Playstore HB v1 execution plan

Status date: 2026-07-24
Starting commit: `0089c7baa9226fc9e8283852434690319c08ec69`
Development branch: `release/v1-official-quality`
Target version: `1.0.0`

## Release position

The checked-in project is a useful prototype with a desktop-tested TypeScript core, a static native PS4 shell, a small Fastify administration API, and an intentionally empty production catalog. It is not a complete storefront. The v1 effort will preserve working domain rules while replacing prototype-only authentication, upload, storage, review, publication, and native-client paths.

The highest defensible classification until every external gate has evidence is **Release Candidate — PS4 build produced but not fully hardware tested**. `Public release validated` is forbidden until the complete acceptance sequence in `docs/V1_FINAL_VALIDATION.md` passes.

## Implementation status at baseline

| Domain | Baseline state | v1 requirement |
| --- | --- | --- |
| Catalog and signing | TypeScript validation, canonical JSON, Ed25519 utilities, empty production catalog | Strict production publication, protected signing integration, revocation and rollback |
| Persistence and downloads | Desktop-side queue/cache primitives | Correct atomic catalog generations, inactivity timeouts, collision-safe destinations, native adapters |
| API and database | 15 routes, five states, four generic JSON tables | Normalized schema, exact-role RBAC, sessions, complete state machine, jobs and immutable history |
| Uploads and storage | Caller-supplied metadata/storage keys | Direct multipart quarantine uploads, server-controlled keys, hashing, inspection, promotion |
| Validation | Field checks and PKG magic inspection | Sandboxed package/media/scanner workers and immutable reports |
| Administration | Single development form | Controller-independent professional operations portal and resumable upload client |
| Native PS4 | Static framebuffer shell; unused AppInstUtil class | Catalog, HTTPS, persistence, download, verification, install, updates, diagnostics, premium UI |
| Infrastructure | Development Compose skeleton | Workers, scanner, delivery proxy, metrics, backup/restore, production deployment templates |
| Release engineering | Desktop builds and unsafe archive script | Clean-tree provenance, SBOM, scans, complete source/deployment bundles, verified artifact selection |

## Milestones

### M0 — Baseline and branch isolation

- Reproduce documented commands and record pass, fail, and skipped results.
- Record starting commit and repository/security posture.
- Maintain `docs/V1_BASELINE_AUDIT.md` and `docs/V1_RISK_REGISTER.md`.
- Work only on `release/v1-official-quality`.
- Gate: no unrecorded baseline failures and no changes on `main`.

### M1 — Security foundation and normalized workflow

- Fix authentication fail-open behavior.
- Add explicit roles, exact permissions, separation-of-duties checks, secure sessions, revocation, rotation, and authentication audit events.
- Add normalized production tables, constraints, immutable events, idempotency body binding, and explicit state transitions.
- Gate: authorization, state-machine, cross-user, idempotency, and migration tests pass.

### M2 — Direct multipart quarantine uploads

- Add S3-compatible storage abstraction and MinIO development adapter.
- Implement initiate, part presign, status, part listing, completion, abort, retry-validation, and delete routes.
- Add quotas, part-size/concurrency limits, expiry cleanup, server-controlled keys, and restart recovery.
- Gate: multipart and object-privacy tests pass without proxying package bytes through Fastify.

### M3 — Automated validation and review

- Stream exact object size and SHA-256.
- Add non-executing package inspection, scanner adapters, media decoding limits, deterministic derivatives, and immutable reports.
- Add content, legal, security, hardware, and final approval decisions bound to the exact package hash.
- Gate: malformed, infected, timeout, replacement, ownership, and role-separation tests pass.

### M4 — Immutable publication, signing, suspension, revocation, and rollback

- Promote approved objects to immutable public keys and verify copied bytes.
- Generate, validate, diff, externally sign, verify, and atomically publish versioned catalogs.
- Preserve previous catalogs and add signed revocation and controlled rollback workflows.
- Gate: every injected publication failure leaves the current catalog unchanged.

### M5 — Native PS4 integration

- Add HTTPS/TLS/allowlist/redirect/range adapters and bounded background work.
- Add atomic catalog/settings/download persistence, pause/resume, exact-size/SHA-256 verification, storage preflight, explicit installation, installed-title/update discovery, diagnostics, and lifecycle handling.
- Add TypeScript/C++ conformance fixtures.
- Gate: host-side contract tests and OpenOrbis warnings-as-errors build pass; all hardware-only behavior remains explicitly unverified until tested.

### M6 — Premium UI and accessibility

- Replace the debug/retro presentation with original dark-navy, blue/cyan, purple/pink storefront components.
- Implement the required empty, offline, error, detail, queue, install, update, settings, diagnostics, about, and license states.
- Add robust controller navigation, focus restoration, safe areas, text scaling, high contrast, and reduced motion.
- Gate: desktop controller/focus/layout tests pass at 720p and 1080p; PS4 rendering requires hardware evidence.

### M7 — Deployability, observability, backup, and security

- Complete development Compose and documented production deployment.
- Add delivery Range configuration, bucket policies, CORS/lifecycle templates, metrics, structured redacted logs, health dependencies, backups, restore scripts, and disaster-recovery procedures.
- Pin CI actions, run dependency/secret/license/SBOM/container gates, and publish scan reports.
- Gate: container stack, database migration/restore, object restore, Range request, rollback, and secret-redaction tests pass where tooling is available.

### M8 — Release candidate and external validation

- Build all software and release artifacts from a clean committed tree.
- Produce checksums, SBOM, notices, scan reports, test reports, and complete source/deployment archives.
- Execute the formal PS4 firmware 11.02 test procedure with owner-supplied hardware evidence.
- Keep the game catalog empty unless a real package clears legal, security, provenance, and exact-hash hardware review.
- Gate: `docs/V1_FINAL_VALIDATION.md` is complete and `docs/V1_REMAINING_BLOCKERS.md` accurately lists every external or failed gate.

## Dependencies

- Node.js 24.14.0 and pnpm 11.9.0 are available through the Codex workspace runtime.
- Docker, PostgreSQL client tools, OpenOrbis, Clang/LLD, ClamAV/YARA, Trivy, Syft, Cosign, and Gitleaks are not presently available and must be installed or run in CI before their gates can pass.
- Production S3/CDN credentials, DNS/TLS control, identity-provider configuration, protected signing service or offline key ceremony, and physical PS4 access are operator-owned external dependencies.
- Real catalog content depends on rights-holder authorization and exact-package hardware evidence; no candidate is assumed eligible.

## Security implications

- Package and media inputs are hostile until validation and independent review complete.
- Browser clients receive only short-lived scoped upload URLs, never storage or signing credentials.
- Publication is fail-closed and immutable; database state alone never proves public bytes or signatures are valid.
- Review, hardware test, and publisher decisions bind to one SHA-256 and are invalidated by replacement.
- The PS4 client trusts a catalog only after TLS, signature, expiry, client-version, sequence, schema, host, and revocation checks.
- No client or server path may execute uploaded package content during validation.

## Test strategy

- Unit: domain rules, schemas, state transitions, roles, URLs, filenames, hashes, versions, revocations, settings, persistence.
- Integration: PostgreSQL constraints/transactions, S3 multipart behavior, workers, publication failure injection, sessions and CSRF.
- Contract: shared TypeScript/C++ fixtures and public catalog/storage HTTP semantics.
- UI: keyboard/controller focus, accessibility, empty/offline/error states, long content, 720p/1080p.
- Security: prototype keys, role escalation, path/object-key attacks, SSRF/open redirects, MIME spoofing, CSRF/XSS/SQL injection, secret leakage.
- Release: clean source provenance, reproducible inputs, exact artifacts, scans, SBOM, notices, checksums.
- Hardware: only the signed checklist and captured console evidence can convert a PS4 gate from skipped to passed.

## Rollback strategy

- Every milestone is committed independently on the release branch.
- Database migrations are additive during the release-candidate cycle and include tested down/restore procedures where destructive rollback would otherwise be required.
- Publication creates immutable versioned objects and changes only a signed pointer after verification; prior catalogs and package objects remain available for controlled rollback.
- A failed worker or publication attempt records its stage and leaves the current live catalog unchanged.
- The production catalog remains empty until a complete package review can be rolled back safely.
