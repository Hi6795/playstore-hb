import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { AuditEvent, PublishedCatalog, Repository, Submission } from "./model.js";
import { runMigrations } from "./migrations.js";

const emptyCatalog: PublishedCatalog = { manifest: { schema_version: 1, catalog_version: "2026.07.18.1", catalog_sequence: 0, generated_at: "2026-07-18T00:00:00.000Z", expires_at: "2027-07-18T00:00:00.000Z", minimum_client_version: "0.1.0", key_id: "production-key-not-provisioned", channel: "stable", games: [] }, signature: "" };

export class MemoryRepository implements Repository {
  private readonly submissions = new Map<string, Submission>(); private readonly audit: AuditEvent[] = []; private catalog = structuredClone(emptyCatalog); private readonly idempotent = new Map<string, unknown>();
  async createSubmission(value: Submission, key?: string): Promise<Submission> { if (key && this.idempotent.has(key)) return structuredClone(this.idempotent.get(key) as Submission); this.submissions.set(value.id, structuredClone(value)); if (key) this.idempotent.set(key, value); return structuredClone(value); }
  async getSubmission(id: string): Promise<Submission | null> { const item = this.submissions.get(id); return item ? structuredClone(item) : null; }
  async listSubmissions(): Promise<Submission[]> { return [...this.submissions.values()].map((value) => structuredClone(value)); }
  async updateSubmission(id: string, updater: (value: Submission) => Submission): Promise<Submission> { const current = this.submissions.get(id); if (!current) throw new Error("NOT_FOUND"); const next = updater(structuredClone(current)); this.submissions.set(id, next); return structuredClone(next); }
  async recordAudit(event: AuditEvent): Promise<void> { this.audit.push(structuredClone(event)); }
  async listAudit(): Promise<AuditEvent[]> { return structuredClone(this.audit); }
  async getPublishedCatalog(): Promise<PublishedCatalog> { return structuredClone(this.catalog); }
  async publish(catalog: PublishedCatalog, actor: string, requestId: string, key?: string): Promise<PublishedCatalog> { if (key && this.idempotent.has(`publish:${key}`)) return structuredClone(this.idempotent.get(`publish:${key}`) as PublishedCatalog); this.catalog = structuredClone(catalog);this.audit.push({id:randomUUID(),at:new Date().toISOString(),actor,action:"catalog.publish",resource:"catalog",requestId,details:{sequence:catalog.manifest.catalog_sequence}}); if (key) this.idempotent.set(`publish:${key}`, catalog); return structuredClone(catalog); }
}

