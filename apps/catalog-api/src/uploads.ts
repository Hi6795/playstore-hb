import { createHash, randomUUID } from "node:crypto";

export type UploadRole = "submitter" | "reviewer" | "hardware_tester" | "publisher" | "administrator";
export type UploadKind =
  | "package"
  | "cover"
  | "background"
  | "icon"
  | "screenshot"
  | "license"
  | "redistribution_evidence"
  | "third_party_notice";
export type UploadStatus =
  | "initiated"
  | "uploading"
  | "uploaded"
  | "validation_pending"
  | "validating"
  | "validated"
  | "validation_failed"
  | "aborting"
  | "aborted"
  | "expired"
  | "deleted";

export interface UploadActor {
  subject: string;
  role: UploadRole;
  roles?: UploadRole[];
}

export interface UploadSession {
  id: string;
  submissionId: string;
  ownerSubject: string;
  fileId: string;
  kind: UploadKind;
  originalFilename: string;
  safeFilename: string;
  declaredContentType: string;
  expectedSizeBytes: number;
  partSizeBytes: number;
  maximumParallelParts: number;
  bucket: string;
  objectKey: string;
  providerUploadId: string;
  status: UploadStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt?: string;
  completedSizeBytes?: number;
  completionFingerprint?: string;
  validationAttempts: number;
}

export interface UploadPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface PresignedUploadPart {
  partNumber: number;
  url: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}

