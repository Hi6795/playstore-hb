import type { CatalogGame, CatalogManifest } from "../../../core/src/types.js";

export type Role = "submitter" | "reviewer" | "publisher" | "administrator";
export interface Principal { subject: string; role: Role }
export interface Submission {
  id: string;
  status: "draft" | "submitted" | "approved" | "rejected" | "published";
  submitter: string;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
  game?: CatalogGame;
  automatedChecks: Array<{ code: string; passed: boolean; message: string }>;
  review?: { reviewer: string; reviewedAt: string; checks: Record<string, boolean>; notes: string };
  approval?: { reviewer: string; approvedAt: string };
}
export interface AuditEvent { id: string; at: string; actor: string; action: string; resource: string; requestId: string; details: Record<string, unknown> }
export interface PublishedCatalog { manifest: CatalogManifest; signature: string }
export interface Repository {
  createSubmission(value: Submission, idempotencyKey?: string): Promise<Submission>;
  getSubmission(id: string): Promise<Submission | null>;
  listSubmissions(): Promise<Submission[]>;
  updateSubmission(id: string, updater: (value: Submission) => Submission): Promise<Submission>;
  recordAudit(event: AuditEvent): Promise<void>;
  listAudit(): Promise<AuditEvent[]>;
  getPublishedCatalog(): Promise<PublishedCatalog>;
  publish(catalog: PublishedCatalog, actor: string, requestId: string, idempotencyKey?: string): Promise<PublishedCatalog>;
}
