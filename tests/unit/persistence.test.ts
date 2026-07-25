import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AtomicJsonStore,
  CatalogCache,
  DEFAULT_SETTINGS,
  signCatalog,
  validateCatalog,
  validateSettings,
  verifySignedCatalog,
  type CatalogManifest,
} from "../../core/src/index.js";
import { developmentManifest } from "../fixtures/catalog.js";

const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function verifyPair(value: unknown, signature: string): CatalogManifest {
  const manifest = validateCatalog(value);
  return verifySignedCatalog(
    manifest,
    signature,
    [{ id: manifest.key_id, publicKeyPem: publicPem }],
    { highestSequence: 0, clientVersion: "0.1.0", now: new Date("2026-07-19") },
  );
}

function manifest(sequence = 9001): CatalogManifest {
  return { ...developmentManifest(), catalog_sequence: sequence, catalog_version: `2026.07.19.${sequence}` };
}

describe("atomic persistence", () => {
  it("round trips validated state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pshb-state-"));
    const path = join(dir, "settings.json");
    const store = new AtomicJsonStore(path, validateSettings, DEFAULT_SETTINGS);
    await store.save({ ...DEFAULT_SETTINGS, highContrast: true, downloadConcurrency: 4 });
    expect(await store.load()).toMatchObject({ highContrast: true, downloadConcurrency: 4 });
    expect(JSON.parse(await readFile(path, "utf8"))).toBeTruthy();
  });

  it("recovers corrupt non-security state to defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pshb-corrupt-"));
    const path = join(dir, "state.json");
    await writeFile(path, "{bad");
    const store = new AtomicJsonStore(path, (value) => value as { items: number[] }, { items: [] });
    expect(await store.load()).toEqual({ items: [] });
  });

  it("rejects invalid settings", () => {
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, downloadConcurrency: 5 })).toThrow("Invalid concurrency");
  });

  it("atomically promotes and loads one verified catalog generation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pshb-catalog-"));
    const cache = new CatalogCache(dir, verifyPair);
    const value = manifest();
    const signature = signCatalog(value, privatePem);
    await cache.commit(value, signature);
    const loaded = await cache.load();
    expect(loaded?.manifest.catalog_sequence).toBe(9001);
    expect(loaded?.signature).toBe(signature);
    expect(loaded?.generation).toMatch(/^9001-/);
    expect(await cache.ageMs()).toBeGreaterThanOrEqual(0);
  });

  it("rejects downgrade and same-sequence substitution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pshb-sequence-"));
    const cache = new CatalogCache(dir, verifyPair);
    const current = manifest(9001);
    await cache.commit(current, signCatalog(current, privatePem));

    const older = manifest(9000);
    await expect(cache.commit(older, signCatalog(older, privatePem))).rejects.toThrow("CATALOG_DOWNGRADE_REJECTED");

    const conflict = { ...manifest(9001), expires_at: "2031-07-18T00:00:00.000Z" };
    await expect(cache.commit(conflict, signCatalog(conflict, privatePem))).rejects.toThrow("CATALOG_SEQUENCE_CONFLICT");
  });

  it("keeps downgrade protection when the current generation is damaged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pshb-damaged-generation-"));
    const cache = new CatalogCache(dir, verifyPair);
    const current = manifest(9001);
    await cache.commit(current, signCatalog(current, privatePem));
    const pointer = JSON.parse(await readFile(join(dir, "current.json"), "utf8")) as { generation: string };
    await writeFile(join(dir, "generations", pointer.generation, "catalog.json"), "{damaged");
    expect(await cache.load()).toBeNull();

    const older = manifest(9000);
    await expect(cache.commit(older, signCatalog(older, privatePem))).rejects.toThrow("CATALOG_DOWNGRADE_REJECTED");
  });

  it("fails closed when the persisted sequence record is corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pshb-damaged-sequence-"));
    const cache = new CatalogCache(dir, verifyPair);
    const current = manifest(9001);
    await cache.commit(current, signCatalog(current, privatePem));
    await writeFile(join(dir, "highest-sequence.json"), "{damaged");
    const next = manifest(9002);
    await expect(cache.commit(next, signCatalog(next, privatePem))).rejects.toThrow("CATALOG_SEQUENCE_STATE_INVALID");
  });

  it("rejects malformed or untrusted signatures before caching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pshb-signature-"));
    const cache = new CatalogCache(dir, verifyPair);
    await expect(cache.commit(manifest(), "not-base64")).rejects.toThrow("Invalid Ed25519");
    await expect(cache.commit(manifest(), Buffer.alloc(64).toString("base64"))).rejects.toThrow("INVALID_CATALOG_SIGNATURE");
  });
});
