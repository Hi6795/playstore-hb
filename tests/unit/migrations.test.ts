import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../apps/catalog-api/src/migrations.js";

class FakeMigrationClient {
  readonly applied = new Map<string, string>();
  readonly statements: string[] = [];

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: Result[] }> {
    this.statements.push(text);
    if (text.includes("SELECT checksum_sha256 FROM schema_migrations")) {
      const digest = this.applied.get(String(values[0]));
      return { rows: digest ? [{ checksum_sha256: digest } as Result] : [] };
    }
    if (text.includes("INSERT INTO schema_migrations")) {
      this.applied.set(String(values[0]), String(values[1]));
    }
    return { rows: [] };
  }
}

describe("database migrations", () => {
  it("defines the normalized v1 domains and guarded workflow", async () => {
    const sql = await readFile("apps/catalog-api/migrations/002_v1_production.sql", "utf8");
    for (const table of [
      "users",
      "user_roles",
      "sessions",
      "games",
      "game_submissions",
      "releases",
      "upload_sessions",
      "upload_parts",
      "submission_files",
      "media_files",
      "validation_jobs",
      "validation_reports",
      "scan_results",
      "review_decisions",
      "hardware_test_reports",
      "publications",
      "catalog_versions",
      "revocations",
      "download_aggregates",
      "audit_events",
      "idempotency_records",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain("transition_submission(");
    expect(sql).toContain("submission status changes must use transition_submission()");
    expect(sql).toContain("FOREIGN KEY (release_id, package_sha256)");
    expect(sql).toContain("prevent_append_only_mutation()");
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it("applies ordered files once and rejects changed migration checksums", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pshb-migrations-"));
    const path = join(directory, "001_test.sql");
    await writeFile(path, "CREATE TABLE test_record(id text PRIMARY KEY);\n");
    const fake = new FakeMigrationClient();
    const client = fake as unknown as PoolClient;

    await runMigrations(client, directory);
    expect(fake.applied.has("001_test.sql")).toBe(true);
    const executionCount = fake.statements.filter((statement) => statement.includes("CREATE TABLE test_record")).length;
    expect(executionCount).toBe(1);

    await runMigrations(client, directory);
    expect(fake.statements.filter((statement) => statement.includes("CREATE TABLE test_record"))).toHaveLength(1);

    await writeFile(path, "CREATE TABLE test_record(id text PRIMARY KEY, value text);\n");
    await expect(runMigrations(client, directory)).rejects.toThrow("checksum changed");
  });
});
