import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../../apps/catalog-api/src/app.js";
import {
  MemoryMultipartStorage,
  MemoryUploadRepository,
  MultipartUploadService
} from "../../apps/catalog-api/src/uploads.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function uploadApi() {
  const repository = new MemoryUploadRepository();
  const storage = new MemoryMultipartStorage();
  const submissionId = randomUUID();
  repository.setSubmissionOwner(submissionId, "alice");
  const service = new MultipartUploadService(repository, storage, {
    packagePartSizeBytes: 5 * 1024 * 1024
  });
  return { repository, storage, submissionId, service };
}

describe("multipart upload routes", () => {
  it("initiates, resumes, and completes a direct-to-storage upload", async () => {
    const setup = uploadApi();
    app = await createApi({
      tokens: {
        submit: { subject: "alice", role: "submitter" }
      },
      uploadService: setup.service
    });

    const initiated = await app.inject({
      method: "POST",
      url: `/v1/admin/submissions/${setup.submissionId}/uploads/initiate`,
      headers: { authorization: "Bearer submit" },
      payload: {
        kind: "package",
        filename: "homebrew.pkg",
        contentType: "application/octet-stream",
        sizeBytes: 7
      }
    });
    expect(initiated.statusCode).toBe(201);
    expect(initiated.json()).not.toHaveProperty("bucket");
    expect(initiated.json()).not.toHaveProperty("objectKey");
    expect(initiated.json()).not.toHaveProperty("providerUploadId");

    const uploadId = initiated.json().id as string;
    const presigned = await app.inject({
      method: "POST",
      url: `/v1/admin/uploads/${uploadId}/parts/presign`,
      headers: { authorization: "Bearer submit" },
      payload: { partNumbers: [1] }
    });
    expect(presigned.statusCode).toBe(200);
    expect(presigned.json().parts).toHaveLength(1);
    expect(presigned.json().parts[0].url).toMatch(/^https:/);

    const internal = await setup.repository.get(uploadId);
    expect(internal).not.toBeNull();
    const part = await setup.storage.putPart(
      internal!.providerUploadId,
      1,
      Buffer.from("1234567")
    );

    const resumed = await app.inject({
      method: "GET",
      url: `/v1/admin/uploads/${uploadId}/parts`,
      headers: { authorization: "Bearer submit" }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().parts).toEqual([expect.objectContaining({ partNumber: 1 })]);

    const completed = await app.inject({
      method: "POST",
      url: `/v1/admin/uploads/${uploadId}/complete`,
      headers: { authorization: "Bearer submit" },
      payload: { parts: [{ partNumber: 1, etag: part.etag }] }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      id: uploadId,
      status: "validation_pending",
      completedSizeBytes: 7
    });
    expect(setup.repository.validationQueue).toEqual([uploadId]);
  });

  it("rejects unauthenticated, wrong-role, and cross-owner access", async () => {
    const setup = uploadApi();
    app = await createApi({
      tokens: {
        submit: { subject: "alice", role: "submitter" },
        other: { subject: "mallory", role: "submitter" },
        review: { subject: "bob", role: "reviewer" }
      },
      uploadService: setup.service
    });
    const url = `/v1/admin/submissions/${setup.submissionId}/uploads/initiate`;
    const payload = {
      kind: "package",
      filename: "homebrew.pkg",
      contentType: "application/octet-stream",
      sizeBytes: 7
    };

    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: "Bearer review" },
          payload
        })
      ).statusCode
    ).toBe(403);
    const crossOwner = await app.inject({
      method: "POST",
      url,
      headers: { authorization: "Bearer other" },
      payload
    });
    expect(crossOwner.statusCode).toBe(403);
    expect(crossOwner.json().error.code).toBe("UPLOAD_FORBIDDEN");
  });
});
