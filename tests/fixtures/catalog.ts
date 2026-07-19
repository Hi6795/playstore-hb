import type { CatalogGame, CatalogManifest } from "../../core/src/types.js";

export function developmentGame(overrides: Partial<CatalogGame> = {}): CatalogGame {
  return {
    id: "development-test-data",
    title_id: "PSTB10001",
    content_id: "IV0000-PSTB10001_00-DEVELOPMENTFIX01",
    name: "DEVELOPMENT TEST DATA",
    developer: "Test suite",
    publisher: "Not for publication",
    version: "1.0.0",
    release_date: "2026-07-18",
    updated_at: "2026-07-18T00:00:00.000Z",
    summary: "DEVELOPMENT TEST DATA — not a store listing.",
    description: "A test-only metadata object with no associated game, package, or screenshots.",
    distribution_mode: "ready_to_play",
    requires_original_files: false,
    original_files_notice: null,
    categories: ["arcade"],
    tags: ["development-test-data"],
    players_min: 1,
    players_max: 1,
    local_multiplayer: false,
    online_multiplayer: false,
    internet_required: false,
    package: { url: "https://cdn.test.invalid/packages/development.pkg", size_bytes: 4, sha256: "0".repeat(64), filename: "development.pkg" },
    media: { cover: "https://cdn.test.invalid/media/cover.webp", background: "https://cdn.test.invalid/media/background.webp", icon: "https://cdn.test.invalid/media/icon.png", screenshots: [] },
    compatibility: { status: "unverified", models: [], firmware_reports: [], notes: ["Not hardware tested"] },
    legal: { code_license: "MIT", data_license: "CC0-1.0", source_url: "https://source.test.invalid/project", redistribution_status: "approved", redistribution_evidence_id: "TEST-ONLY", attribution: [] },
    changelog: [],
    development_test_data: true,
    ...overrides
  };
}

export function developmentManifest(games: CatalogGame[] = [developmentGame()], overrides: Partial<CatalogManifest> = {}): CatalogManifest {
  return { schema_version: 1, catalog_version: "2026.07.18.9001", catalog_sequence: 9001, generated_at: "2026-07-18T00:00:00.000Z", expires_at: "2030-07-18T00:00:00.000Z", minimum_client_version: "0.1.0", key_id: "development-test-key", channel: "development", games, ...overrides };
}
