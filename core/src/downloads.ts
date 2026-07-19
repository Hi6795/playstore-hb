import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, truncate } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { AtomicJsonStore } from "./persistence.js";
import type { DownloadRecord, PackageDescriptor } from "./types.js";
import type { IStorageService } from "./platform.js";
import { verifyPackage } from "./integrity.js";

export type DownloadErrorCode =
  | "UNAPPROVED_HOST" | "UNSAFE_FILENAME" | "INSUFFICIENT_STORAGE" | "NETWORK_TIMEOUT"
  | "REDIRECT_LIMIT" | "HTTP_ERROR" | "RANGE_REJECTED" | "CONTENT_LENGTH_MISMATCH"
  | "HASH_MISMATCH" | "EXPIRED_URL" | "CANCELLED" | "CONNECTION_INTERRUPTED" | "FILESYSTEM_ERROR";

export class DownloadError extends Error {
  constructor(public readonly code: DownloadErrorCode, message: string) { super(message); this.name = "DownloadError"; }
}

export interface DownloadManagerOptions {
  downloadDirectory: string;
  approvedHosts: string[];
  storage: IStorageService;
  stateStore: AtomicJsonStore<DownloadRecord[]>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryLimit?: number;
  redirectLimit?: number;
  reservedSafetyBytes?: number;
  concurrency?: number;
  bandwidthLimitKbps?: number;
  backoffBaseMs?: number;
  onChange?: (record: DownloadRecord) => void;
}

const filenamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.pkg$/;

