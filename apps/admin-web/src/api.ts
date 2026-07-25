export interface ApiProblem {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
  };
}

export interface SessionPrincipal {
  subject: string;
  username?: string;
  roles: string[];
  sessionId?: string;
}

export interface UploadView {
  id: string;
  submissionId: string;
  fileId: string;
  kind: UploadKind;
  filename: string;
  declaredContentType: string;
  expectedSizeBytes: number;
  partSizeBytes: number;
  maximumParallelParts: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt?: string;
  completedSizeBytes?: number;
  validationAttempts: number;
}

export type UploadKind =
  | "package"
  | "cover"
  | "background"
  | "icon"
  | "screenshot"
  | "license"
  | "redistribution_evidence"
  | "third_party_notice";

export interface UploadedPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class PlaystoreApi {
  private token = sessionStorage.getItem("playstorehb.admin.session") ?? "";

  constructor(readonly baseUrl = defaultApiBase()) {}

  hasSession(): boolean {
    return this.token.length > 0;
  }

  clearSession(): void {
    this.token = "";
    sessionStorage.removeItem("playstorehb.admin.session");
  }

  async login(username: string, password: string): Promise<SessionPrincipal> {
    const result = await this.request<{
      token: string;
      principal: SessionPrincipal;
    }>("/v1/auth/login", {
      method: "POST",
      body: { username, password },
      authenticated: false
    });
    this.token = result.token;
    sessionStorage.setItem("playstorehb.admin.session", result.token);
    return result.principal;
  }

  async session(): Promise<SessionPrincipal> {
    const result = await this.request<{ principal: SessionPrincipal }>(
      "/v1/auth/session"
    );
    return result.principal;
  }

  async logout(): Promise<void> {
    try {
      await this.request<void>("/v1/auth/logout", { method: "POST" });
    } finally {
      this.clearSession();
    }
  }

  async createSubmission(document: Record<string, unknown>): Promise<{ id: string }> {
    return this.request<{ id: string }>("/v1/admin/games", {
      method: "POST",
      body: document,
      idempotencyKey: crypto.randomUUID()
    });
  }

  async initiateUpload(
    submissionId: string,
    input: {
      kind: UploadKind;
      filename: string;
      contentType: string;
      sizeBytes: number;
    }
  ): Promise<UploadView> {
    return this.request<UploadView>(
      `/v1/admin/submissions/${encodeURIComponent(submissionId)}/uploads/initiate`,
      {
        method: "POST",
        body: input,
        idempotencyKey: crypto.randomUUID()
      }
    );
  }

  async upload(uploadId: string): Promise<UploadView> {
    return this.request<UploadView>(
      `/v1/admin/uploads/${encodeURIComponent(uploadId)}`
    );
  }

  async uploadedParts(uploadId: string): Promise<UploadedPart[]> {
    const result = await this.request<{ parts: UploadedPart[] }>(
      `/v1/admin/uploads/${encodeURIComponent(uploadId)}/parts`
    );
    return result.parts;
  }

  async presignParts(uploadId: string, partNumbers: number[]): Promise<PresignedPart[]> {
    const result = await this.request<{ parts: PresignedPart[] }>(
      `/v1/admin/uploads/${encodeURIComponent(uploadId)}/parts/presign`,
      { method: "POST", body: { partNumbers } }
    );
    return result.parts;
  }

  async completeUpload(
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<UploadView> {
    return this.request<UploadView>(
      `/v1/admin/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: "POST", body: { parts } }
    );
  }

  async abortUpload(uploadId: string): Promise<UploadView> {
    return this.request<UploadView>(
      `/v1/admin/uploads/${encodeURIComponent(uploadId)}/abort`,
      { method: "POST" }
    );
  }

  async retryValidation(uploadId: string): Promise<UploadView> {
    return this.request<UploadView>(
      `/v1/admin/uploads/${encodeURIComponent(uploadId)}/retry-validation`,
      { method: "POST" }
    );
  }

  async deleteUpload(uploadId: string): Promise<void> {
    await this.request<void>(`/v1/admin/uploads/${encodeURIComponent(uploadId)}`, {
      method: "DELETE"
    });
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      authenticated?: boolean;
      idempotencyKey?: string;
    } = {}
  ): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.authenticated !== false && this.token) {
      headers.set("authorization", `Bearer ${this.token}`);
    }
    if (options.idempotencyKey) {
      headers.set("idempotency-key", options.idempotencyKey);
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    const payload: unknown = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      const problem = isApiProblem(payload) ? payload : {};
      throw new ApiError(
        problem.error?.message ?? `API request failed with status ${response.status}.`,
        response.status,
        problem.error?.code ?? "API_REQUEST_FAILED",
        problem.error?.requestId
      );
    }
    return payload as T;
  }
}

function isApiProblem(value: unknown): value is ApiProblem {
  return Boolean(value) && typeof value === "object";
}

function defaultApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "localhost"
  ) {
    return `${window.location.protocol}//${window.location.hostname}:8080`;
  }
  return window.location.origin;
}
