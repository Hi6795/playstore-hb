# Deployment

Build immutable API/admin containers from the lockfile. Run migrations as a single transactional job. Use managed PostgreSQL with encrypted backups; private quarantine and immutable public S3 buckets; TLS 1.2+ at a reverse proxy; strict origin policy; secret-manager tokens; network policies; request/body/rate limits; and retained append-only audit exports.

The signer is outside the cluster. Export a reviewed deterministic manifest/digest, sign offline, verify independently, then atomically promote versioned objects. Health checks never expose secrets. Rotate admin tokens, database credentials, and S3 credentials independently. Exercise backup restoration and catalog rollback in staging before production.