export interface MultipartStorage {
  initiate(input: {
    bucket: string;
    objectKey: string;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<{ providerUploadId: string }>;
  presignPart(input: {
    bucket: string;
    objectKey: string;
    providerUploadId: string;
    partNumber: number;
    expiresInSeconds: number;
  }): Promise<{ url: string; requiredHeaders?: Record<string, string> }>;
  listParts(input: {
    bucket: string;
    objectKey: string;
    providerUploadId: string;
  }): Promise<UploadPart[]>;
  complete(input: {
    bucket: string;
    objectKey: string;
    providerUploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void>;
  abort(input: {
    bucket: string;
    objectKey: string;
    providerUploadId: string;
  }): Promise<void>;
  headObject(input: {
    bucket: string;
    objectKey: string;
  }): Promise<{ sizeBytes: number; etag?: string }>;
  deleteObject(input: {
    bucket: string;
    objectKey: string;
  }): Promise<void>;
}

export interface UploadRepository {
  create(session: UploadSession): Promise<UploadSession>;
  get(id: string): Promise<UploadSession | null>;
  update(id: string, update: (session: UploadSession) => UploadSession): Promise<UploadSession>;
  countActive(ownerSubject: string, kind: UploadKind): Promise<number>;
  getSubmissionOwner(submissionId: string): Promise<string | null>;
  saveParts(uploadId: string, parts: UploadPart[]): Promise<void>;
  listParts(uploadId: string): Promise<UploadPart[]>;
  enqueueValidation(uploadId: string): Promise<void>;
  listExpired(before: Date, limit: number): Promise<UploadSession[]>;
}

export interface UploadPolicy {
  quarantineBucket: string;
  packagePartSizeBytes: number;
  maximumParallelParts: number;
  presignedUrlLifetimeSeconds: number;
  abandonedUploadHours: number;
  maximumPackageSizeBytes: number;
  maximumMediaSizeBytes: number;
  maximumEvidenceSizeBytes: number;
  maximumActivePackageUploads: number;
}

export const DEFAULT_UPLOAD_POLICY: UploadPolicy = {
  quarantineBucket: "playstore-hb-quarantine",
  packagePartSizeBytes: 64 * 1024 * 1024,
  maximumParallelParts: 4,
  presignedUrlLifetimeSeconds: 15 * 60,
  abandonedUploadHours: 24,
  maximumPackageSizeBytes: 50 * 1024 ** 3,
  maximumMediaSizeBytes: 512 * 1024 ** 2,
  maximumEvidenceSizeBytes: 100 * 1024 ** 2,
  maximumActivePackageUploads: 3,
};

export type UploadErrorCode =
  | "UPLOAD_NOT_FOUND"
  | "UPLOAD_FORBIDDEN"
  | "INVALID_UPLOAD"
  | "INVALID_UPLOAD_STATE"
  | "UPLOAD_EXPIRED"
  | "UPLOAD_QUOTA_EXCEEDED"
  | "PART_MISMATCH"
  | "OBJECT_SIZE_MISMATCH";

export class UploadError extends Error {
  constructor(
    public readonly code: UploadErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

const imageKinds = new Set<UploadKind>(["cover", "background", "icon", "screenshot"]);
const evidenceKinds = new Set<UploadKind>(["license", "redistribution_evidence", "third_party_notice"]);
const activeStatuses = new Set<UploadStatus>(["initiated", "uploading", "uploaded", "validation_pending", "validating"]);
const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const allowedEvidenceTypes = new Set(["application/pdf", "text/plain", "text/markdown", "application/octet-stream"]);
const unsafeUnicode = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

function safeFilename(value: string, kind: UploadKind): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length < 1 ||
    normalized.length > 255 ||
    unsafeUnicode.test(normalized) ||
    /[\\/]/.test(normalized) ||
    normalized.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(normalized)
  ) {
    throw new UploadError("INVALID_UPLOAD", "The filename is unsafe.", 400);
  }
  const extension = normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".")).toLowerCase() : "";
  if (kind === "package" && extension !== ".pkg") throw new UploadError("INVALID_UPLOAD", "A package upload must use a .pkg filename.", 400);
  if (imageKinds.has(kind) && ![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) throw new UploadError("INVALID_UPLOAD", "Artwork must use PNG, JPEG, or WebP.", 400);
  if (evidenceKinds.has(kind) && ![".pdf", ".txt", ".md", ".bin"].includes(extension)) throw new UploadError("INVALID_UPLOAD", "Evidence must use PDF, text, Markdown, or binary format.", 400);
  return normalized.replaceAll(" ", "-");
}

function validateContentType(kind: UploadKind, contentType: string): void {
  if (kind === "package" && contentType !== "application/octet-stream") throw new UploadError("INVALID_UPLOAD", "Package content type must be application/octet-stream.", 400);
  if (imageKinds.has(kind) && !allowedImageTypes.has(contentType)) throw new UploadError("INVALID_UPLOAD", "Artwork content type is not supported.", 400);
  if (evidenceKinds.has(kind) && !allowedEvidenceTypes.has(contentType)) throw new UploadError("INVALID_UPLOAD", "Evidence content type is not supported.", 400);
}

function extensionFor(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index < 0 ? ".bin" : filename.slice(index).toLowerCase();
}

function maximumSize(policy: UploadPolicy, kind: UploadKind): number {
  if (kind === "package") return policy.maximumPackageSizeBytes;
  if (imageKinds.has(kind)) return policy.maximumMediaSizeBytes;
  return policy.maximumEvidenceSizeBytes;
}

function normalizeEtag(value: string): string {
  const etag = value.trim();
  if (etag.length < 1 || etag.length > 200 || /[\u0000-\u001f\u007f]/u.test(etag)) throw new UploadError("INVALID_UPLOAD", "A part ETag is invalid.", 400);
  return etag;
}

function completionFingerprint(parts: Array<{ partNumber: number; etag: string }>): string {
  return createHash("sha256")
    .update(JSON.stringify(parts.map((part) => [part.partNumber, normalizeEtag(part.etag)])))
    .digest("hex");
}

export class MultipartUploadService {
  private readonly policy: UploadPolicy;

  constructor(
    private readonly repository: UploadRepository,
    private readonly storage: MultipartStorage,
    policy: Partial<UploadPolicy> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.policy = { ...DEFAULT_UPLOAD_POLICY, ...policy };
    if (this.policy.packagePartSizeBytes < 5 * 1024 * 1024) throw new Error("Multipart part size must be at least 5 MiB");
    if (this.policy.maximumParallelParts < 1 || this.policy.maximumParallelParts > 4) throw new Error("Maximum parallel parts must be between 1 and 4");
    if (this.policy.presignedUrlLifetimeSeconds < 60 || this.policy.presignedUrlLifetimeSeconds > 15 * 60) throw new Error("Presigned URL lifetime must be between 60 and 900 seconds");
  }

  async initiate(input: {
    submissionId: string;
    kind: UploadKind;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }, actor: UploadActor): Promise<UploadSession> {
    await this.assertSubmissionAccess(input.submissionId, actor);
    const filename = safeFilename(input.filename, input.kind);
    validateContentType(input.kind, input.contentType);
    const limit = maximumSize(this.policy, input.kind);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > limit) throw new UploadError("INVALID_UPLOAD", `Upload size must be between 1 and ${limit} bytes.`, 400);
    if (input.kind === "package" && await this.repository.countActive(actor.subject, "package") >= this.policy.maximumActivePackageUploads) throw new UploadError("UPLOAD_QUOTA_EXCEEDED", "The active package upload quota has been reached.", 429);

    const partSizeBytes = this.policy.packagePartSizeBytes;
    const partCount = Math.ceil(input.sizeBytes / partSizeBytes);
    if (partCount > 10_000) throw new UploadError("INVALID_UPLOAD", "The upload requires too many parts.", 400);
    const id = randomUUID();
    const fileId = randomUUID();
    const prefix = input.kind === "package" ? "pkg" : imageKinds.has(input.kind) ? "media" : "evidence";
    const objectKey = `quarantine/submissions/${input.submissionId}/${prefix}/${fileId}${extensionFor(filename)}`;
    const initiated = await this.storage.initiate({
      bucket: this.policy.quarantineBucket,
      objectKey,
      contentType: input.contentType,
      metadata: {
        "submission-id": input.submissionId,
        "file-id": fileId,
        "upload-kind": input.kind,
      },
    });
    const createdAt = this.now();
    const session: UploadSession = {
      id,
      submissionId: input.submissionId,
      ownerSubject: actor.subject,
      fileId,
      kind: input.kind,
      originalFilename: input.filename,
      safeFilename: filename,
      declaredContentType: input.contentType,
      expectedSizeBytes: input.sizeBytes,
      partSizeBytes,
      maximumParallelParts: this.policy.maximumParallelParts,
      bucket: this.policy.quarantineBucket,
      objectKey,
      providerUploadId: initiated.providerUploadId,
      status: "initiated",
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.policy.abandonedUploadHours * 60 * 60 * 1000).toISOString(),
      validationAttempts: 0,
    };
    try {
      return await this.repository.create(session);
    } catch (error) {
      await this.storage.abort({
        bucket: session.bucket,
        objectKey: session.objectKey,
        providerUploadId: session.providerUploadId,
      }).catch(() => undefined);
      throw error;
    }
  }

  async get(id: string, actor: UploadActor): Promise<UploadSession> {
    const session = await this.required(id);
    this.assertAccess(session, actor);
    return session;
  }

  async presignParts(id: string, partNumbers: number[], actor: UploadActor): Promise<PresignedUploadPart[]> {
    const session = await this.required(id);
    this.assertAccess(session, actor);
    this.assertNotExpired(session);
    if (!["initiated", "uploading"].includes(session.status)) throw new UploadError("INVALID_UPLOAD_STATE", "This upload no longer accepts parts.", 409);
    if (partNumbers.length < 1 || partNumbers.length > session.maximumParallelParts) throw new UploadError("INVALID_UPLOAD", `Request between 1 and ${session.maximumParallelParts} parts at a time.`, 400);
    const unique = [...new Set(partNumbers)].sort((left, right) => left - right);
    if (unique.length !== partNumbers.length) throw new UploadError("INVALID_UPLOAD", "Part numbers must be unique.", 400);
    const maximumPart = Math.ceil(session.expectedSizeBytes / session.partSizeBytes);
    if (unique.some((partNumber) => !Number.isInteger(partNumber) || partNumber < 1 || partNumber > maximumPart)) throw new UploadError("INVALID_UPLOAD", "A part number is outside the upload range.", 400);
    const expiresAt = new Date(this.now().getTime() + this.policy.presignedUrlLifetimeSeconds * 1000).toISOString();
    const results = await Promise.all(unique.map(async (partNumber) => {
      const signed = await this.storage.presignPart({
        bucket: session.bucket,
        objectKey: session.objectKey,
        providerUploadId: session.providerUploadId,
        partNumber,
        expiresInSeconds: this.policy.presignedUrlLifetimeSeconds,
      });
      const url = new URL(signed.url);
      if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("Storage returned a non-HTTPS presigned URL");
      return {
        partNumber,
        url: url.toString(),
        expiresAt,
        requiredHeaders: signed.requiredHeaders ?? {},
      };
    }));
    await this.repository.update(session.id, (current) => ({
      ...current,
      status: "uploading",
      updatedAt: this.now().toISOString(),
    }));
    return results;
  }

  async listParts(id: string, actor: UploadActor): Promise<UploadPart[]> {
    const session = await this.required(id);
    this.assertAccess(session, actor);
    if (["aborted", "expired", "deleted"].includes(session.status)) return this.repository.listParts(id);
    const parts = (await this.storage.listParts({
      bucket: session.bucket,
      objectKey: session.objectKey,
      providerUploadId: session.providerUploadId,
    })).sort((left, right) => left.partNumber - right.partNumber);
    await this.repository.saveParts(id, parts);
    return parts;
  }

  async complete(
    id: string,
    requestedParts: Array<{ partNumber: number; etag: string }>,
    actor: UploadActor,
  ): Promise<UploadSession> {
    const session = await this.required(id);
    this.assertAccess(session, actor);
    const sorted = requestedParts
      .map((part) => ({ partNumber: part.partNumber, etag: normalizeEtag(part.etag) }))
      .sort((left, right) => left.partNumber - right.partNumber);
    const fingerprint = completionFingerprint(sorted);
    if (["validation_pending", "validating", "validated", "validation_failed"].includes(session.status)) {
      if (session.completionFingerprint === fingerprint) {
        if (session.status === "validation_pending") await this.repository.enqueueValidation(id);
        return session;
      }
      throw new UploadError("INVALID_UPLOAD_STATE", "This upload was already completed with a different part list.", 409);
    }
    if (session.status !== "uploaded") this.assertNotExpired(session);
    if (!["initiated", "uploading", "uploaded"].includes(session.status)) throw new UploadError("INVALID_UPLOAD_STATE", "This upload cannot be completed.", 409);
    const expectedPartCount = Math.ceil(session.expectedSizeBytes / session.partSizeBytes);
    if (sorted.length !== expectedPartCount || sorted.some((part, index) => part.partNumber !== index + 1)) throw new UploadError("PART_MISMATCH", "The multipart completion list is not contiguous and complete.", 409);

    if (session.status === "uploaded" && session.completionFingerprint !== fingerprint) {
      throw new UploadError("INVALID_UPLOAD_STATE", "This upload was already completed with a different part list.", 409);
    }
    const stored = session.status === "uploaded"
      ? await this.repository.listParts(session.id)
      : await this.storage.listParts({
          bucket: session.bucket,
          objectKey: session.objectKey,
          providerUploadId: session.providerUploadId,
        });
    const storedByNumber = new Map(stored.map((part) => [part.partNumber, part]));
    for (const requested of sorted) {
      const actual = storedByNumber.get(requested.partNumber);
      const expectedSize = requested.partNumber === expectedPartCount
        ? session.expectedSizeBytes - session.partSizeBytes * (expectedPartCount - 1)
        : session.partSizeBytes;
      if (!actual || normalizeEtag(actual.etag) !== requested.etag || actual.sizeBytes !== expectedSize) throw new UploadError("PART_MISMATCH", `Part ${requested.partNumber} did not match storage.`, 409);
    }

    if (session.status !== "uploaded") await this.repository.saveParts(session.id, stored);
    await this.repository.update(session.id, (current) => {
      if (["validation_pending", "validating", "validated", "validation_failed"].includes(current.status)) {
        if (current.completionFingerprint !== fingerprint) throw new UploadError("INVALID_UPLOAD_STATE", "This upload was already completed with a different part list.", 409);
        return current;
      }
      if (current.status === "uploaded") {
        if (current.completionFingerprint !== fingerprint) throw new UploadError("INVALID_UPLOAD_STATE", "This upload was already completed with a different part list.", 409);
        return current;
      }
      if (!["initiated", "uploading"].includes(current.status)) throw new UploadError("INVALID_UPLOAD_STATE", "This upload cannot be completed.", 409);
      return {
        ...current,
        status: "uploaded",
        completionFingerprint: fingerprint,
        updatedAt: this.now().toISOString(),
      };
    });

    let object: { sizeBytes: number; etag?: string } | undefined;
    try {
      object = await this.storage.headObject({ bucket: session.bucket, objectKey: session.objectKey });
    } catch {
      try {
        await this.storage.complete({
          bucket: session.bucket,
          objectKey: session.objectKey,
          providerUploadId: session.providerUploadId,
          parts: sorted,
        });
      } catch (completionError) {
        try {
          object = await this.storage.headObject({ bucket: session.bucket, objectKey: session.objectKey });
        } catch {
          throw completionError;
        }
      }
      object ??= await this.storage.headObject({ bucket: session.bucket, objectKey: session.objectKey });
    }
    if (object.sizeBytes !== session.expectedSizeBytes) {
      await this.storage.deleteObject({ bucket: session.bucket, objectKey: session.objectKey }).catch(() => undefined);
      await this.repository.update(session.id, (current) => ({
        ...current,
        status: "validation_failed",
        updatedAt: this.now().toISOString(),
      }));
      throw new UploadError("OBJECT_SIZE_MISMATCH", "The completed object size did not match the upload declaration.", 409);
    }
    const completed = await this.repository.update(session.id, (current) => ({
      ...current,
      status: "validation_pending",
      completedAt: this.now().toISOString(),
      completedSizeBytes: object.sizeBytes,
      completionFingerprint: fingerprint,
      updatedAt: this.now().toISOString(),
    }));
    await this.repository.enqueueValidation(session.id);
    return completed;
  }

  async abort(id: string, actor: UploadActor): Promise<UploadSession> {
    const session = await this.required(id);
    this.assertAccess(session, actor);
    if (["aborted", "expired", "deleted"].includes(session.status)) return session;
    if (["validation_pending", "validation_failed", "validated", "validating"].includes(session.status)) throw new UploadError("INVALID_UPLOAD_STATE", "A completed object cannot be aborted.", 409);
    await this.repository.update(id, (current) => ({ ...current, status: "aborting", updatedAt: this.now().toISOString() }));
    try {
      await this.storage.abort({
        bucket: session.bucket,
        objectKey: session.objectKey,
        providerUploadId: session.providerUploadId,
      });
    } catch (error) {
      if (session.status !== "uploaded") throw error;
    }
    if (session.status === "uploaded") {
      await this.storage.deleteObject({ bucket: session.bucket, objectKey: session.objectKey }).catch(() => undefined);
    }
    return this.repository.update(id, (current) => ({ ...current, status: "aborted", updatedAt: this.now().toISOString() }));
  }

  async retryValidation(id: string, actor: UploadActor): Promise<UploadSession> {
    const session = await this.required(id);
    this.assertAccess(session, actor);
    if (session.status !== "validation_failed") throw new UploadError("INVALID_UPLOAD_STATE", "Only a failed validation can be retried.", 409);
    if (session.validationAttempts >= 20) throw new UploadError("INVALID_UPLOAD_STATE", "The validation retry limit has been reached.", 409);
    const updated = await this.repository.update(id, (current) => ({
      ...current,
      status: "validation_pending",
      validationAttempts: current.validationAttempts + 1,
      updatedAt: this.now().toISOString(),
    }));
    await this.repository.enqueueValidation(id);
    return updated;
  }

  async delete(id: string, actor: UploadActor): Promise<void> {
    const session = await this.required(id);
    this.assertAccess(session, actor);
    if (["validating", "validated"].includes(session.status)) throw new UploadError("INVALID_UPLOAD_STATE", "Validated submission files are removed through the submission workflow.", 409);
    if (["initiated", "uploading", "uploaded"].includes(session.status)) await this.abort(id, actor);
    await this.storage.deleteObject({ bucket: session.bucket, objectKey: session.objectKey }).catch(() => undefined);
    await this.repository.update(id, (current) => ({ ...current, status: "deleted", updatedAt: this.now().toISOString() }));
  }

  async cleanupExpired(limit = 100): Promise<number> {
    const expired = await this.repository.listExpired(this.now(), Math.max(1, Math.min(limit, 1000)));
    let cleaned = 0;
    for (const session of expired) {
      try {
        await this.storage.abort({
          bucket: session.bucket,
          objectKey: session.objectKey,
          providerUploadId: session.providerUploadId,
        });
        await this.repository.update(session.id, (current) => ({ ...current, status: "expired", updatedAt: this.now().toISOString() }));
        cleaned += 1;
      } catch {
        // A later cleanup pass retries storage failures without hiding them in state.
      }
    }
    return cleaned;
  }

  private async required(id: string): Promise<UploadSession> {
    const session = await this.repository.get(id);
    if (!session) throw new UploadError("UPLOAD_NOT_FOUND", "Upload session not found.", 404);
    return session;
  }

  private async assertSubmissionAccess(submissionId: string, actor: UploadActor): Promise<void> {
    const owner = await this.repository.getSubmissionOwner(submissionId);
    if (!owner) throw new UploadError("UPLOAD_NOT_FOUND", "Submission not found.", 404);
    if (owner !== actor.subject && !isAdministrator(actor)) throw new UploadError("UPLOAD_FORBIDDEN", "The submission belongs to another account.", 403);
  }

  private assertAccess(session: UploadSession, actor: UploadActor): void {
    if (session.ownerSubject !== actor.subject && !isAdministrator(actor)) throw new UploadError("UPLOAD_FORBIDDEN", "The upload belongs to another account.", 403);
  }

  private assertNotExpired(session: UploadSession): void {
    if (Date.parse(session.expiresAt) <= this.now().getTime()) throw new UploadError("UPLOAD_EXPIRED", "The upload session has expired.", 410);
  }
}

function isAdministrator(actor: UploadActor): boolean {
  return actor.role === "administrator" || actor.roles?.includes("administrator") === true;
}

export class MemoryUploadRepository implements UploadRepository {
  private readonly sessions = new Map<string, UploadSession>();
  private readonly parts = new Map<string, UploadPart[]>();
  private readonly owners = new Map<string, string>();
  readonly validationQueue: string[] = [];

