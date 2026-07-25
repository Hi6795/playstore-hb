import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { z } from "zod";
import {
  signCatalog,
  validateCatalog,
  verifySignedCatalog,
  type TrustedKey
} from "../../../core/src/index.js";
import type { CatalogGame, CatalogManifest } from "../../../core/src/types.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { AuthError, AuthService } from "./auth.js";
import type { AuditEvent, Principal, Repository, Role, Submission } from "./model.js";
import type { ReadinessService } from "./readiness.js";
import { MemoryRepository } from "./repository.js";
import { registerUploadRoutes } from "./upload-routes.js";
import { MultipartUploadService, UploadError } from "./uploads.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const roles = ["submitter", "reviewer", "hardware_tester", "publisher", "administrator"] as const;
const principalSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  role: z.enum(roles).optional(),
  roles: z.array(z.enum(roles)).min(1).max(roles.length).optional()
}).strict().refine((value) => value.role !== undefined || value.roles !== undefined);

type Permission =
  | "submission:write"
  | "submission:review"
  | "submission:hardware-test"
  | "submission:final-approve"
  | "catalog:publish"
  | "audit:read";

const permissionRoles: Record<Permission, readonly Role[]> = {
  "submission:write": ["submitter", "administrator"],
  "submission:review": ["reviewer"],
  "submission:hardware-test": ["hardware_tester"],
  "submission:final-approve": ["publisher"],
  "catalog:publish": ["publisher"],
  "audit:read": ["reviewer", "hardware_tester", "publisher", "administrator"]
};

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const createSchema = z.object({
  gameId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(120),
  developer: z.string().min(1).max(120),
  publisher: z.string().max(120).optional(),
  contact: z.string().min(3).max(320),
  sourceUrl: z.url().startsWith("https://"),
  homepage: z.url().startsWith("https://"),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  releaseDate: z.string().optional(),
  summary: z.string().max(240).optional(),
  description: z.string().min(1).max(12000),
  codeLicense: z.string().min(1),
  dataLicense: z.string().min(1),
  evidence: z.string().min(1),
  titleId: z.string().regex(/^[A-Z]{4}\d{5}$/),
  contentId: z.string().regex(/^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_00-[A-Z0-9]{16}$/),
  categories: z.string().min(1),
  controls: z.string().max(4000).optional(),
  players: z.string().max(20).optional(),
  attribution: z.string().max(4000).optional(),
  changelog: z.string().max(8000).optional(),
  testedFirmware: z.string().max(120).optional(),
  testedModel: z.enum(["fat", "slim", "pro"]).optional(),
  knownIssues: z.string().max(4000).optional(),
  packageUpload: z.string().max(128).optional(),
  coverArtwork: z.string().max(128).optional(),
  backgroundArtwork: z.string().max(128).optional(),
  screenshots: z.string().max(1000).optional(),
  originalFiles: z.union([z.literal("on"), z.boolean()]).optional(),
  localMultiplayer: z.union([z.literal("on"), z.boolean()]).optional(),
  onlineMultiplayer: z.union([z.literal("on"), z.boolean()]).optional()
}).strict();
const packageMetadataSchema = z.object({
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.pkg$/),
  sizeBytes: z.number().int().positive().max(100 * 1024 ** 3),
  sha256: sha256Schema,
  mime: z.literal("application/octet-stream"),
  storageKey: z.string().regex(/^quarantine\/[A-Za-z0-9/_-]+\.pkg$/)
}).strict();
const mediaMetadataSchema = z.object({
  kind: z.enum(["cover", "background", "icon", "screenshot"]),
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.number().int().min(64).max(7680),
  height: z.number().int().min(64).max(4320),
  sha256: sha256Schema,
  storageKey: z.string().regex(/^quarantine\/[A-Za-z0-9/_-]+\.(png|jpe?g|webp)$/)
}).strict();
const reviewChecks = z.object({
  packageSha256: sha256Schema,
  realAndFunctional: z.literal(true),
  launchesOnPs4: z.literal(true),
  matchesProject: z.literal(true),
  redistributionDocumented: z.literal(true),
  licenseTextsPresent: z.literal(true),
  screenshotsAuthentic: z.literal(true),
  noImproperCommercialData: z.literal(true),
  compatibilityTruthful: z.literal(true),
  reviewedHashMatches: z.literal(true),
  notes: z.string().max(4000).default("")
}).strict();
const hardwareTestSchema = z.object({
  packageSha256: sha256Schema,
  consoleModel: z.enum(["fat", "slim", "pro"]),
  firmware: z.string().trim().min(1).max(120),
  environment: z.string().trim().min(1).max(240),
  result: z.literal("pass"),
  notes: z.string().max(4000).default("")
}).strict();
const finalApprovalSchema = z.object({
  packageSha256: sha256Schema,
  notes: z.string().max(4000).default("")
}).strict();

