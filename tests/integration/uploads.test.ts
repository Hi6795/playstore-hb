import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  MemoryMultipartStorage,
  MemoryUploadRepository,
  MultipartUploadService,
  UploadError,
  type UploadActor,
} from "../../apps/catalog-api/src/uploads.js";

const owner: UploadActor = { subject: "submitter-a", role: "submitter" };
const stranger: UploadActor = { subject: "submitter-b", role: "submitter" };
const administrator: UploadActor = { subject: "admin", role: "administrator" };
const fiveMiB = 5 * 1024 * 1024;

function fixture(now: () => Date = () => new Date("2026-07-24T20:00:00.000Z")) {
  const repository = new MemoryUploadRepository();
  repository.setSubmissionOwner("submission-1", owner.subject);
  const storage = new MemoryMultipartStorage();
  const service = new MultipartUploadService(
    repository,
    storage,
    { packagePartSizeBytes: fiveMiB },
    now,
  );
  return { repository, storage, service };
}

describe("multipart upload service", () => {
  it("creates a private server-controlled upload and short-lived part URLs", async () => {
    const { service } = fixture();
    const upload = await service.initiate({
      submissionId: "submission-1",
      kind: "package",
      filename: "Authorized Homebrew.pkg",
      contentType: "application/octet-stream",
      sizeBytes: fiveMiB + 3,
    }, owner);
    expect(upload).toMatchObject({
      ownerSubject: owner.subject,
      bucket: "playstore-hb-quarantine",
      status: "initiated",
      maximumParallelParts: 4,
    });
    expect(upload.objectKey).toMatch(/^quarantine\/submissions\/submission-1\/pkg\/[a-f0-9-]+\.pkg$/);
    expect(upload.objectKey).not.toContain(upload.originalFilename);

    const signed = await service.presignParts(upload.id, [1, 2], owner);
    expect(signed).toHaveLength(2);
    expect(signed.every((part) => part.url.startsWith("https://uploads.test.invalid/"))).toBe(true);
    expect(Date.parse(signed[0]!.expiresAt) - Date.parse(upload.createdAt)).toBe(15 * 60 * 1000);
    expect((await service.get(upload.id, owner)).status).toBe("uploading");
  });

  it("resumes after a service restart and completes out-of-order uploaded parts", async () => {
    const { repository, storage, service } = fixture();
    const upload = await service.initiate({
      submissionId: "submission-1",
      kind: "package",
      filename: "game.pkg",
      contentType: "application/octet-stream",
      sizeBytes: fiveMiB + 3,
    }, owner);
    const second = await storage.putPart(upload.providerUploadId, 2, Buffer.from("end"));
    const firstBytes = Buffer.alloc(fiveMiB, 7);
    const first = await storage.putPart(upload.providerUploadId, 1, firstBytes);

    const restarted = new MultipartUploadService(
      repository,
      storage,
      { packagePartSizeBytes: fiveMiB },
      () => new Date("2026-07-24T20:05:00.000Z"),
    );
    expect(await restarted.listParts(upload.id, owner)).toEqual([first, second]);
    const completed = await restarted.complete(upload.id, [
      { partNumber: 2, etag: second.etag },
      { partNumber: 1, etag: first.etag },
    ], owner);
    expect(completed).toMatchObject({
      status: "validation_pending",
      completedSizeBytes: fiveMiB + 3,
    });
    const completedObject = storage.object(upload.bucket, upload.objectKey);
    expect(completedObject?.length).toBe(fiveMiB + 3);
    expect(completedObject?.equals(Buffer.concat([firstBytes, Buffer.from("end")]))).toBe(true);
    expect(repository.validationQueue).toEqual([upload.id]);

    const replay = await restarted.complete(upload.id, [
      { partNumber: 1, etag: first.etag },
      { partNumber: 2, etag: second.etag },
    ], owner);
    expect(replay.completionFingerprint).toBe(completed.completionFingerprint);
    expect(repository.validationQueue).toEqual([upload.id]);
  });

  it("rejects missing, duplicate, and mismatched completion parts", async () => {
    const { service, storage } = fixture();
    const upload = await service.initiate({
      submissionId: "submission-1",
      kind: "package",
      filename: "game.pkg",
      contentType: "application/octet-stream",
      sizeBytes: fiveMiB + 3,
    }, owner);
    const first = await storage.putPart(upload.providerUploadId, 1, Buffer.alloc(fiveMiB));
    await expect(service.complete(upload.id, [{ partNumber: 1, etag: first.etag }], owner)).rejects.toMatchObject({ code: "PART_MISMATCH" });
    await expect(service.complete(upload.id, [
      { partNumber: 1, etag: first.etag },
      { partNumber: 1, etag: first.etag },
    ], owner)).rejects.toMatchObject({ code: "PART_MISMATCH" });
    await expect(service.complete(upload.id, [
      { partNumber: 1, etag: "different" },
      { partNumber: 2, etag: "missing" },
    ], owner)).rejects.toBeInstanceOf(UploadError);
  });

  it("enforces ownership while allowing explicit administrator recovery", async () => {
    const { service } = fixture();
    const upload = await service.initiate({
      submissionId: "submission-1",
      kind: "package",
      filename: "game.pkg",
      contentType: "application/octet-stream",
      sizeBytes: 100,
    }, owner);
    await expect(service.get(upload.id, stranger)).rejects.toMatchObject({ code: "UPLOAD_FORBIDDEN", statusCode: 403 });
    expect((await service.get(upload.id, administrator)).id).toBe(upload.id);
    await expect(service.initiate({
      submissionId: "submission-1",
      kind: "package",
      filename: "other.pkg",
      contentType: "application/octet-stream",
      sizeBytes: 100,
    }, stranger)).rejects.toMatchObject({ code: "UPLOAD_FORBIDDEN" });
  });

  it("enforces active package quotas", async () => {
    const { repository, service } = fixture();
    for (let index = 1; index <= 4; index += 1) repository.setSubmissionOwner(`quota-${index}`, owner.subject);
    for (let index = 1; index <= 3; index += 1) {
      await service.initiate({
        submissionId: `quota-${index}`,
        kind: "package",
        filename: `game-${index}.pkg`,
        contentType: "application/octet-stream",
        sizeBytes: 100,
      }, owner);
    }
    await expect(service.initiate({
      submissionId: "quota-4",
      kind: "package",
      filename: "game-4.pkg",
      contentType: "application/octet-stream",
      sizeBytes: 100,
    }, owner)).rejects.toMatchObject({ code: "UPLOAD_QUOTA_EXCEEDED", statusCode: 429 });
  });

  it("validates filename, type, size, and presign concurrency", async () => {
    const { service } = fixture();
    await expect(service.initiate({
      submissionId: "submission-1",
      kind: "package",
      filename: "../game.pkg",
      contentType: "application/octet-stream",
      sizeBytes: 100,
    }, owner)).rejects.toMatchObject({ code: "INVALID_UPLOAD" });
    await expect(service.initiate({
      submissionId: "submission-1",
      kind: "package",
      filename: "game.pkg",
      contentType: "text/plain",
      sizeBytes: 100,
    }, owner)).rejects.toMatchObject({ code: "INVALID_UPLOAD" });
    await expect(service.initiate({
      submissionId: "submission-1",
      kind: "package",
      filename: "game.pkg",
      contentType: "application/octet-stream",
      sizeBytes: 50 * 1024 ** 3 + 1,
    }, owner)).rejects.toMatchObject({ code: "INVALID_UPLOAD" });

    const upload = await service.initiate({
      submissionId: "submission-1",
      kind: "cover",
      filename: "cover.png",
      contentType: "image/png",
      sizeBytes: 100,
    }, owner);
    await expect(service.presignParts(upload.id, [1, 2, 3, 4, 5], owner)).rejects.toMatchObject({ code: "INVALID_UPLOAD" });
  });

  it("expires abandoned sessions and aborts their multipart state", async () => {
    let current = new Date("2026-07-24T20:00:00.000Z");
    const { service } = fixture(() => current);
    const upload = await service.initiate({
      submissionId: "submission-1",
      kind: "package",
      filename: "game.pkg",
      contentType: "application/octet-stream",
      sizeBytes: 100,
    }, owner);
    current = new Date("2026-07-25T20:00:01.000Z");
    await expect(service.presignParts(upload.id, [1], owner)).rejects.toMatchObject({ code: "UPLOAD_EXPIRED", statusCode: 410 });
    expect(await service.cleanupExpired()).toBe(1);
    expect((await service.get(upload.id, owner)).status).toBe("expired");
  });

  it("aborts and deletes an unfinished upload", async () => {
    const { service } = fixture();
    const upload = await service.initiate({
      submissionId: "submission-1",
      kind: "package",
      filename: "game.pkg",
      contentType: "application/octet-stream",
      sizeBytes: 100,
    }, owner);
    expect((await service.abort(upload.id, owner)).status).toBe("aborted");
    await service.delete(upload.id, owner);
    expect((await service.get(upload.id, owner)).status).toBe("deleted");
  });
});