  setSubmissionOwner(submissionId: string, ownerSubject: string): void {
    this.owners.set(submissionId, ownerSubject);
  }

  async create(session: UploadSession): Promise<UploadSession> {
    if (this.sessions.has(session.id)) throw new Error("Duplicate upload id");
    this.sessions.set(session.id, structuredClone(session));
    return structuredClone(session);
  }

  async get(id: string): Promise<UploadSession | null> {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : null;
  }

  async update(id: string, update: (session: UploadSession) => UploadSession): Promise<UploadSession> {
    const current = this.sessions.get(id);
    if (!current) throw new UploadError("UPLOAD_NOT_FOUND", "Upload session not found.", 404);
    const next = update(structuredClone(current));
    this.sessions.set(id, structuredClone(next));
    return structuredClone(next);
  }

  async countActive(ownerSubject: string, kind: UploadKind): Promise<number> {
    return [...this.sessions.values()].filter((session) =>
      session.ownerSubject === ownerSubject &&
      session.kind === kind &&
      activeStatuses.has(session.status)
    ).length;
  }

  async getSubmissionOwner(submissionId: string): Promise<string | null> {
    return this.owners.get(submissionId) ?? null;
  }

  async saveParts(uploadId: string, parts: UploadPart[]): Promise<void> {
    this.parts.set(uploadId, structuredClone(parts));
  }