export interface ApiOptions {
  repository?: Repository;
  tokens?: Readonly<Record<string, unknown>>;
  signingPrivateKeyPem?: string;
  trustedKeys?: TrustedKey[];
  logger?: boolean;
  allowedOrigins?: string[];
  uploadService?: MultipartUploadService;
  authService?: AuthService;
  authBootstrapToken?: string;
  readiness?: ReadinessService;
  trustedProxies?: string[];
}

export async function createApi(options: ApiOptions = {}): Promise<FastifyInstance> {
  const repository = options.repository ?? new MemoryRepository();
  const tokens: Readonly<Record<string, unknown>> =
    options.tokens ??
    (options.authService
      ? {}
      : {
          "development-admin-token": {
            subject: "local-admin",
            role: "administrator"
          }
        });
  const allowedOrigins = options.allowedOrigins ?? [
    "http://127.0.0.1:5174",
    "http://localhost:5174"
  ];
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 25 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
    trustProxy:
      options.trustedProxies && options.trustedProxies.length > 0
        ? options.trustedProxies
        : false
  });
  const rate = new Map<string, { window: number; count: number }>();

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      reply
        .header("access-control-allow-origin", origin)
        .header("vary", "origin")
        .header(
          "access-control-allow-headers",
          "authorization,content-type,idempotency-key,x-request-id,x-bootstrap-token"
        )
        .header("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
    }
    if (request.method === "OPTIONS") return reply.code(204).send();
    const key = request.ip;
    const now = Date.now();
    const item = rate.get(key);
    if (!item || now - item.window > 60_000) {
      rate.set(key, { window: now, count: 1 });
    } else if (++item.count > 120) {
      return reply.code(429).send(problem(request, "RATE_LIMITED", "Too many requests."));
    }
    reply
      .header("x-request-id", request.id)
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("content-security-policy", "default-src 'none'");
  });

  app.addHook("preHandler", async (request) => {
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    if (!match) return;
    const token = match[1]!;
    if (Object.prototype.hasOwnProperty.call(tokens, token)) {
      const parsed = principalSchema.safeParse(tokens[token]);
      if (parsed.success) {
        const parsedRoles = [
          ...new Set([...(parsed.data.roles ?? []), ...(parsed.data.role ? [parsed.data.role] : [])])
        ];
        request.principal = {
          subject: parsed.data.subject,
          role: preferredRole(parsedRoles),
          roles: parsedRoles
        };
      }
      return;
    }
    if (options.authService) {
      const authenticated = await options.authService.authenticate(token);
      if (authenticated && authenticated.roles.length > 0) {
        request.principal = {
          subject: authenticated.subject,
          username: authenticated.username,
          sessionId: authenticated.sessionId,
          role: preferredRole(authenticated.roles),
          roles: authenticated.roles
        };
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const response = safeError(error);
    if (response.status === 500) request.log.error({ err: error }, "Unhandled API error");
    if (error instanceof AuthError && error.retryAfterMs) {
      reply.header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
    }
    return reply
      .code(response.status)
      .send(problem(request, response.code, response.message));
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "playstorehb-catalog-api",
    version: "0.1.0"
  }));
  app.get("/ready", async (request, reply) => {
    if (!options.readiness) {
      return reply
        .code(503)
        .send(problem(request, "READINESS_NOT_CONFIGURED", "Readiness is not configured."));
    }
    const result = await options.readiness.check();
    return reply.code(result.ready ? 200 : 503).send({
      status: result.ready ? "ready" : "not_ready",
      checks: result.checks
    });
  });
  app.get("/v1/catalog", async (_request, reply) =>
    reply
      .header("cache-control", "public, max-age=60")
      .send((await repository.getPublishedCatalog()).manifest)
  );
  app.get("/v1/catalog/signature", async () => {
    const catalog = await repository.getPublishedCatalog();
    return { key_id: catalog.manifest.key_id, signature: catalog.signature };
  });
  app.get("/v1/games", async () => (await repository.getPublishedCatalog()).manifest.games);
  app.get<{ Params: { id: string } }>("/v1/games/:id", async (request, reply) => {
    const game = (await repository.getPublishedCatalog()).manifest.games.find(
      (candidate) => candidate.id === request.params.id
    );
    return game ?? reply.code(404).send(problem(request, "NOT_FOUND", "Game not found."));
  });
  app.get("/v1/categories", async () => {
    const games = (await repository.getPublishedCatalog()).manifest.games;
    return [...new Set(games.flatMap((game) => game.categories))]
      .sort()
      .map((id) => ({
        id,
        count: games.filter((game) => game.categories.includes(id)).length
      }));
  });
  app.get("/v1/client/releases/latest", async () => ({
    version: "0.1.0",
    status: "desktop-tested",
    ps4HardwareTested: false,
    url: null
  }));

  app.post(
    "/v1/admin/games",
    { preHandler: authorize("submission:write") },
    async (request, reply) => {
      const data = createSchema.parse(request.body);
      const existing = await repository.listSubmissions();
      if (
        existing.some(
          (submission) =>
            submission.data.titleId === data.titleId ||
            submission.data.contentId === data.contentId
        )
      ) {
        throw new Error("DUPLICATE_IDENTIFIER");
      }
      const now = new Date().toISOString();
      const submission: Submission = {
        id: randomUUID(),
        status: "draft",
        submitter: request.principal!.subject,
        createdAt: now,
        updatedAt: now,
        data,
        automatedChecks: automatedChecks(data)
      };
      const created = await repository.createSubmission(submission, idempotency(request));
      await audit(repository, request, "submission.create", created.id, {});
      return reply.code(201).send(created);
    }
  );

  app.put<{ Params: { id: string } }>(
    "/v1/admin/games/:id",
    { preHandler: authorize("submission:write") },
    async (request) => {
      const raw = request.body;
      const wrapped = isRecord(raw) && ("game" in raw || "submission" in raw);
      const data =
        wrapped && raw.submission !== undefined
          ? createSchema.parse(raw.submission)
          : wrapped
            ? undefined
            : createSchema.parse(raw);
      const game =
        wrapped && raw.game !== undefined ? validateGameRecord(raw.game) : undefined;
      if (!data && !game) throw new Error("EMPTY_UPDATE");
      if (data && game && data.gameId !== game.id) {
        throw new Error("GAME_ID_MISMATCH");
      }

      const existing = await repository.listSubmissions();
      if (
        data &&
        existing.some(
          (submission) =>
            submission.id !== request.params.id &&
            (submission.data.titleId === data.titleId ||
              submission.data.contentId === data.contentId)
        )
      ) {
        throw new Error("DUPLICATE_IDENTIFIER");
      }

      const value = await repository.updateSubmission(request.params.id, (submission) => {
        assertOwnedDraft(submission, request.principal!);
        const nextData = data ?? submission.data;
        const nextGame = game ?? submission.game;
        if (nextGame && nextData.gameId !== nextGame.id) {
          throw new Error("GAME_ID_MISMATCH");
        }
        const attached = attachedPackage(submission);
        if (attached && nextGame && !packageMatchesGame(attached, nextGame)) {
          throw new Error("PACKAGE_METADATA_MISMATCH");
        }
        return {
          ...submission,
          data: nextData,
          ...(nextGame ? { game: nextGame } : {}),
          automatedChecks: automatedChecks(nextData as z.infer<typeof createSchema>),
          updatedAt: new Date().toISOString()
        };
      });
      await audit(repository, request, "submission.update", value.id, {
        gameMetadataAttached: Boolean(game)
      });
      return value;
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/admin/games/:id/packages",
    { preHandler: authorize("submission:write") },
    async (request) => {
      const body = packageMetadataSchema.parse(request.body);
      const result = await repository.updateSubmission(request.params.id, (submission) => {
        assertOwnedDraft(submission, request.principal!);
        if (submission.game && !packageMatchesGame(body, submission.game)) {
          throw new Error("PACKAGE_METADATA_MISMATCH");
        }
        return {
          ...submission,
          data: { ...submission.data, package: body },
          updatedAt: new Date().toISOString()
        };
      });
      await audit(repository, request, "package.attach", result.id, {
        filename: body.filename,
        sizeBytes: body.sizeBytes,
        sha256: body.sha256
      });
      return result;
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/admin/games/:id/media",
    { preHandler: authorize("submission:write") },
    async (request) => {
      const body = mediaMetadataSchema.parse(request.body);
      await repository.updateSubmission(request.params.id, (submission) => {
        assertOwnedDraft(submission, request.principal!);
        const existingMedia = Array.isArray(submission.data.media)
          ? submission.data.media
          : [];
        return {
          ...submission,
          data: { ...submission.data, media: [...existingMedia, body] },
          updatedAt: new Date().toISOString()
        };
      });
      await audit(repository, request, "media.attach", request.params.id, {
        kind: body.kind,
        width: body.width,
        height: body.height,
        sha256: body.sha256
      });
      return {
        accepted: true,
        automatedValidation: "pending",
        legalApproval: false
      };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/admin/games/:id/submit-review",
    { preHandler: authorize("submission:write") },
    async (request) => {
      const result = await repository.updateSubmission(request.params.id, (submission) => {
        assertOwnedDraft(submission, request.principal!);
        if (!submission.game) throw new Error("MISSING_COMPLETE_GAME_METADATA");
        const attached = attachedPackage(submission);
        if (!attached) throw new Error("MISSING_PACKAGE_METADATA");
        if (!packageMatchesGame(attached, submission.game)) {
          throw new Error("PACKAGE_METADATA_MISMATCH");
        }
        if (submission.automatedChecks.some((check) => !check.passed)) {
          throw new Error("AUTOMATED_CHECKS_FAILED");
        }
        return {
          ...submission,
          status: "submitted",
          submittedPackageSha256: attached.sha256,
          updatedAt: new Date().toISOString()
        };
      });
      await audit(repository, request, "submission.submit-review", result.id, {
        packageSha256: result.submittedPackageSha256
      });
      return result;
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/admin/games/:id/approve",
    { preHandler: authorize("submission:review") },
    async (request) => {
      const checks = reviewChecks.parse(request.body);
      const { notes, packageSha256, ...booleanChecks } = checks;
      const result = await repository.updateSubmission(request.params.id, (submission) => {
        if (submission.status !== "submitted") throw new Error("INVALID_STATE");
        if (submission.submitter === request.principal!.subject) {
          throw new Error("INDEPENDENT_REVIEW_REQUIRED");
        }
        assertCurrentPackageHash(submission, packageSha256);
        const at = new Date().toISOString();
        return {
          ...submission,
          status: "awaiting_hardware_test",
          review: {
            reviewer: request.principal!.subject,
            reviewedAt: at,
            packageSha256,
            checks: booleanChecks,
            notes
          },
          approval: {
            reviewer: request.principal!.subject,
            approvedAt: at,
            packageSha256
          },
          updatedAt: at
        };
      });
      await audit(repository, request, "submission.review-approve", result.id, {
        packageSha256
      });
      return result;
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/admin/games/:id/hardware-test",
    { preHandler: authorize("submission:hardware-test") },
    async (request) => {
      const test = hardwareTestSchema.parse(request.body);
      const result = await repository.updateSubmission(request.params.id, (submission) => {
        if (submission.status !== "awaiting_hardware_test") {
          throw new Error("INVALID_STATE");
        }
        if (
          submission.submitter === request.principal!.subject ||
          submission.review?.reviewer === request.principal!.subject
        ) {
          throw new Error("SEPARATION_OF_DUTIES_REQUIRED");
        }
        assertCurrentPackageHash(submission, test.packageSha256);
        const at = new Date().toISOString();
        return {
          ...submission,
          status: "awaiting_final_approval",
          hardwareTest: {
            tester: request.principal!.subject,
            testedAt: at,
            packageSha256: test.packageSha256,
            consoleModel: test.consoleModel,
            firmware: test.firmware,
            environment: test.environment,
            result: test.result,
            notes: test.notes
          },
          updatedAt: at
        };
      });
      await audit(repository, request, "submission.hardware-test-pass", result.id, {
        packageSha256: test.packageSha256,
        consoleModel: test.consoleModel,
        firmware: test.firmware
      });
      return result;
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/admin/games/:id/final-approve",
    { preHandler: authorize("submission:final-approve") },
    async (request) => {
      const approval = finalApprovalSchema.parse(request.body);
      const result = await repository.updateSubmission(request.params.id, (submission) => {
        if (submission.status !== "awaiting_final_approval") {
          throw new Error("INVALID_STATE");
        }
        if (
          submission.submitter === request.principal!.subject ||
          submission.review?.reviewer === request.principal!.subject ||
          submission.hardwareTest?.tester === request.principal!.subject
        ) {
          throw new Error("SEPARATION_OF_DUTIES_REQUIRED");
        }
        assertCurrentPackageHash(submission, approval.packageSha256);
        const at = new Date().toISOString();
        return {
          ...submission,
          status: "approved",
          finalApproval: {
            publisher: request.principal!.subject,
            approvedAt: at,
            packageSha256: approval.packageSha256,
            notes: approval.notes
          },
          updatedAt: at
        };
      });
      await audit(repository, request, "submission.final-approve", result.id, {
        packageSha256: approval.packageSha256
      });
      return result;
    }
  );

  app.post(
    "/v1/admin/catalog/publish",
    { preHandler: authorize("catalog:publish") },
    async (request) => {
      const body = z.object({
        manifest: z.unknown(),
        signature: z.string().optional()
      }).strict().parse(request.body);
      const manifest = validateCatalog(body.manifest, { production: true });
      const submissions = await repository.listSubmissions();
      const publisher = request.principal!.subject;

      for (const game of manifest.games) {
        const approved = submissions.find(
          (submission) =>
            submission.status === "approved" &&
            submission.game?.id === game.id &&
            submission.game.package.sha256 === game.package.sha256 &&
            submission.submittedPackageSha256 === game.package.sha256 &&
            submission.review?.packageSha256 === game.package.sha256 &&
            submission.hardwareTest?.packageSha256 === game.package.sha256 &&
            submission.hardwareTest?.result === "pass" &&
            submission.finalApproval?.packageSha256 === game.package.sha256
        );
        if (!approved) throw new Error("MISSING_MATCHING_APPROVAL");
        if (
          approved.submitter === publisher ||
          approved.review?.reviewer === publisher ||
          approved.hardwareTest?.tester === publisher
        ) {
          throw new Error("PUBLISHER_SEPARATION_REQUIRED");
        }
        if (approved.finalApproval?.publisher !== publisher) {
          throw new Error("MISSING_MATCHING_APPROVAL");
        }
      }

      let signature = body.signature;
      if (signature) {
        const current = await repository.getPublishedCatalog();
        verifySignedCatalog(manifest, signature, options.trustedKeys ?? [], {
          highestSequence: current.manifest.catalog_sequence,
          clientVersion: "0.1.0",
          production: true
        });
      } else {
        if (!options.signingPrivateKeyPem) throw new Error("EXTERNAL_SIGNATURE_REQUIRED");
        signature = signCatalog(manifest, options.signingPrivateKeyPem);
      }
      return repository.publish(
        { manifest, signature },
        publisher,
        request.id,
        idempotency(request)
      );
    }
  );

  app.get(
    "/v1/admin/audit-log",
    { preHandler: authorize("audit:read") },
    async () => repository.listAudit()
  );

  if (options.uploadService) registerUploadRoutes(app, options.uploadService);
  if (options.authService) {
    registerAuthRoutes(app, options.authService, {
      ...(options.authBootstrapToken
        ? { bootstrapToken: options.authBootstrapToken }
        : {})
    });
  }

  return app;
}

function authorize(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.principal) {
      return reply
        .code(401)
        .send(problem(request, "UNAUTHENTICATED", "A valid bearer token is required."));
    }
    if (
      !principalRoles(request.principal).some((role) =>
        permissionRoles[permission].includes(role)
      )
    ) {
      return reply
        .code(403)
        .send(problem(request, "FORBIDDEN", "This role cannot perform that action."));
    }
  };
}

function principalRoles(principal: Principal): Role[] {
  return [...new Set(principal.roles ?? [principal.role])];
}

function preferredRole(available: readonly Role[]): Role {
  for (const role of [
    "administrator",
    "publisher",
    "hardware_tester",
    "reviewer",
    "submitter"
  ] as const) {
    if (available.includes(role)) return role;
  }
  throw new Error("INVALID_PRINCIPAL_ROLES");
}

function assertOwnedDraft(submission: Submission, principal: Principal): void {
  if (submission.submitter !== principal.subject) throw new Error("FORBIDDEN");
  if (submission.status !== "draft") throw new Error("IMMUTABLE_SUBMISSION");
}

function attachedPackage(
  submission: Submission
): z.infer<typeof packageMetadataSchema> | null {
  const parsed = packageMetadataSchema.safeParse(submission.data.package);
  return parsed.success ? parsed.data : null;
}

function packageMatchesGame(
  attached: z.infer<typeof packageMetadataSchema>,
  game: CatalogGame
): boolean {
  return (
    attached.sha256 === game.package.sha256 &&
    attached.sizeBytes === game.package.size_bytes &&
    attached.filename === game.package.filename
  );
}

function assertCurrentPackageHash(submission: Submission, packageSha256: string): void {
  const attached = attachedPackage(submission);
  if (
    !submission.game ||
    !attached ||
    attached.sha256 !== packageSha256 ||
    submission.game.package.sha256 !== packageSha256 ||
    submission.submittedPackageSha256 !== packageSha256
  ) {
    throw new Error("PACKAGE_HASH_MISMATCH");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function problem(request: FastifyRequest, code: string, message: string) {
  return { error: { code, message, requestId: request.id } };
}

function idempotency(request: FastifyRequest): string | undefined {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" ? value : undefined;
}

function automatedChecks(data: z.infer<typeof createSchema>) {
  const development = JSON.stringify(data).toUpperCase().includes("DEVELOPMENT TEST DATA");
  return [
    {
      code: "IDENTIFIERS",
      passed: true,
      message: "Identifiers match format; database duplicate check is required before approval."
    },
    {
      code: "LICENSE_FIELDS",
      passed: Boolean(data.codeLicense && data.dataLicense && data.evidence),
      message: "License fields are present; automated validation is not legal approval."
    },
    {
      code: "DEVELOPMENT_MARKER_DETECTION",
      passed: true,
      message: development
        ? "DEVELOPMENT TEST DATA marker detected; production publication will refuse this record."
        : "No development marker detected."
    }
  ];
}

function validateGameRecord(value: unknown): CatalogGame {
  const now = new Date();
  const manifest: CatalogManifest = {
    schema_version: 1,
    catalog_version: `${now.toISOString().slice(0, 10).replaceAll("-", ".")}.9999`,
    catalog_sequence: 9999,
    generated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 86400_000).toISOString(),
    minimum_client_version: "0.1.0",
    key_id: "submission-validation",
    channel: "development",
    games: [value as CatalogGame]
  };
  return validateCatalog(manifest).games[0]!;
}

async function audit(
  repository: Repository,
  request: FastifyRequest,
  action: string,
  resource: string,
  details: Record<string, unknown>
): Promise<void> {
  const event: AuditEvent = {
    id: randomUUID(),
    at: new Date().toISOString(),
    actor: request.principal?.subject ?? "anonymous",
    action,
    resource,
    requestId: request.id,
    details
  };
  await repository.recordAudit(event);
}

interface SafeErrorResponse {
  status: number;
  code: string;
  message: string;
}

const knownErrors: Record<string, SafeErrorResponse> = {
  NOT_FOUND: { status: 404, code: "NOT_FOUND", message: "The requested record does not exist." },
  FORBIDDEN: { status: 403, code: "FORBIDDEN", message: "This action is not permitted." },
  DUPLICATE_IDENTIFIER: {
    status: 409,
    code: "DUPLICATE_IDENTIFIER",
    message: "A submission already uses that title or content identifier."
  },
  EMPTY_UPDATE: {
    status: 400,
    code: "INVALID_REQUEST",
    message: "The update did not contain supported fields."
  },
  IMMUTABLE_SUBMISSION: {
    status: 409,
    code: "INVALID_STATE",
    message: "The submission cannot be changed in its current state."
  },
  INVALID_STATE: {
    status: 409,
    code: "INVALID_STATE",
    message: "The requested state transition is not allowed."
  },
  MISSING_COMPLETE_GAME_METADATA: {
    status: 409,
    code: "MISSING_REQUIREMENT",
    message: "Complete game metadata is required before review."
  },
  MISSING_PACKAGE_METADATA: {
    status: 409,
    code: "MISSING_REQUIREMENT",
    message: "Verified package metadata is required before review."
  },
  PACKAGE_METADATA_MISMATCH: {
    status: 409,
    code: "PACKAGE_METADATA_MISMATCH",
    message: "Attached package metadata does not match the game record."
  },
  GAME_ID_MISMATCH: {
    status: 409,
    code: "GAME_ID_MISMATCH",
    message: "The submission game id does not match the catalog game record."
  },
  PACKAGE_HASH_MISMATCH: {
    status: 409,
    code: "PACKAGE_HASH_MISMATCH",
    message: "The decision does not match the submitted package hash."
  },
  AUTOMATED_CHECKS_FAILED: {
    status: 409,
    code: "AUTOMATED_CHECKS_FAILED",
    message: "Automated checks must pass before review."
  },
  INDEPENDENT_REVIEW_REQUIRED: {
    status: 403,
    code: "SEPARATION_OF_DUTIES_REQUIRED",
    message: "A submitter cannot review their own submission."
  },
  SEPARATION_OF_DUTIES_REQUIRED: {
    status: 403,
    code: "SEPARATION_OF_DUTIES_REQUIRED",
    message: "This decision requires an independent actor."
  },
  PUBLISHER_SEPARATION_REQUIRED: {
    status: 403,
    code: "SEPARATION_OF_DUTIES_REQUIRED",
    message: "A publisher cannot publish a submission they submitted, reviewed, or hardware-tested."
  },
  MISSING_MATCHING_APPROVAL: {
    status: 409,
    code: "MISSING_MATCHING_APPROVAL",
    message: "Every catalog game requires hash-matched review, hardware, and final approval."
  },
  EXTERNAL_SIGNATURE_REQUIRED: {
    status: 503,
    code: "SIGNING_UNAVAILABLE",
    message: "An externally signed catalog is required."
  }
};

const signatureErrors = new Set([
  "CATALOG_EXPIRED",
  "CLIENT_UPDATE_REQUIRED",
  "CATALOG_DOWNGRADE_REJECTED",
  "UNKNOWN_SIGNING_KEY",
  "SIGNING_KEY_NOT_ACTIVE",
  "SIGNING_KEY_EXPIRED",
  "INVALID_SIGNATURE_ENCODING",
  "INVALID_CATALOG_SIGNATURE"
]);

function safeError(error: unknown): SafeErrorResponse {
  if (error instanceof AuthError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message
    };
  }
  if (error instanceof UploadError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message
    };
  }
  if (error instanceof z.ZodError || (error instanceof Error && error.name === "CatalogValidationError")) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The request did not pass validation."
    };
  }
  const internalCode = error instanceof Error ? error.message : "";
  const known = knownErrors[internalCode];
  if (known) return known;
  if (signatureErrors.has(internalCode)) {
    return {
      status: 400,
      code: "INVALID_CATALOG_SIGNATURE",
      message: "The catalog signature or acceptance state is invalid."
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "The server could not complete the request."
  };
}

export function hashPassword(
  password: string,
  salt = Buffer.from(randomUUID())
): { salt: string; hash: string } {
  const hash = scryptSync(password, salt, 64);
  return { salt: salt.toString("base64"), hash: hash.toString("base64") };
}

export function verifyPassword(
  password: string,
  saltBase64: string,
  hashBase64: string
): boolean {
  const actual = scryptSync(password, Buffer.from(saltBase64, "base64"), 64);
  const expected = Buffer.from(hashBase64, "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
