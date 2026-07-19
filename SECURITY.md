# Security policy

Report vulnerabilities privately to the security contact configured by the project operator; do not upload exploit packages or private user data to a public issue. Until an operator contact is published, use a private repository security advisory.

## Integrity and threat model

Clients trust pinned Ed25519 public keys, not transport alone. TLS verification, approved hosts, manifest signature/expiry/schema/client-version/sequence checks, streaming exact-size/SHA-256 checks, safe filenames, bounded downloads/cache, atomic writes, and explicit installation reduce catalog tampering, rollback, path traversal, truncation, and accidental install risks. Hash equality does **not** show a package is safe. Human rights/package/hardware review remains mandatory.

Out of scope are compromised console firmware, a malicious trusted publisher key, vulnerabilities in the jailbroken environment, and commercial entitlement bypasses (which the project does not attempt). The client never edits the PS4 application database.

## Keys and incidents

Production private keys stay offline or in an approved signing service, separate from source, clients, containers, CI, logs, and environment templates. Development keys are clearly named, ignored, and never trusted by release builds. On suspected compromise: freeze publication; remove the affected key from the next client trust set; sign a revocation catalog with an unaffected key; invalidate CDN objects; notify users; preserve audit evidence; rotate under `docs/KEY_ROTATION.md`; and require an explicit client recovery path if rollback is necessary.

Logs redact credentials, authorization values, private signing paths, and credential-bearing URLs. Telemetry is off and not implemented.
