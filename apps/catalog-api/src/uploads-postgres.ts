import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  UploadError,
  type UploadKind,
  type UploadPart,
  type UploadRepository,
  type UploadSession,
  type UploadStatus
} from "./uploads.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activeStatuses: UploadStatus[] = [
  "initiated",
  "uploading",
  "uploaded",
  "validation_pending",
  "validating"
];

interface UploadRow {
  id: string;
  submission_id: string;
  created_by: string;
  file_id: string;
  file_kind: UploadKind;
  original_filename: string;
  safe_filename: string;
  declared_content_type: string;
  expected_size_bytes: string;
  part_size_bytes: number;
  maximum_parallel_parts: number;
  storage_bucket: string;
  object_key: string;
  provider_upload_id: string;
  status: UploadStatus;
  completed_size_bytes: string | null;
  completion_fingerprint: string | null;
  validation_attempts: number;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  completed_at: Date | null;
}

export class PostgresUploadRepository implements UploadRepository {
  constructor(private readonly pool: Pool) {}

  async create(session: UploadSession): Promise<UploadSession> {
    const ownerId = requireActorUuid(session.ownerSubject);
    const result = await this.pool.query<UploadRow>(
      `INSERT INTO upload_sessions(
         id, submission_id, created_by, file_id, file_kind, original_filename,
         safe_filename, declared_content_type, expected_size_bytes, part_size_bytes,
         maximum_parallel_parts, storage_bucket, object_key, provider_upload_id,
         status, completion_fingerprint, validation_attempts, created_at, updated_at,
         expires_at, completed_at, completed_size_bytes
       ) VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
       )
       RETURNING *`,
      [
        session.id,
        session.submissionId,
        ownerId,
        session.fileId,
        session.kind,
        session.originalFilename,
        session.safeFilename,
        session.declaredContentType,
        session.expectedSizeBytes,
        session.partSizeBytes,
        session.maximumParallelParts,
        session.bucket,
        session.objectKey,
        session.providerUploadId,
        session.status,
        session.completionFingerprint ?? null,
        session.validationAttempts,
        session.createdAt,
        session.updatedAt,
        session.expiresAt,
        session.completedAt ?? null,
        session.completedSizeBytes ?? null
      ]
    );
    return fromRow(result.rows[0]!);
  }

