import { timingSafeEqual } from "node:crypto";
import { SUPPORTED_CATEGORIES, type CatalogGame, type CatalogManifest } from "./types.js";

export class CatalogValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Catalog validation failed: ${issues.join("; ")}`);
    this.name = "CatalogValidationError";
  }
}

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const catalogVersion = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const titleId = /^[A-Z]{4}\d{5}$/;
const contentId = /^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_00-[A-Z0-9]{16}$/;
const sha256 = /^[a-f0-9]{64}$/;
const safeFilename = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.pkg$/;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function validHttps(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function gameIssues(game: CatalogGame, production: boolean, index: number): string[] {
  const p = `games[${index}]`;
  const issues: string[] = [];
  if (!slug.test(game.id)) issues.push(`${p}.id is not a stable slug`);
  if (!titleId.test(game.title_id)) issues.push(`${p}.title_id is invalid`);
  if (!contentId.test(game.content_id)) issues.push(`${p}.content_id is invalid`);
  if (!semver.test(game.version)) issues.push(`${p}.version is not semantic versioning`);
  if (!isoDate.test(game.release_date)) issues.push(`${p}.release_date is invalid`);
  if (Number.isNaN(Date.parse(game.updated_at))) issues.push(`${p}.updated_at is invalid`);
  if (!Number.isSafeInteger(game.package.size_bytes) || game.package.size_bytes <= 0 || game.package.size_bytes > 100 * 1024 ** 3) issues.push(`${p}.package.size_bytes is outside the supported range`);
  if (!sha256.test(game.package.sha256)) issues.push(`${p}.package.sha256 must be lowercase hex`);
  if (!safeFilename.test(game.package.filename) || game.package.filename.includes("..")) issues.push(`${p}.package.filename is unsafe`);
  if (!validHttps(game.package.url)) issues.push(`${p}.package.url must use HTTPS`);
  for (const [name, url] of Object.entries({ cover: game.media.cover, background: game.media.background, icon: game.media.icon })) if (!validHttps(url)) issues.push(`${p}.media.${name} must use HTTPS`);
  game.media.screenshots.forEach((url, n) => { if (!validHttps(url)) issues.push(`${p}.media.screenshots[${n}] must use HTTPS`); });
  if (game.categories.length === 0 || game.categories.some((value) => !SUPPORTED_CATEGORIES.includes(value))) issues.push(`${p}.categories contains an unsupported value`);
  if (game.players_min < 1 || game.players_max < game.players_min || game.players_max > 8) issues.push(`${p}.players range is invalid`);
  if (game.requires_original_files !== (game.distribution_mode === "requires_original_files")) issues.push(`${p}.distribution_mode and requires_original_files disagree`);
  if (game.requires_original_files && game.original_files_notice !== "Requires Original Game Files — Commercial data is not included — You must legally own the original game") issues.push(`${p}.original_files_notice must contain the required notice`);
  if (!game.legal.code_license || !game.legal.data_license || !validHttps(game.legal.source_url) || !game.legal.redistribution_evidence_id) issues.push(`${p}.legal record is incomplete`);
  if (production && game.legal.redistribution_status !== "approved") issues.push(`${p}.legal.redistribution_status is not approved`);
  if (production && game.development_test_data) issues.push(`${p} contains DEVELOPMENT TEST DATA`);
  return issues;
}

export function validateCatalog(value: unknown, options: { production?: boolean; now?: Date } = {}): CatalogManifest {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CatalogValidationError(["root must be an object"]);
  const m = value as Partial<CatalogManifest>;
  if (m.schema_version !== 1) issues.push("unsupported schema_version");
  if (typeof m.catalog_version !== "string" || !catalogVersion.test(m.catalog_version)) issues.push("catalog_version is invalid");
  if (!Number.isSafeInteger(m.catalog_sequence) || (m.catalog_sequence ?? 0) < 0) issues.push("catalog_sequence is invalid");
  if (typeof m.generated_at !== "string" || Number.isNaN(Date.parse(m.generated_at))) issues.push("generated_at is invalid");
  if (typeof m.expires_at !== "string" || Number.isNaN(Date.parse(m.expires_at))) issues.push("expires_at is invalid");
  if (typeof m.minimum_client_version !== "string" || !semver.test(m.minimum_client_version)) issues.push("minimum_client_version is invalid");
  if (typeof m.key_id !== "string" || !slug.test(m.key_id)) issues.push("key_id is invalid");
  if (!(["stable", "beta", "development"] as unknown[]).includes(m.channel)) issues.push("channel is invalid");
  if (!Array.isArray(m.games)) issues.push("games must be an array");
  else {
    const ids = new Set<string>(); const titleIds = new Set<string>(); const contentIds = new Set<string>();
    m.games.forEach((game, index) => {
      issues.push(...gameIssues(game, options.production ?? false, index));
      for (const [value, set, label] of [[game.id, ids, "id"], [game.title_id, titleIds, "title_id"], [game.content_id, contentIds, "content_id"]] as const) {
        if (set.has(value)) issues.push(`duplicate ${label}: ${value}`); else set.add(value);
      }
    });
  }
  if (issues.length) throw new CatalogValidationError(issues);
  return m as CatalogManifest;
}

export function constantTimeHashEqual(actual: string, expected: string): boolean {
  if (!sha256.test(actual) || !sha256.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function compareSemver(left: string, right: string): number {
  const parse = (value: string) => value.split("-")[0]!.split(".").map(Number);
  const a = parse(left); const b = parse(right);
  for (let i = 0; i < 3; i += 1) { const delta = (a[i] ?? 0) - (b[i] ?? 0); if (delta !== 0) return Math.sign(delta); }
  return left.includes("-") === right.includes("-") ? 0 : left.includes("-") ? -1 : 1;
}
