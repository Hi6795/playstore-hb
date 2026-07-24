import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AtomicJsonStore,
  DownloadError,
  DownloadManager,
  type DownloadManagerOptions,
  type DownloadRecord,
  type IStorageService,
} from "../../core/src/index.js";

const bytes = Buffer.from("authorized development package bytes");
const hash = createHash("sha256").update(bytes).digest("hex");
const storage: IStorageService = { availableBytes: async () => 10 * 1024 ** 3, reserve: async () => true };

async function manager(
  fetchImpl: typeof fetch,
  storageService = storage,
  extra: Partial<DownloadManagerOptions> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "pshb-download-"));
  const store = new AtomicJsonStore<DownloadRecord[]>(join(dir, "queue.json"), (value) => value as DownloadRecord[], []);
  const value = new DownloadManager({
    downloadDirectory: dir,
    approvedHosts: ["cdn.test.invalid"],
    storage: storageService,
    stateStore: store,
    fetchImpl,
    reservedSafetyBytes: 0,
    ...extra,
  });
  await value.initialize();
  return { value, dir };
}

const descriptor = {
  url: "https://cdn.test.invalid/game.pkg",
  size_bytes: bytes.length,
  sha256: hash,
  filename: "game.pkg",
};

describe("download manager", () => {
  it("downloads, verifies, and atomically promotes a package", async () => {
    const { value } = await manager(async () => new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }));
    const record = await value.enqueue("test", descriptor);
    await value.runPending();
    expect(value.list()[0]?.status).toBe("ready");
    expect(await readFile(record.destination)).toEqual(bytes);
  });

  it("recovers in-progress queue items as paused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pshb-recover-"));
    const record: DownloadRecord = {
      id: "a",
      gameId: "g",
      sourceUrl: descriptor.url,
      destination: join(dir, "game.pkg"),
      expectedSize: bytes.length,
      expectedSha256: hash,
      status: "downloading",
      bytesCompleted: 1,
      attempts: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = new AtomicJsonStore<DownloadRecord[]>(join(dir, "queue.json"), (value) => value as DownloadRecord[], []);
    await store.save([record]);
    const value = new DownloadManager({ downloadDirectory: dir, approvedHosts: ["cdn.test.invalid"], storage, stateStore: store, fetchImpl: fetch });
    await value.initialize();
    expect(value.list()[0]?.status).toBe("paused");
  });

  it("rejects unsafe filenames and invalid package descriptors", async () => {
    const { value } = await manager(fetch);
    await expect(value.enqueue("test", { ...descriptor, filename: "../bad.pkg" })).rejects.toBeInstanceOf(DownloadError);
    await expect(value.enqueue("test", { ...descriptor, sha256: "bad" })).rejects.toThrow("SHA-256");
    await expect(value.enqueue("test", { ...descriptor, size_bytes: 0 })).rejects.toThrow("size");
  });

  it("rejects unapproved hosts, credentials, and non-default ports", async () => {
    const { value } = await manager(fetch);
    await expect(value.enqueue("test", { ...descriptor, url: "https://evil.invalid/game.pkg" })).rejects.toThrow("not approved");
    await expect(value.enqueue("test", { ...descriptor, url: "https://user:secret@cdn.test.invalid/game.pkg" })).rejects.toThrow("not approved");
    await expect(value.enqueue("test", { ...descriptor, url: "https://cdn.test.invalid:8443/game.pkg" })).rejects.toThrow("not approved");
  });

  it("rejects a duplicate active package destination", async () => {
    const { value } = await manager(fetch);
    await value.enqueue("test", descriptor);
    await expect(value.enqueue("other", descriptor)).rejects.toThrow("already queued");
  });

  it("fails preflight on insufficient storage", async () => {
    const low: IStorageService = { availableBytes: async () => 0, reserve: async () => false };
    const { value } = await manager(fetch, low);
    await value.enqueue("test", descriptor);
    await value.runPending();
    expect(value.list()[0]).toMatchObject({ status: "failed", errorCode: "INSUFFICIENT_STORAGE" });
  });

  it("removes a completed file after hash mismatch", async () => {
    const { value } = await manager(async () => new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }));
    await value.enqueue("test", { ...descriptor, sha256: "f".repeat(64) });
    await value.runPending();
    expect(value.list()[0]).toMatchObject({ status: "failed", errorCode: "HASH_MISMATCH" });
  });

  it("rejects redirect loops", async () => {
    const { value } = await manager(async () => new Response(null, { status: 302, headers: { location: descriptor.url } }));
    await value.enqueue("test", descriptor);
    await value.runPending();
    expect(value.list()[0]).toMatchObject({ status: "failed", errorCode: "REDIRECT_LIMIT" });
  });

  it("resumes only from an exact validated range", async () => {
    let range = "";
    const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      range = new Headers(init?.headers).get("range") ?? "";
      return new Response(bytes.subarray(10), {
        status: 206,
        headers: {
          "content-length": String(bytes.length - 10),
          "content-range": `bytes 10-${bytes.length - 1}/${bytes.length}`,
        },
      });
    }) as typeof fetch;
    const { value } = await manager(fetchImpl);
    const record = await value.enqueue("test", descriptor);
    await writeFile(`${record.destination}.part`, bytes.subarray(0, 10));
    await value.runPending();
    expect(range).toBe("bytes=10-");
    expect(value.list()[0]?.status).toBe("ready");
  });

  it("rejects a mismatched Content-Range", async () => {
    const fetchImpl = (async () => new Response(bytes.subarray(10), {
      status: 206,
      headers: {
        "content-length": String(bytes.length - 10),
        "content-range": `bytes 11-${bytes.length - 1}/${bytes.length}`,
      },
    })) as typeof fetch;
    const { value } = await manager(fetchImpl);
    const record = await value.enqueue("test", descriptor);
    await writeFile(`${record.destination}.part`, bytes.subarray(0, 10));
    await value.runPending();
    expect(value.list()[0]).toMatchObject({ status: "failed", errorCode: "RANGE_REJECTED" });
  });

  it("safely restarts when a server ignores Range", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    }) as typeof fetch;
    const { value } = await manager(fetchImpl);
    const record = await value.enqueue("test", descriptor);
    await writeFile(`${record.destination}.part`, bytes.subarray(0, 5));
    await value.runPending();
    expect(calls).toBe(2);
    expect(value.list()[0]?.status).toBe("ready");
  });

  it("rejects missing or incorrect content length", async () => {
    const incorrect = await manager(async () => new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length + 1) } }));
    await incorrect.value.enqueue("test", descriptor);
    await incorrect.value.runPending();
    expect(incorrect.value.list()[0]).toMatchObject({ status: "failed", errorCode: "CONTENT_LENGTH_MISMATCH" });

    const missing = await manager(async () => new Response(bytes, { status: 200 }));
    await missing.value.enqueue("test", descriptor);
    await missing.value.runPending();
    expect(missing.value.list()[0]).toMatchObject({ status: "failed", errorCode: "CONTENT_LENGTH_MISMATCH" });
  });

  it("rejects expired package URLs", async () => {
    const { value } = await manager(fetch);
    await expect(value.enqueue("test", { ...descriptor, expires_at: "2020-01-01T00:00:00Z" })).rejects.toThrow("expired");
  });

  it("retries an interrupted connection with exponential backoff", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    }) as typeof fetch;
    const { value } = await manager(fetchImpl, storage, { retryLimit: 2, backoffBaseMs: 1 });
    await value.enqueue("test", descriptor);
    await value.runPending();
    expect(value.list()[0]).toMatchObject({ status: "ready", attempts: 2 });
  });

  it("reports timeout after the configured inactivity retry limit", async () => {
    const fetchImpl = ((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;
    const { value } = await manager(fetchImpl, storage, { timeoutMs: 5, retryLimit: 1 });
    await value.enqueue("test", descriptor);
    await value.runPending();
    expect(value.list()[0]).toMatchObject({ status: "failed", errorCode: "NETWORK_TIMEOUT", attempts: 1 });
  });

  it("resets the inactivity timeout while bytes continue arriving", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let offset = 0;
        const interval = setInterval(() => {
          const next = Math.min(bytes.length, offset + 4);
          controller.enqueue(bytes.subarray(offset, next));
          offset = next;
          if (offset === bytes.length) {
            clearInterval(interval);
            controller.close();
          }
        }, 8);
      },
    });
    const { value } = await manager(
      async () => new Response(stream, { status: 200, headers: { "content-length": String(bytes.length) } }),
      storage,
      { timeoutMs: 20, retryLimit: 1 },
    );
    await value.enqueue("test", descriptor);
    await value.runPending();
    expect(value.list()[0]).toMatchObject({ status: "ready", attempts: 1 });
  });
});