  async listParts(uploadId: string): Promise<UploadPart[]> {
    return structuredClone(this.parts.get(uploadId) ?? []);
  }

  async enqueueValidation(uploadId: string): Promise<void> {
    if (!this.validationQueue.includes(uploadId)) this.validationQueue.push(uploadId);
  }

  async listExpired(before: Date, limit: number): Promise<UploadSession[]> {
    return [...this.sessions.values()]
      .filter((session) => ["initiated", "uploading"].includes(session.status) && Date.parse(session.expiresAt) <= before.getTime())
      .slice(0, limit)
      .map((session) => structuredClone(session));
  }
}

interface MemoryMultipart {
  bucket: string;
  objectKey: string;
  parts: Map<number, { bytes: Buffer; part: UploadPart }>;
  aborted: boolean;
}

export class MemoryMultipartStorage implements MultipartStorage {
  private readonly uploads = new Map<string, MemoryMultipart>();
  private readonly objects = new Map<string, Buffer>();

  async initiate(input: { bucket: string; objectKey: string }): Promise<{ providerUploadId: string }> {
    const providerUploadId = randomUUID();
    this.uploads.set(providerUploadId, {
      bucket: input.bucket,
      objectKey: input.objectKey,
      parts: new Map(),
      aborted: false,
    });
    return { providerUploadId };
  }