  async get(id: string): Promise<UploadSession | null> {
    const result = await this.pool.query<UploadRow>(
      "SELECT * FROM upload_sessions WHERE id=$1 AND deleted_at IS NULL",
      [id]
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async update(
    id: string,
    update: (session: UploadSession) => UploadSession
  ): Promise<UploadSession> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<UploadRow>(
        "SELECT * FROM upload_sessions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [id]
      );
      if (!selected.rows[0]) {
        throw new UploadError("UPLOAD_NOT_FOUND", "Upload session not found.", 404);
      }
      const current = fromRow(selected.rows[0]);
      const next = update(structuredClone(current));
      assertImmutableIdentity(current, next);
      const result = await client.query<UploadRow>(
        `UPDATE upload_sessions
         SET status=$2,
             updated_at=$3,
             expires_at=$4,
             completed_at=$5,
             completed_size_bytes=$6,
             completion_fingerprint=$7,
             validation_attempts=$8,
             aborted_at=CASE WHEN $2='aborted' THEN $3 ELSE aborted_at END,
             deleted_at=CASE WHEN $2='deleted' THEN $3 ELSE deleted_at END
         WHERE id=$1
         RETURNING *`,
        [
          id,
          next.status,
          next.updatedAt,
          next.expiresAt,
          next.completedAt ?? null,
          next.completedSizeBytes ?? null,
          next.completionFingerprint ?? null,
          next.validationAttempts
        ]
      );
      await client.query("COMMIT");
      return fromRow(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async countActive(ownerSubject: string, kind: UploadKind): Promise<number> {
    const ownerId = requireActorUuid(ownerSubject);
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM upload_sessions
       WHERE created_by=$1
         AND file_kind=$2
         AND status=ANY($3::text[])
         AND deleted_at IS NULL`,
      [ownerId, kind, activeStatuses]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getSubmissionOwner(submissionId: string): Promise<string | null> {
    const result = await this.pool.query<{ owner_subject: string }>(
      `SELECT submitter_user_id::text AS owner_subject
       FROM game_submissions
       WHERE id=$1 AND deleted_at IS NULL`,
      [submissionId]
    );
    return result.rows[0]?.owner_subject ?? null;
  }

  async saveParts(uploadId: string, parts: UploadPart[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM upload_parts
         WHERE upload_id=$1
           AND NOT (part_number=ANY($2::integer[]))`,
        [uploadId, parts.map((part) => part.partNumber)]
      );
      for (const part of parts) {
        await client.query(
          `INSERT INTO upload_parts(upload_id,part_number,etag,size_bytes,uploaded_at)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(upload_id,part_number) DO UPDATE
           SET etag=EXCLUDED.etag,
               size_bytes=EXCLUDED.size_bytes,
               uploaded_at=EXCLUDED.uploaded_at`,
          [uploadId, part.partNumber, part.etag, part.sizeBytes, part.uploadedAt]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listParts(uploadId: string): Promise<UploadPart[]> {
    const result = await this.pool.query<{
      part_number: number;
      etag: string;
      size_bytes: string;
      uploaded_at: Date;
    }>(
      `SELECT part_number,etag,size_bytes,uploaded_at
       FROM upload_parts
       WHERE upload_id=$1
       ORDER BY part_number`,
      [uploadId]
    );
    return result.rows.map((row) => ({
      partNumber: row.part_number,
      etag: row.etag,
      sizeBytes: Number(row.size_bytes),
      uploadedAt: row.uploaded_at.toISOString()
    }));
  }

  async enqueueValidation(uploadId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const upload = await client.query<{
        submission_id: string;
        file_kind: UploadKind;
      }>(
        `SELECT submission_id,file_kind
         FROM upload_sessions
         WHERE id=$1 AND deleted_at IS NULL
         FOR UPDATE`,
        [uploadId]
      );
      const row = upload.rows[0];
      if (!row) throw new UploadError("UPLOAD_NOT_FOUND", "Upload session not found.", 404);
      const jobType = validationJobType(row.file_kind);
      await client.query(
        `INSERT INTO validation_jobs(id,submission_id,upload_id,job_type,status)
         VALUES($1,$2,$3,$4,'pending')
         ON CONFLICT(upload_id,job_type) WHERE upload_id IS NOT NULL
         DO UPDATE SET
           status='pending',
           scheduled_at=now(),
           started_at=NULL,
           completed_at=NULL,
           lease_owner=NULL,
           lease_expires_at=NULL,
           last_error_code=NULL,
           last_error_message=NULL
         WHERE validation_jobs.status IN ('failed','retryable','cancelled')`,
        [randomUUID(), row.submission_id, uploadId, jobType]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listExpired(before: Date, limit: number): Promise<UploadSession[]> {
    const result = await this.pool.query<UploadRow>(
      `SELECT *
       FROM upload_sessions
       WHERE status IN ('initiated','uploading')
         AND expires_at <= $1
         AND deleted_at IS NULL
       ORDER BY expires_at
       LIMIT $2`,
      [before, limit]
    );
    return result.rows.map(fromRow);
  }
}

function validationJobType(kind: UploadKind): "package_hash" | "media" | "evidence" {
  if (kind === "package") return "package_hash";
  if (["cover", "background", "icon", "screenshot"].includes(kind)) return "media";
  return "evidence";
}

function requireActorUuid(value: string): string {
  if (!uuidPattern.test(value)) {
    throw new UploadError(
      "UPLOAD_FORBIDDEN",
      "Production upload identities must use canonical user ids.",
      403
    );
  }
  return value;
}

function assertImmutableIdentity(current: UploadSession, next: UploadSession): void {
  for (const key of [
    "id",
    "submissionId",
    "ownerSubject",
    "fileId",
    "kind",
    "bucket",
    "objectKey",
    "providerUploadId",
    "expectedSizeBytes",
    "partSizeBytes"
  ] as const) {
    if (current[key] !== next[key]) throw new Error(`Upload identity field changed: ${key}`);
  }
}

function fromRow(row: UploadRow): UploadSession {
  return {
    id: row.id,
    submissionId: row.submission_id,
    ownerSubject: row.created_by,
    fileId: row.file_id,
    kind: row.file_kind,
    originalFilename: row.original_filename,
    safeFilename: row.safe_filename,
    declaredContentType: row.declared_content_type,
    expectedSizeBytes: Number(row.expected_size_bytes),
    partSizeBytes: row.part_size_bytes,
    maximumParallelParts: row.maximum_parallel_parts,
    bucket: row.storage_bucket,
    objectKey: row.object_key,
    providerUploadId: row.provider_upload_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
    ...(row.completed_size_bytes
      ? { completedSizeBytes: Number(row.completed_size_bytes) }
      : {}),
    ...(row.completion_fingerprint
      ? { completionFingerprint: row.completion_fingerprint }
      : {}),
    validationAttempts: row.validation_attempts
  };
}
