# Architecture

The trust flow is: quarantined submission → automated structural/media/package checks → independent human review → deterministic manifest → offline Ed25519 signature → atomic object promotion → client TLS fetch → signature/sequence/expiry verification → last-known-good cache → explicit package download → exact size and streaming SHA-256 → explicit installation via platform service.

`core/src` owns domain rules. `catalog.ts` rejects invalid manifests before use; `signedCatalog.ts` canonicalizes and verifies; `persistence.ts` uses same-directory atomic replacement; `downloads.ts` owns the bounded state machine; `platform.ts` keeps console operations narrow; `ui.ts` preserves focus and debounces input; `updates.ts` requires game/title/content identity plus newer SemVer and active approval.

The desktop preview uses the same screen/navigation contract and simulates installation explicitly. The C++ client exposes matching service names and the same install sequence; OpenOrbis glue does not leak into domain headers. API repositories have memory and PostgreSQL implementations. Publication and approval use locked transactions in PostgreSQL.

Rendering/network/hash/image work are intended for worker/event queues; the current desktop UI has no network work on its render loop. A 1,000-record, explicitly marked development-data manifest validated in 169.1 ms on Windows 10.0.26200, Node 24.14.0, and an Intel Pentium Silver N5030. This measures desktop schema/domain validation only—not PS4 rendering, networking, or hardware compatibility.