  async presignPart(input: { providerUploadId: string; partNumber: number }): Promise<{ url: string }> {
    this.required(input.providerUploadId);
    return { url: `https://uploads.test.invalid/${input.providerUploadId}/${input.partNumber}` };
  }

  async putPart(providerUploadId: string, partNumber: number, bytes: Buffer): Promise<UploadPart> {
    const upload = this.required(providerUploadId);
    if (upload.aborted) throw new Error("Upload aborted");
    const part: UploadPart = {
      partNumber,
      etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
      sizeBytes: bytes.length,
      uploadedAt: new Date().toISOString(),
    };
    upload.parts.set(partNumber, { bytes: Buffer.from(bytes), part });
    return structuredClone(part);
  }

  async listParts(input: { providerUploadId: string }): Promise<UploadPart[]> {
    return [...this.required(input.providerUploadId).parts.values()]
      .map((value) => structuredClone(value.part))
      .sort((left, right) => left.partNumber - right.partNumber);
  }

  async complete(input: {
    bucket: string;
    objectKey: string;
    providerUploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void> {
    const upload = this.required(input.providerUploadId);
    const buffers = input.parts.map((part) => {
      const stored = upload.parts.get(part.partNumber);
      if (!stored || stored.part.etag !== part.etag) throw new Error("Part mismatch");
      return stored.bytes;
    });
    this.objects.set(`${input.bucket}/${input.objectKey}`, Buffer.concat(buffers));
  }

  async abort(input: { providerUploadId: string }): Promise<void> {
    const upload = this.required(input.providerUploadId);
    upload.aborted = true;
    upload.parts.clear();
  }

  async headObject(input: { bucket: string; objectKey: string }): Promise<{ sizeBytes: number }> {
    const object = this.objects.get(`${input.bucket}/${input.objectKey}`);
    if (!object) throw new Error("Object not found");
    return { sizeBytes: object.length };
  }

  async deleteObject(input: { bucket: string; objectKey: string }): Promise<void> {
    this.objects.delete(`${input.bucket}/${input.objectKey}`);
  }

  object(bucket: string, objectKey: string): Buffer | null {
    const value = this.objects.get(`${bucket}/${objectKey}`);
    return value ? Buffer.from(value) : null;
  }

  private required(providerUploadId: string): MemoryMultipart {
    const upload = this.uploads.get(providerUploadId);
    if (!upload) throw new Error("Multipart upload not found");
    return upload;
  }
}
