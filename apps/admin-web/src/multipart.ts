import {
  ApiError,
  PlaystoreApi,
  type UploadKind,
  type UploadedPart,
  type UploadView
} from "./api.js";

export type BrowserUploadStatus =
  | "ready"
  | "uploading"
  | "paused"
  | "validation_pending"
  | "validating"
  | "validated"
  | "validation_failed"
  | "aborted"
  | "expired"
  | "failed";

export interface BrowserUpload {
  uploadId: string;
  submissionId: string;
  kind: UploadKind;
  filename: string;
  contentType: string;
  sizeBytes: number;
  lastModified: number;
  partSizeBytes: number;
  maximumParallelParts: number;
  completedBytes: number;
  status: BrowserUploadStatus;
  expiresAt: string;
  error?: string;
}

const storageKey = "playstorehb.admin.uploads.v1";

export class MultipartUploadManager {
  private readonly uploads = new Map<string, BrowserUpload>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly active = new Set<string>();

  constructor(
    private readonly api: PlaystoreApi,
    private readonly onChange: (uploads: BrowserUpload[]) => void
  ) {
    for (const upload of loadUploads()) this.uploads.set(upload.uploadId, upload);
    this.emit();
  }

  values(): BrowserUpload[] {
    return [...this.uploads.values()].sort((left, right) =>
      right.expiresAt.localeCompare(left.expiresAt)
    );
  }

  async refresh(): Promise<void> {
    await Promise.all(
      this.values().map(async (upload) => {
        try {
          const remote = await this.api.upload(upload.uploadId);
          const parts = await this.api.uploadedParts(upload.uploadId);
          this.applyRemote(upload, remote, parts);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            this.uploads.delete(upload.uploadId);
          } else {
            upload.error = message(error);
          }
        }
      })
    );
    this.emit();
  }

  async start(
    submissionId: string,
    kind: UploadKind,
    file: File
  ): Promise<BrowserUpload> {
    const remote = await this.api.initiateUpload(submissionId, {
      kind,
      filename: file.name,
      contentType: contentType(kind, file),
      sizeBytes: file.size
    });
    const upload: BrowserUpload = {
      uploadId: remote.id,
      submissionId,
      kind,
      filename: file.name,
      contentType: remote.declaredContentType,
      sizeBytes: remote.expectedSizeBytes,
      lastModified: file.lastModified,
      partSizeBytes: remote.partSizeBytes,
      maximumParallelParts: remote.maximumParallelParts,
      completedBytes: 0,
      status: "ready",
      expiresAt: remote.expiresAt
    };
    this.uploads.set(upload.uploadId, upload);
    this.emit();
    await this.resume(upload.uploadId, file);
    return upload;
  }

  async resume(uploadId: string, file: File): Promise<void> {
    const upload = this.required(uploadId);
    if (this.active.has(uploadId)) return;
    assertMatchingFile(upload, file);
    this.active.add(uploadId);
    upload.status = "uploading";
    delete upload.error;
    this.emit();
    try {
      const remote = await this.api.upload(uploadId);
      const uploaded = await this.api.uploadedParts(uploadId);
      this.applyRemote(upload, remote, uploaded);
      if (isTerminalRemoteStatus(remote.status)) return;
      upload.status = "uploading";
      this.emit();

      const byNumber = new Map(uploaded.map((part) => [part.partNumber, part]));
      const count = Math.ceil(file.size / upload.partSizeBytes);
      const pending = Array.from({ length: count }, (_value, index) => index + 1)
        .filter((partNumber) => !byNumber.has(partNumber));
      await this.uploadPendingParts(upload, file, pending, byNumber);
      if (uploadPaused(upload)) return;

      const completedParts = await this.api.uploadedParts(uploadId);
      if (completedParts.length !== count) {
        throw new Error("Storage did not report every expected upload part.");
      }
      const completed = await this.api.completeUpload(
        uploadId,
        completedParts.map((part) => ({
          partNumber: part.partNumber,
          etag: part.etag
        }))
      );
      this.applyRemote(upload, completed, completedParts);
    } catch (error) {
      if (!uploadPaused(upload)) {
        upload.status = "failed";
        upload.error = message(error);
      }
    } finally {
      this.active.delete(uploadId);
      this.controllers.delete(uploadId);
      this.emit();
    }
  }

  pause(uploadId: string): void {
    const upload = this.required(uploadId);
    upload.status = "paused";
    for (const controller of this.controllers.get(uploadId) ?? []) {
      controller.abort();
    }
    this.emit();
  }

  async cancel(uploadId: string): Promise<void> {
    this.pause(uploadId);
    const upload = this.required(uploadId);
    try {
      const remote = await this.api.abortUpload(uploadId);
      upload.status = normalizeRemoteStatus(remote.status);
      delete upload.error;
    } catch (error) {
      upload.status = "failed";
      upload.error = message(error);
    }
    this.emit();
  }

  async remove(uploadId: string): Promise<void> {
    this.pause(uploadId);
    await this.api.deleteUpload(uploadId);
    this.uploads.delete(uploadId);
    this.emit();
  }

  async retryValidation(uploadId: string): Promise<void> {
    const upload = this.required(uploadId);
    const remote = await this.api.retryValidation(uploadId);
    upload.status = normalizeRemoteStatus(remote.status);
    delete upload.error;
    this.emit();
  }

  private async uploadPendingParts(
    upload: BrowserUpload,
    file: File,
    pending: number[],
    completed: Map<number, UploadedPart>
  ): Promise<void> {
    const queue = [...pending];
    const workerCount = Math.min(upload.maximumParallelParts, queue.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0 && upload.status === "uploading") {
          const partNumber = queue.shift();
          if (partNumber === undefined) return;
          const uploaded = await this.uploadPartWithRetry(upload, file, partNumber);
          completed.set(partNumber, uploaded);
          upload.completedBytes = [...completed.values()].reduce(
            (sum, part) => sum + part.sizeBytes,
            0
          );
          this.emit();
        }
      })
    );
  }

  private async uploadPartWithRetry(
    upload: BrowserUpload,
    file: File,
    partNumber: number
  ): Promise<UploadedPart> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (upload.status !== "uploading") throw new Error("Upload paused.");
      const controller = new AbortController();
      const controllers = this.controllers.get(upload.uploadId) ?? new Set();
      controllers.add(controller);
      this.controllers.set(upload.uploadId, controllers);
      try {
        const [signed] = await this.api.presignParts(upload.uploadId, [partNumber]);
        if (!signed) throw new Error("The API did not return a signed part URL.");
        const start = (partNumber - 1) * upload.partSizeBytes;
        const end = Math.min(file.size, start + upload.partSizeBytes);
        const response = await fetch(signed.url, {
          method: "PUT",
          headers: signed.requiredHeaders,
          body: file.slice(start, end),
          signal: controller.signal,
          redirect: "error"
        });
        if (!response.ok) {
          throw new Error(`Storage rejected part ${partNumber} (${response.status}).`);
        }
        const etag = response.headers.get("etag");
        if (!etag) {
          throw new Error(
            "Storage did not expose the ETag header; quarantine CORS is incomplete."
          );
        }
        return {
          partNumber,
          etag,
          sizeBytes: end - start,
          uploadedAt: new Date().toISOString()
        };
      } catch (error) {
        lastError = error;
        if (uploadPaused(upload) || controller.signal.aborted) throw error;
        if (attempt < 3) await delay(500 * 2 ** (attempt - 1));
      } finally {
        controllers.delete(controller);
      }
    }
    throw lastError;
  }

  private applyRemote(
    upload: BrowserUpload,
    remote: UploadView,
    parts: UploadedPart[]
  ): void {
    upload.status = normalizeRemoteStatus(remote.status);
    upload.expiresAt = remote.expiresAt;
    upload.completedBytes = remote.completedSizeBytes ??
      parts.reduce((sum, part) => sum + part.sizeBytes, 0);
    delete upload.error;
    this.emit();
  }

  private required(uploadId: string): BrowserUpload {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error("Upload record not found.");
    return upload;
  }

  private emit(): void {
    const values = this.values();
    localStorage.setItem(storageKey, JSON.stringify(values));
    this.onChange(values);
  }
}

