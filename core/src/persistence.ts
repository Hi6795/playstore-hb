import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_SETTINGS, type AppSettings, type CatalogManifest } from "./types.js";

export class AtomicJsonStore<T> {
  constructor(private readonly path: string, private readonly validate: (value: unknown) => T, private readonly fallback: T) {}
  async load(): Promise<T> {
    try { return this.validate(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(this.fallback);
      const corrupted = `${this.path}.corrupted-${Date.now()}`;
      try { await rename(this.path, corrupted); } catch { /* preserve original error semantics */ }
      return structuredClone(this.fallback);
    }
  }
  async save(value: T): Promise<void> {
    const validated = this.validate(value);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, this.path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}

export function validateSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_SETTINGS);
  const candidate = { ...DEFAULT_SETTINGS, ...(value as Partial<AppSettings>) };
  if (!["cross", "circle"].includes(candidate.confirmButton)) throw new Error("Invalid confirm button");
  if (![1, 2, 3].includes(candidate.downloadConcurrency)) throw new Error("Invalid concurrency");
  if (!Number.isInteger(candidate.bandwidthLimitKbps) || candidate.bandwidthLimitKbps < 0 || candidate.bandwidthLimitKbps > 1_000_000) throw new Error("Invalid bandwidth limit");
  if (!Number.isInteger(candidate.cacheLimitMiB) || candidate.cacheLimitMiB < 64 || candidate.cacheLimitMiB > 8192) throw new Error("Invalid cache limit");
  if (!Number.isFinite(candidate.safeAreaPercent) || candidate.safeAreaPercent < 3 || candidate.safeAreaPercent > 10) throw new Error("Invalid safe area");
  return candidate;
}

export class CatalogCache {
  constructor(private readonly directory: string) {}
  async commit(manifest: CatalogManifest, signature: string): Promise<void> {
    const store = new AtomicJsonStore(`${this.directory}/catalog.json`, (value) => value as CatalogManifest, manifest);
    await store.save(manifest);
    await mkdir(this.directory, { recursive: true });
    const sigPath = `${this.directory}/catalog.json.sig`;
    const tmp = `${sigPath}.tmp-${process.pid}`;
    const handle = await open(tmp, "w", 0o600);
    try { await handle.writeFile(`${signature.trim()}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, sigPath);
  }
  async ageMs(): Promise<number | null> { try { return Date.now() - (await stat(`${this.directory}/catalog.json`)).mtimeMs; } catch { return null; } }
}