export class DownloadManager {
  private queue: DownloadRecord[] = [];
  private readonly aborters = new Map<string, AbortController>();
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: DownloadManagerOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }

  async initialize(): Promise<void> {
    this.queue = await this.options.stateStore.load();
    for (const item of this.queue) if (["preflighting", "downloading", "verifying"].includes(item.status)) item.status = "paused";
    await this.persist();
  }
  list(): DownloadRecord[] { return structuredClone(this.queue); }
  async enqueue(gameId: string, descriptor: PackageDescriptor): Promise<DownloadRecord> {
    if (!filenamePattern.test(descriptor.filename) || basename(descriptor.filename) !== descriptor.filename || descriptor.filename.includes("..")) throw new DownloadError("UNSAFE_FILENAME", "The catalog filename is unsafe.");
    this.assertApprovedUrl(descriptor.url);
    if (descriptor.expires_at && Date.parse(descriptor.expires_at) <= Date.now()) throw new DownloadError("EXPIRED_URL", "The package URL has expired.");
    const id = `${gameId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const now = new Date().toISOString();
    const record: DownloadRecord = { id, gameId, sourceUrl: descriptor.url, destination: join(this.options.downloadDirectory, descriptor.filename), expectedSize: descriptor.size_bytes, expectedSha256: descriptor.sha256, ...(descriptor.etag ? { expectedEtag: descriptor.etag } : {}), status: "queued", bytesCompleted: 0, attempts: 0, createdAt: now, updatedAt: now };
    this.queue.push(record); await this.persist(); return structuredClone(record);
  }
  async runPending(): Promise<void> {
    const count = Math.max(1, Math.min(3, this.options.concurrency ?? 1));
    const workers = Array.from({ length: count }, async () => {
      while (true) { const next = this.queue.find((item) => item.status === "queued"); if (!next) return; await this.execute(next); }
    });
    await Promise.all(workers);
  }
  async pause(id: string): Promise<void> { const record = this.required(id); this.aborters.get(id)?.abort("pause"); record.status = "paused"; await this.touch(record); }
  async resume(id: string): Promise<void> { const record = this.required(id); if (!["paused", "failed"].includes(record.status)) return; record.status = "queued"; delete record.errorCode; await this.touch(record); }
  async cancel(id: string): Promise<void> { const record = this.required(id); this.aborters.get(id)?.abort("cancel"); record.status = "cancelled"; await rm(`${record.destination}.part`, { force: true }); await this.touch(record); }
  async retry(id: string): Promise<void> { const record = this.required(id); if (record.attempts >= (this.options.retryLimit ?? 4)) throw new Error("Retry limit reached"); await this.resume(id); }
  async reorder(id: string, position: number): Promise<void> { const index = this.queue.findIndex((item) => item.id === id); if (index < 0) throw new Error("Unknown download"); const [record] = this.queue.splice(index, 1); this.queue.splice(Math.max(0, Math.min(position, this.queue.length)), 0, record!); await this.persist(); }

  private required(id: string): DownloadRecord { const record = this.queue.find((item) => item.id === id); if (!record) throw new Error(`Unknown download: ${id}`); return record; }
  private assertApprovedUrl(raw: string): URL { const url = new URL(raw); if (url.protocol !== "https:" || !this.options.approvedHosts.includes(url.hostname.toLowerCase()) || url.username || url.password) throw new DownloadError("UNAPPROVED_HOST", "Package host is not approved."); return url; }
  private async execute(record: DownloadRecord): Promise<void> {
    record.status = "preflighting"; record.attempts += 1; await this.touch(record);
    const partPath = `${record.destination}.part`;
    const safety = this.options.reservedSafetyBytes ?? 512 * 1024 * 1024;
    let partial = 0;
    try { partial = (await stat(partPath)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (partial > record.expectedSize) { await rm(partPath, { force: true }); partial = 0; }
    const required = record.expectedSize - partial + safety;
    if ((await this.options.storage.availableBytes(this.options.downloadDirectory)) < required || !(await this.options.storage.reserve(required))) return this.fail(record, "INSUFFICIENT_STORAGE");
    await mkdir(dirname(record.destination), { recursive: true });
    const aborter = new AbortController(); this.aborters.set(record.id, aborter);
    const timer = setTimeout(() => aborter.abort("timeout"), this.options.timeoutMs ?? 30_000);
    try {
      const headers = new Headers();
      if (partial > 0) { headers.set("Range", `bytes=${partial}-`); if (record.expectedEtag) headers.set("If-Range", record.expectedEtag); }
      let response = await this.requestWithRedirects(record.sourceUrl, headers, aborter.signal);
      if (partial > 0 && response.status === 200) { await truncate(partPath, 0); partial = 0; response = await this.requestWithRedirects(record.sourceUrl, new Headers(), aborter.signal); }
      if (partial > 0 && response.status !== 206) throw new DownloadError("RANGE_REJECTED", `Resume expected HTTP 206, received ${response.status}.`);
      if (partial === 0 && response.status !== 200) throw new DownloadError("HTTP_ERROR", `Download returned HTTP ${response.status}.`);
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength !== record.expectedSize - partial) throw new DownloadError("CONTENT_LENGTH_MISMATCH", "The server's content length did not match the catalog.");
      if (!response.body) throw new DownloadError("HTTP_ERROR", "Download returned no response body.");
      record.status = "downloading"; record.bytesCompleted = partial; await this.touch(record);
      const startedAt=Date.now();let nextAllowed=startedAt;const bytesPerMs=(this.options.bandwidthLimitKbps??0)*1024/1000;
      const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => { record.bytesCompleted += chunk.length; const elapsed=Math.max(1,Date.now()-startedAt);record.speedBytesPerSecond=Math.max(1,Math.round((record.bytesCompleted-partial)*1000/elapsed));record.estimatedSeconds=Math.ceil((record.expectedSize-record.bytesCompleted)/record.speedBytesPerSecond);record.updatedAt = new Date().toISOString(); this.options.onChange?.(structuredClone(record));if(bytesPerMs>0){nextAllowed=Math.max(Date.now(),nextAllowed)+Math.ceil(chunk.length/bytesPerMs);setTimeout(()=>callback(null,chunk),Math.max(0,nextAllowed-Date.now()));}else callback(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(partPath, { flags: partial > 0 ? "a" : "w", mode: 0o600 }));
      if (record.bytesCompleted !== record.expectedSize) throw new DownloadError("CONTENT_LENGTH_MISMATCH", "Downloaded byte count did not match the catalog.");
      record.status = "verifying"; await this.touch(record);
      const integrity = await verifyPackage(partPath, record.expectedSize, record.expectedSha256);
      if (!integrity.ok) { await rm(partPath, { force: true }); throw new DownloadError("HASH_MISMATCH", "Package hash did not match; the invalid file was removed."); }
      await rename(partPath, record.destination); record.status = "ready"; await this.touch(record);
    } catch (error) {
      const reason = aborter.signal.reason;
      if (reason === "pause") { record.status = "paused"; await this.touch(record); }
      else if (reason === "cancel") { record.status = "cancelled"; await this.touch(record); }
      else if (reason === "timeout") await this.fail(record, "NETWORK_TIMEOUT");
      else if (error instanceof DownloadError) await this.fail(record, error.code);
      else if (error instanceof TypeError || (error instanceof Error && /fetch|socket|terminated|network/i.test(error.message))) await this.fail(record,"CONNECTION_INTERRUPTED");
      else await this.fail(record, "FILESYSTEM_ERROR");
    } finally { clearTimeout(timer); this.aborters.delete(record.id); }
    if (["NETWORK_TIMEOUT","HTTP_ERROR","CONNECTION_INTERRUPTED"].includes(record.errorCode??"") && record.attempts < (this.options.retryLimit ?? 4)) {
      const delay=(this.options.backoffBaseMs??250)*2**(record.attempts-1);await new Promise((resolve)=>setTimeout(resolve,delay));record.status="queued";await this.touch(record);
    }
  }
  private async requestWithRedirects(raw: string, headers: Headers, signal: AbortSignal): Promise<Response> {
    let url = this.assertApprovedUrl(raw);
    for (let count = 0; count <= (this.options.redirectLimit ?? 5); count += 1) {
      const response = await this.fetchImpl(url, { headers, signal, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location"); if (!location) throw new DownloadError("HTTP_ERROR", "Redirect omitted Location header.");
      url = this.assertApprovedUrl(new URL(location, url).toString());
    }
    throw new DownloadError("REDIRECT_LIMIT", "Too many redirects.");
  }
  private async fail(record: DownloadRecord, code: DownloadErrorCode): Promise<void> { record.status = "failed"; record.errorCode = code; await this.touch(record); }
  private async touch(record: DownloadRecord): Promise<void> { record.updatedAt = new Date().toISOString(); this.options.onChange?.(structuredClone(record)); await this.persist(); }
  private async persist(): Promise<void> { await this.options.stateStore.save(this.queue); }
}
