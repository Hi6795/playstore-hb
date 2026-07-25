# Playstore HB v1 risk register

Status date: 2026-07-24
Owners: project operator and release engineering team

| ID | Severity | Risk | Current evidence | Mitigation and release gate | Status |
| --- | --- | --- | --- | --- | --- |
| R-001 | Critical | Protected API routes can fail open through prototype-chain token lookup | `Bearer __proto__` reaches a truthy inherited object | Own-property token lookup, runtime principal validation, exact permission checks, regression tests | Open |
| R-002 | Critical | One actor can review and publish the same submission | Rank-based RBAC and no publication role-separation check | Explicit permissions and immutable actor decisions bound to exact package hash | Open |
| R-003 | Critical | A caller can invent package hash/size/storage metadata | Metadata-only package/media endpoints trust request fields | Direct scoped multipart storage; server hash/inspection; immutable reports | Open |
| R-004 | Critical | Unverified manifest/signature can be promoted by offline publisher | Filesystem publish checks signature presence, not validity | Mandatory trusted-key verification immediately before atomic promotion | Open |
| R-005 | Critical | Malicious or malformed package/media harms workers or storage | No scanners, decode limits, sandbox, quotas, or object validation | Sandboxed bounded workers, MIME sniffing, image limits, ClamAV/YARA adapters, quotas | Open |
| R-006 | High | Dependency vulnerabilities are exploitable in production | Three high advisories from `pnpm audit --prod` | Upgrade transitive graph and make high-severity audit a CI/release gate | Open |
| R-007 | High | Database state bypasses workflow invariants | JSONB submissions, no normalized identities/FKs/state constraints | Add normalized schema, constraints, transactional transition service, concurrency tests | Open |
| R-008 | High | Idempotency can leak/cross-bind another actor's response | Keys scoped only by generic operation | Bind actor, route, normalized request digest, expiry, and response in one transaction | Open |
| R-009 | High | Live catalog becomes inconsistent or downgraded | Separate manifest/signature paths and incomplete cache promotion | Versioned immutable pair, signed pointer, verified generation load, persisted sequence | Open |
| R-010 | High | Public storage exposes quarantine or mutable package bytes | No storage adapter/policies/promotion verification | Separate buckets/prefixes, private-by-default policies, immutable paths, copied-byte verification | Open |
| R-011 | High | Native UI encourages trust in unimplemented controls | Static shell says online/resume/SHA without adapters | Remove false claims immediately; only expose verified states from real services | Open |
| R-012 | High | Native download/install accepts unsafe path or identity | AppInstUtil adapter lacks caller/title/category verification and hardware evidence | Approved directory, size/hash/revocation/title/category checks, explicit confirmation, hardware test | Open |
| R-013 | High | Signing-key compromise enables malicious catalogs | Operational ceremony/recovery is incomplete | Offline or protected service, multiple trusted keys, freeze/rotation/recovery runbook and drill | Open |
| R-014 | High | Production loses submissions/catalog/audit history | No backup/restore implementation or evidence | Daily database/object manifests, protected key backup, integrity checks, restore and rollback drill | Open |
| R-015 | High | Release artifacts do not match source | Stale-PKG selection and no clean-tree/source commit gate | Exact artifact paths, embedded commit report, clean-tree archive from Git, checksums, SBOM | Open |
| R-016 | High | Unauthorized or invented content reaches catalog | No real candidate has completed review/hardware gates | Keep production catalog empty until rights, provenance, scan, and exact-hash PS4 evidence exist | Controlled |
| R-017 | Medium | Large valid downloads always time out | One 30-second timer spans the full transfer | Inactivity timeouts, progress reset, resume/ETag/If-Range tests | Open |
| R-018 | Medium | Container deployment leaks secrets or is nonfunctional | No `.dockerignore`; unused MinIO; non-deployable manifests | Harden build contexts, complete services/policies, run container and privacy tests | Open |
| R-019 | Medium | Logs expose tokens, URLs, or private evidence | No explicit redaction configuration/tests | Structured fields, allowlisted context, logger redaction, leak tests | Open |
| R-020 | Medium | Accessibility/controller regressions make PS4 UI unusable | Native shell has only basic tab input; no reconnect/repeat/modal tests | Central navigation model, focus tests, safe areas, text scale, high contrast, reduced motion | Open |
| R-021 | External blocker | PS4-specific behavior cannot be proven in this environment | OpenOrbis and physical PS4 are unavailable | Produce build when toolchain is provisioned; owner executes signed firmware 11.02 checklist | Blocked |
| R-022 | External blocker | Production hosting/signing/publication cannot be proven | No operator credentials, DNS, TLS, signing service, or approved package | Provide exact deployment/key procedures and record live evidence only when supplied | Blocked |

## Risk handling rules

- Critical and High risks cannot be accepted implicitly; each must be closed, explicitly deferred with an owner/date, or remain in `docs/V1_REMAINING_BLOCKERS.md`.
- Replacing a package invalidates all validation, review, hardware, and publication decisions tied to the prior hash.
- Automation never converts legal authorization or hardware compatibility into a pass.
- An unavailable tool or environment is recorded as blocked, never passed.
- The empty production catalog is a safety control, not a defect to bypass.