export class PostgresRepository implements Repository {
  constructor(readonly pool: Pool) {}
  static async connect(connectionString: string): Promise<PostgresRepository> { const pool = new Pool({ connectionString, max: 10, statement_timeout: 10_000, application_name: "playstorehb-api" }); await pool.query("SELECT 1"); return new PostgresRepository(pool); }
  async createSubmission(value: Submission, key?: string): Promise<Submission> {
    if (key) { const prior = await this.pool.query<{ response: Submission }>("SELECT response FROM idempotency_keys WHERE scope='submission' AND key=$1", [key]); if (prior.rows[0]) return prior.rows[0].response; }
    const identity = normalizedSubmissionIdentity(value);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO submissions(id, document) VALUES($1,$2)", [value.id, value]);
      await client.query(
        `INSERT INTO game_submissions(
           id, submitter_user_id, status, title_id, content_id,
           proposed_game_id, proposed_version, document, created_at, updated_at
         ) VALUES($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9)`,
        [
          value.id,
          value.submitter,
          identity.titleId,
          identity.contentId,
          identity.gameId,
          identity.version,
          value.data,
          value.createdAt,
          value.updatedAt
        ]
      );
      if (key) await client.query("INSERT INTO idempotency_keys(scope,key,response) VALUES('submission',$1,$2)", [key, value]);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async getSubmission(id: string): Promise<Submission | null> { const result = await this.pool.query<{ document: Submission }>("SELECT document FROM submissions WHERE id=$1", [id]); return result.rows[0]?.document ?? null; }
  async listSubmissions(): Promise<Submission[]> { return (await this.pool.query<{ document: Submission }>("SELECT document FROM submissions ORDER BY created_at DESC")).rows.map((row) => row.document); }
  async updateSubmission(id: string, updater: (value: Submission) => Submission): Promise<Submission> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ document: Submission }>(
        "SELECT document FROM submissions WHERE id=$1 FOR UPDATE",
        [id]
      );
      const current = result.rows[0]?.document;
      if (!current) throw new Error("NOT_FOUND");
      const next = updater(current);
      const identity = normalizedSubmissionIdentity(next);
      await client.query(
        "UPDATE submissions SET document=$2, updated_at=now() WHERE id=$1",
        [id, next]
      );
      await client.query(
        `UPDATE game_submissions
         SET title_id=$2,
             content_id=$3,
             proposed_game_id=$4,
             proposed_version=$5,
             document=$6,
             updated_at=$7
         WHERE id=$1`,
        [
          id,
          identity.titleId,
          identity.contentId,
          identity.gameId,
          identity.version,
          next.data,
          next.updatedAt
        ]
      );
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async recordAudit(event: AuditEvent): Promise<void> { await this.pool.query("INSERT INTO audit_log(id,at,actor,action,resource,request_id,details) VALUES($1,$2,$3,$4,$5,$6,$7)", [event.id, event.at, event.actor, event.action, event.resource, event.requestId, event.details]); }
  async listAudit(): Promise<AuditEvent[]> { const rows = (await this.pool.query<{ id:string;at:Date;actor:string;action:string;resource:string;request_id:string;details:Record<string,unknown> }>("SELECT * FROM audit_log ORDER BY at DESC LIMIT 1000")).rows; return rows.map((r) => ({ id:r.id, at:r.at.toISOString(), actor:r.actor, action:r.action, resource:r.resource, requestId:r.request_id, details:r.details })); }
  async getPublishedCatalog(): Promise<PublishedCatalog> { const row = (await this.pool.query<{ manifest: PublishedCatalog["manifest"]; signature: string }>("SELECT manifest,signature FROM published_catalog ORDER BY sequence DESC LIMIT 1")).rows[0]; return row ?? structuredClone(emptyCatalog); }
  async publish(catalog: PublishedCatalog, actor: string, requestId: string, key?: string): Promise<PublishedCatalog> { const client = await this.pool.connect(); try { await client.query("BEGIN"); if (key) { const prior = await client.query<{ response: PublishedCatalog }>("SELECT response FROM idempotency_keys WHERE scope='publish' AND key=$1 FOR UPDATE", [key]); if (prior.rows[0]) { await client.query("ROLLBACK"); return prior.rows[0].response; } } await client.query("INSERT INTO published_catalog(sequence,manifest,signature) VALUES($1,$2,$3)", [catalog.manifest.catalog_sequence,catalog.manifest,catalog.signature]); await client.query("INSERT INTO audit_log(id,at,actor,action,resource,request_id,details) VALUES($1,now(),$2,'catalog.publish','catalog',$3,$4)", [randomUUID(),actor,requestId,{sequence:catalog.manifest.catalog_sequence}]); if (key) await client.query("INSERT INTO idempotency_keys(scope,key,response) VALUES('publish',$1,$2)",[key,catalog]); await client.query("COMMIT"); return catalog; } catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();} }
}

export async function migrate(client: Pool | PoolClient): Promise<void> {
  await runMigrations(client);
}

function normalizedSubmissionIdentity(value: Submission): {
  gameId: string;
  titleId: string;
  contentId: string;
  version: string;
} {
  const { gameId, titleId, contentId, version } = value.data;
  if (
    typeof gameId !== "string" ||
    typeof titleId !== "string" ||
    typeof contentId !== "string" ||
    typeof version !== "string"
  ) {
    throw new Error("INVALID_SUBMISSION_DOCUMENT");
  }
  return { gameId, titleId, contentId, version };
}