function loadUploads(): BrowserUpload[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(isBrowserUpload);
  } catch {
    return [];
  }
}

function isBrowserUpload(value: unknown): value is BrowserUpload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BrowserUpload>;
  return (
    typeof candidate.uploadId === "string" &&
    typeof candidate.submissionId === "string" &&
    typeof candidate.filename === "string" &&
    typeof candidate.sizeBytes === "number" &&
    typeof candidate.partSizeBytes === "number" &&
    typeof candidate.status === "string"
  );
}

function assertMatchingFile(upload: BrowserUpload, file: File): void {
  if (file.name !== upload.filename || file.size !== upload.sizeBytes) {
    throw new Error(
      `Select the same file (${upload.filename}, ${formatBytes(upload.sizeBytes)}) to resume.`
    );
  }
}

function contentType(kind: UploadKind, file: File): string {
  if (kind === "package") return "application/octet-stream";
  if (file.type) return file.type;
  if (file.name.toLowerCase().endsWith(".pdf")) return "application/pdf";
  if (file.name.toLowerCase().endsWith(".md")) return "text/markdown";
  if (file.name.toLowerCase().endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

function normalizeRemoteStatus(status: string): BrowserUploadStatus {
  if (
    status === "uploading" ||
    status === "validation_pending" ||
    status === "validating" ||
    status === "validated" ||
    status === "validation_failed" ||
    status === "aborted" ||
    status === "expired"
  ) {
    return status;
  }
  if (status === "initiated" || status === "uploaded") return "ready";
  if (status === "deleted") return "aborted";
  return "failed";
}

function isTerminalRemoteStatus(status: string): boolean {
  return [
    "validation_pending",
    "validating",
    "validated",
    "validation_failed",
    "aborted",
    "expired",
    "deleted"
  ].includes(status);
}

function message(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message}${error.requestId ? ` Request ${error.requestId}.` : ""}`;
  }
  return error instanceof Error ? error.message : "The upload failed.";
}

function uploadPaused(upload: BrowserUpload): boolean {
  return upload.status === "paused";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
