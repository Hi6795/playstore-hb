import type { CatalogGame, CatalogManifest } from "../../../core/src/types.js";

export type Role = "submitter" | "reviewer" | "hardware_tester" | "publisher" | "administrator";
export interface Principal {
  subject: string;
  role: Role;
  roles?: Role[];
  username?: string;
  sessionId?: string;
}
export type SubmissionStatus =
  | "draft"
  | "submitted"
  | "awaiting_hardware_test"
  | "awaiting_final_approval"
  | "approved"
  | "rejected"
  | "published";
export interface Submission {
  id: string;
  status: SubmissionStatus;
  submitter: string;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
  game?: CatalogGame;
  submittedPackageSha256?: string;
  automatedChecks: Array<{ code: string; passed: boolean; message: string }>;
  review?: {
    reviewer: string;
    reviewedAt: string;
    packageSha256: string;
    checks: Record<string, boolean>;
    notes: string;
  };
  approval?: { reviewer: string; approvedAt: string; packageSha256: string };
  hardwareTest?: {
    tester: string;
    testedAt: string;
    packageSha256: string;
    consoleModel: "fat" | "slim" | "pro";
    firmware: string;
    environment: string;
    result: "pass";
    notes: string;
  };
  finalApproval?: {
    publisher: string;
    approvedAt: string;
    packageSha256: string;
    notes: string;
  };
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
