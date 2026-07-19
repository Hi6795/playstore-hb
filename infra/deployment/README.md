# Deployment boundary

Production must supply managed PostgreSQL, private S3-compatible quarantine and public buckets, TLS termination, a secret manager, immutable images, and a dedicated signing service or offline signing handoff. The production Ed25519 private key must never enter this compose project, image, CI runner, or environment file. See `docs/DEPLOYMENT.md`.
