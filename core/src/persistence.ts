import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digestCatalog } from "./signedCatalog.js";
import { DEFAULT_SETTINGS, type AppSettings, type CatalogManifest } from "./types.js";

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Directory fsync is not supported by every Node/Windows filesystem.
  }
}

async function writeDurableFile(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class AtomicJsonStore<T> {
  constructor(
    private readonly path: string,
    private readonly validate: (value: unknown) => T,
    private readonly fallback: T,
  ) {}

  async load(): Promise<T> {
    try {
      return this.validate(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(this.fallback);
      const corrupted = `${this.path}.corrupted-${Date.now()}`;
      try { await rename(this.path, corrupted); } catch { /* preserve the safe fallback */ }
      return structuredClone(this.fallback);
    }
  }

  async save(value: T): Promise<void> {
    const validated = this.validate(value);
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeDurableFile(temporary, `${JSON.stringify(validated, null, 2)}\n`);
      await rename(temporary, this.path);
      await syncDirectory(parent);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export function validateSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_SETTINGS);
  const candidate = { ...DEFAULT_SETTINGS, ...(value as Partial<AppSettings>) };
  if (!["cross", "circle"].includes(candidate.confirmButton)) throw new Error("Invalid confirm button");
  if (![1, 2, 3, 4].includes(candidate.downloadConcurrency)) throw new Error("Invalid concurrency");
  if (!Number.isInteger(candidate.bandwidthLimitKbps) || candidate.bandwidthLimitKbps < 0 || candidate.bandwidthLimitKbps > 1_000_000) throw new Error("Invalid bandwidth limit");
  if (!Number.isInteger(candidate.cacheLimitMiB) || candidate.cacheLimitMiB < 64 || candidate.cacheLimitMiB > 8192) throw new Error("Invalid cache limit");
  if (!Number.isFinite(candidate.safeAreaPercent) || candidate.safeAreaPercent < 3 || candidate.safeAreaPercent > 10) throw new Error("Invalid safe area");
  return candidate;
}

interface CatalogPointer {
  generation: string;
  sequence: number;
  digest: string;
}

interface HighestCatalog {
  sequence: number;
  digest: string;
}

export interface CachedCatalog {
  manifest: CatalogManifest;
  signature: string;
  generation: string;
}

export type CatalogPairVerifier = (manifest: unknown, signature: string) => CatalogManifest;

function validateDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid catalog digest");
  return value;
}

function validatePointer(value: unknown): CatalogPointer {
  if (!value || typeof value !== "object") throw new Error("Invalid catalog pointer");
  const candidate = value as Partial<CatalogPointer>;
  if (typeof candidate.generation !== "string" || !/^[a-zA-Z0-9._-]{1,160}$/.test(candidate.generation)) throw new Error("Invalid catalog generation");
  if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence ?? -1) < 0) throw new Error("Invalid catalog sequence");
  return { generation: candidate.generation, sequence: candidate.sequence!, digest: validateDigest(candidate.digest) };
}

function validateHighest(value: unknown): HighestCatalog {
  if (!value || typeof value !== "object") throw new Error("Invalid highest catalog record");
  const candidate = value as Partial<HighestCatalog>;
  if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence ?? -2) < -1) throw new Error("Invalid highest catalog sequence");
  if (candidate.sequence === -1 && candidate.digest === "") return { sequence: -1, digest: "" };
  return { sequence: candidate.sequence!, digest: validateDigest(candidate.digest) };
}

function normalizeSignature(value: string): string {
  const signature = value.trim();
  const decoded = Buffer.from(signature, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== signature) throw new Error("Invalid Ed25519 catalog signature");
  return signature;
}

export class CatalogCache {
  private readonly generations: string;
  private readonly pointerStore: AtomicJsonStore<CatalogPointer>;
  private readonly highestStore: AtomicJsonStore<HighestCatalog>;

  constructor(
    private readonly directory: string,
    private readonly verifyPair: CatalogPairVerifier,
  ) {
    this.generations = join(directory, "generations");
    this.pointerStore = new AtomicJsonStore(
      join(directory, "current.json"),
      validatePointer,
      { generation: "", sequence: 0, digest: "0".repeat(64) },
    );
    this.highestStore = new AtomicJsonStore(
      join(directory, "highest-sequence.json"),
      validateHighest,
      { sequence: -1, digest: "" },
    );
  }

  async load(): Promise<CachedCatalog | null> {
    try {
      const pointer = validatePointer(JSON.parse(await readFile(join(this.directory, "current.json"), "utf8")));
      const generationDirectory = join(this.generations, pointer.generation);
      const signature = normalizeSignature(await readFile(join(generationDirectory, "catalog.json.sig"), "utf8"));
      const manifest = this.verifyPair(
        JSON.parse(await readFile(join(generationDirectory, "catalog.json"), "utf8")),
        signature,
      );
      if (manifest.catalog_sequence !== pointer.sequence || digestCatalog(manifest) !== pointer.digest) throw new Error("Catalog generation does not match its pointer");
      return { manifest, signature, generation: pointer.generation };
    } catch {
      return null;
    }
  }

  async commit(manifest: CatalogManifest, signatureValue: string): Promise<void> {
    const signature = normalizeSignature(signatureValue);
    const verified = this.verifyPair(manifest, signature);
    const digest = digestCatalog(verified);
    const highest = await this.loadHighest();
    if (verified.catalog_sequence < highest.sequence) throw new Error("CATALOG_DOWNGRADE_REJECTED");
    if (verified.catalog_sequence === highest.sequence && highest.digest && highest.digest !== digest) throw new Error("CATALOG_SEQUENCE_CONFLICT");

    const current = await this.load();
    if (current && current.manifest.catalog_sequence === verified.catalog_sequence && digestCatalog(current.manifest) === digest && current.signature === signature) return;

    await mkdir(this.generations, { recursive: true });
    const generation = `${verified.catalog_sequence}-${digest.slice(0, 24)}-${Date.now()}-${process.pid}`;
    const temporary = join(this.generations, `.tmp-${generation}`);
    const destination = join(this.generations, generation);
    await mkdir(temporary, { recursive: false });
    let promoted = false;
    try {
      await writeDurableFile(join(temporary, "catalog.json"), `${JSON.stringify(verified, null, 2)}\n`);
      await writeDurableFile(join(temporary, "catalog.json.sig"), `${signature}\n`);
      await syncDirectory(temporary);
      await rename(temporary, destination);
      promoted = true;
      await syncDirectory(this.generations);
      await this.highestStore.save({ sequence: verified.catalog_sequence, digest });
      await this.pointerStore.save({ generation, sequence: verified.catalog_sequence, digest });
    } finally {
      if (!promoted) await rm(temporary, { recursive: true, force: true });
    }
  }

  async ageMs(): Promise<number | null> {
    const current = await this.load();
    if (!current) return null;
    try {
      return Date.now() - (await stat(join(this.generations, current.generation, "catalog.json"))).mtimeMs;
    } catch {
      return null;
    }
  }

  private async loadHighest(): Promise<HighestCatalog> {
    try {
      return validateHighest(JSON.parse(await readFile(join(this.directory, "highest-sequence.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sequence: -1, digest: "" };
      throw new Error("CATALOG_SEQUENCE_STATE_INVALID");
    }
  }
}
