# Catalog format

`schemas/catalog-v1.schema.json` is normative for shape; `core/src/catalog.ts` adds cross-record and policy validation. Version 1 requires an increasing integer `catalog_sequence`, display `catalog_version`, generation/expiration times, minimum client version, trusted `key_id`, channel, and games.

Identifiers, SemVer, dates, HTTPS, size (1 byte–100 GiB), lowercase SHA-256, safe `.pkg` names, categories, player counts, legal evidence, unique game/title/content IDs, and exact source-port notice are enforced. Production additionally requires active approval and rejects `development_test_data`.

Canonical serialization recursively sorts object keys, preserves array order, omits undefined values, and rejects non-finite numbers. The Ed25519 signature covers the canonical UTF-8 manifest bytes. Clients verify before displaying a refreshed catalog and atomically retain the last valid pair.
