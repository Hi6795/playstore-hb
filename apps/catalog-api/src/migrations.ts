import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";

const migrationPattern = /^[0-9]{3}_[a-z0-9_]+\.sql$/;

function checksum(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPool(client: Pool | PoolClient): client is Pool {
  return "connect" in client && typeof client.connect === "function";
}

export async function runMigrations(
  clientOrPool: Pool | PoolClient,
  directory = process.env.PLAYSTOREHB_MIGRATIONS_DIR
    ? resolve(process.env.PLAYSTOREHB_MIGRATIONS_DIR)
    : resolve(process.cwd(), "apps/catalog-api/migrations"),
): Promise<void> {
  const connection = isPool(clientOrPool) ? await clientOrPool.connect() : clientOrPool;
  const release = isPool(clientOrPool) ? () => connection.release() : () => undefined;
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(directory))
      .filter((name) => migrationPattern.test(name))
      .sort((left, right) => left.localeCompare(right));
    if (files.length === 0) throw new Error(`No database migrations found in ${directory}`);

    for (const file of files) {
      const sql = await readFile(resolve(directory, file), "utf8");
      const digest = checksum(sql);
      const existing = await connection.query<{ checksum_sha256: string }>(
        "SELECT checksum_sha256 FROM schema_migrations WHERE version=$1",
        [file],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum_sha256 !== digest) throw new Error(`Applied migration checksum changed: ${file}`);
        continue;
      }

      await connection.query("BEGIN");
      try {
        await connection.query("SELECT pg_advisory_xact_lock(hashtext('playstorehb-schema-migrations'))");
        const raced = await connection.query<{ checksum_sha256: string }>(
          "SELECT checksum_sha256 FROM schema_migrations WHERE version=$1 FOR UPDATE",
          [file],
        );
        if (raced.rows[0]) {
          if (raced.rows[0].checksum_sha256 !== digest) throw new Error(`Applied migration checksum changed: ${file}`);
        } else {
          await connection.query(sql);
          await connection.query(
            "INSERT INTO schema_migrations(version,checksum_sha256) VALUES($1,$2)",
            [file, digest],
          );
        }
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    release();
  }
}
