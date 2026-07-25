import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PlaystoreApi,
  UploadedPart,
  UploadView
} from "../../apps/admin-web/src/api.js";
import { MultipartUploadManager } from "../../apps/admin-web/src/multipart.js";

const submissionId = "11111111-1111-4111-8111-111111111111";
const uploadId = "22222222-2222-4222-8222-222222222222";

function upload(status: string): UploadView {
  return {
    id: uploadId,
    submissionId,
    fileId: "33333333-3333-4333-8333-333333333333",
    kind: "package",
    filename: "release.pkg",
    declaredContentType: "application/octet-stream",
    expectedSizeBytes: 7,
    partSizeBytes: 5 * 1024 * 1024,
    maximumParallelParts: 4,
    status,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    expiresAt: "2026-07-26T00:00:00.000Z",
    validationAttempts: 0,
    ...(status === "validation_pending"
      ? {
          completedAt: "2026-07-25T00:01:00.000Z",
          completedSizeBytes: 7
        }
      : {})
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    }
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage()
  });
  vi.restoreAllMocks();
});

describe("admin multipart upload manager", () => {
  it("keeps an initiated upload active, sends the missing part, and completes it", async () => {
    const parts: UploadedPart[] = [];
    const presignParts = vi.fn(async () => [
      {
        partNumber: 1,
        url: "https://uploads.example.invalid/part-1",
        expiresAt: "2026-07-25T00:15:00.000Z",
        requiredHeaders: {}
      }
    ]);
    const completeUpload = vi.fn(async () => upload("validation_pending"));
    const api = {
      initiateUpload: vi.fn(async () => upload("initiated")),
      upload: vi.fn(async () => upload("initiated")),
      uploadedParts: vi.fn(async () => structuredClone(parts)),
      presignParts,
      completeUpload
    } as unknown as PlaystoreApi;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("PUT");
        parts.push({
          partNumber: 1,
          etag: '"part-1"',
          sizeBytes: 7,
          uploadedAt: "2026-07-25T00:00:30.000Z"
        });
        return new Response(null, {
          status: 200,
          headers: { etag: '"part-1"' }
        });
      })
    );

    const snapshots: string[][] = [];
    const manager = new MultipartUploadManager(api, (values) => {
      snapshots.push(values.map((value) => value.status));
    });
    const result = await manager.start(
      submissionId,
      "package",
      new File(["1234567"], "release.pkg", {
        type: "application/octet-stream",
        lastModified: 1
      })
    );

    expect(presignParts).toHaveBeenCalledWith(uploadId, [1]);
    expect(completeUpload).toHaveBeenCalledWith(uploadId, [
      { partNumber: 1, etag: '"part-1"' }
    ]);
    expect(result).toMatchObject({
      status: "validation_pending",
      completedBytes: 7
    });
    expect(snapshots).toContainEqual(["uploading"]);
    expect(snapshots.at(-1)).toEqual(["validation_pending"]);
  });

  it("fails closed when storage does not expose the multipart ETag", async () => {
    const api = {
      initiateUpload: vi.fn(async () => upload("initiated")),
      upload: vi.fn(async () => upload("initiated")),
      uploadedParts: vi.fn(async () => []),
      presignParts: vi.fn(async () => [
        {
          partNumber: 1,
          url: "https://uploads.example.invalid/part-1",
          expiresAt: "2026-07-25T00:15:00.000Z",
          requiredHeaders: {}
        }
      ]),
      completeUpload: vi.fn()
    } as unknown as PlaystoreApi;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 }))
    );

    const manager = new MultipartUploadManager(api, () => undefined);
    const result = await manager.start(
      submissionId,
      "package",
      new File(["1234567"], "release.pkg")
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Storage did not expose the ETag header");
    expect(api.completeUpload).not.toHaveBeenCalled();
  });
});
