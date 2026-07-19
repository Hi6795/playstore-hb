# Publishing

Use `playstorehb-publisher validate`, `inspect-pkg`, `hash`, `process-media`, and `build-catalog` against quarantined reviewed inputs. `SOURCE_DATE_EPOCH` is mandatory for deterministic manifests. Inspect the JSON `diff-catalog` report, then sign with an explicit offline key path and verify with the matching public key.

`publish --environment production` refuses unsigned input, development channels/markers, schema failures, and records without approvals. It writes a versioned next directory atomically; promotion of the public CDN pointer is a separate authorized infrastructure operation. Preserve the previous signed version for rollback, never rewrite an immutable sequence, and audit actor/request/digest.
