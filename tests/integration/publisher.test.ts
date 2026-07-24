import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signCatalog, type CatalogManifest } from "../../core/src/index.js";
import { developmentManifest } from "../fixtures/catalog.js";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], environment: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "tools/publisher-cli/src/cli.ts", ...args],
      { cwd: process.cwd(), env: { ...process.env, ...environment } },
      (error, stdout, stderr) => resolve({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      }),
    );
  });
}

async function fixture(manifest: CatalogManifest) {
  const directory = await mkdtemp(join(tmpdir(), "pshb-publisher-"));
  const catalog = join(directory, "catalog.json");
  const signature = join(directory, "catalog.json.sig");
  const publicKey = join(directory, "catalog-public.pem");
  const keys = generateKeyPairSync("ed25519");
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await writeFile(catalog, `${JSON.stringify(manifest)}\n`);
  await writeFile(signature, `${signCatalog(manifest, privatePem)}\n`);
  await writeFile(publicKey, keys.publicKey.export({ type: "spki", format: "pem" }));
  return { directory, catalog, signature, publicKey };
}

describe("publisher security boundary", () => {
  it("checks expiry at verification time rather than generated_at", async () => {
    const expired = developmentManifest([], {
      generated_at: "2020-01-01T00:00:00.000Z",
      expires_at: "2020-02-01T00:00:00.000Z",
    });
    const files = await fixture(expired);
    const result = await runCli([
      "verify-catalog",
      "--catalog", files.catalog,
      "--signature", files.signature,
      "--public-key", files.publicKey,
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).errors).toContain("CATALOG_EXPIRED");
  });

  it("verifies a signature before creating an immutable publication", async () => {
    const manifest = developmentManifest([], { catalog_sequence: 1, catalog_version: "2026.07.24.1" });
    const files = await fixture(manifest);
    await writeFile(files.signature, `${Buffer.alloc(64).toString("base64")}\n`);
    const target = join(files.directory, "published");
    const result = await runCli(
      [
        "publish",
        "--environment", "staging",
        "--catalog", files.catalog,
        "--signature", files.signature,
        "--public-key", files.publicKey,
      ],
      { PLAYSTOREHB_PUBLISH_TARGET_DIR: target },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).errors).toContain("INVALID_CATALOG_SIGNATURE");
  });

  it("promotes a verified catalog and refuses same-sequence replacement", async () => {
    const manifest = developmentManifest([], { catalog_sequence: 1, catalog_version: "2026.07.24.1" });
    const files = await fixture(manifest);
    const target = join(files.directory, "published");
    const args = [
      "publish",
      "--environment", "staging",
      "--catalog", files.catalog,
      "--signature", files.signature,
      "--public-key", files.publicKey,
    ];
    const first = await runCli(args, { PLAYSTOREHB_PUBLISH_TARGET_DIR: target });
    expect(first.code).toBe(0);
    const pointer = JSON.parse(await readFile(join(target, "staging", "current.json"), "utf8"));
    expect(pointer).toMatchObject({
      sequence: 1,
      catalog: "catalog-1/catalog.json",
      signature: "catalog-1/catalog.json.sig",
    });

    const replay = await runCli(args, { PLAYSTOREHB_PUBLISH_TARGET_DIR: target });
    expect(replay.code).toBe(1);
    expect(JSON.parse(replay.stdout).errors[0]).toContain("sequence must increase");
  });
});
