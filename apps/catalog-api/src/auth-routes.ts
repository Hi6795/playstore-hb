import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthService } from "./auth.js";

const bootstrapSchema = z.object({
  username: z.string().min(3).max(80),
  displayName: z.string().min(1).max(120),
  password: z.string().min(14).max(1024)
}).strict();
const loginSchema = z.object({
  username: z.string().min(1).max(80),
  password: z.string().min(1).max(1024)
}).strict();
const recoverySchema = z.object({
  username: z.string().min(1).max(80),
  recoveryCode: z.string().min(1).max(80),
  newPassword: z.string().min(14).max(1024)
}).strict();
const userIdSchema = z.uuid();

export interface AuthRouteOptions {
  bootstrapToken?: string;
  sensitiveRequestsPerMinute?: number;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  options: AuthRouteOptions = {}
): void {
  const enforceSensitiveRate = sensitiveRateLimiter(
    options.sensitiveRequestsPerMinute ?? 10
  );

  app.post(
    "/v1/auth/bootstrap",
    { preHandler: enforceSensitiveRate },
    async (request, reply) => {
      if (!options.bootstrapToken) {
        return reply.code(404).send(authProblem(request, "NOT_FOUND", "Not found."));
      }
      const supplied = request.headers["x-bootstrap-token"];
      if (
        typeof supplied !== "string" ||
        !constantTimeSecretEqual(supplied, options.bootstrapToken)
      ) {
        return reply
          .code(401)
          .send(authProblem(request, "AUTHENTICATION_FAILED", "Authentication failed."));
      }
      const body = bootstrapSchema.parse(request.body);
      const result = await authService.bootstrapAdministrator({
        ...body,
        requestId: request.id
      });
      return reply
        .header("cache-control", "no-store")
        .code(201)
        .send(result);
    }
  );

  app.post(
    "/v1/auth/login",
    { preHandler: enforceSensitiveRate },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const result = await authService.login({
        ...body,
        requestId: request.id,
        ...(request.headers["user-agent"]
          ? { userAgent: request.headers["user-agent"] }
          : {})
      });
      return reply.header("cache-control", "no-store").send(result);
    }
  );

  app.get("/v1/auth/session", async (request, reply) => {
    if (!request.principal) {
      return reply
        .code(401)
        .send(authProblem(request, "UNAUTHENTICATED", "Authentication is required."));
    }
    return reply.header("cache-control", "no-store").send({
      principal: {
        subject: request.principal.subject,
        username: request.principal.username,
        roles: request.principal.roles ?? [request.principal.role],
        sessionId: request.principal.sessionId
      }
    });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = bearerToken(request);
    if (!token) {
      return reply
        .code(401)
        .send(authProblem(request, "UNAUTHENTICATED", "Authentication is required."));
    }
    await authService.logout(token, request.id);
    return reply.header("cache-control", "no-store").code(204).send();
  });

  app.post("/v1/auth/rotate", async (request, reply) => {
    const token = bearerToken(request);
    if (!token) {
      return reply
        .code(401)
        .send(authProblem(request, "UNAUTHENTICATED", "Authentication is required."));
    }
    const result = await authService.rotateSession(
      token,
      request.id,
      request.headers["user-agent"]
    );
    return reply.header("cache-control", "no-store").send(result);
  });

  app.post(
    "/v1/auth/recover",
    { preHandler: enforceSensitiveRate },
    async (request, reply) => {
      const body = recoverySchema.parse(request.body);
      await authService.recoverAdministrator({
        ...body,
        requestId: request.id
      });
      return reply.header("cache-control", "no-store").code(204).send();
    }
  );

  app.post<{ Params: { userId: string } }>(
    "/v1/admin/users/:userId/disable",
    async (request, reply) => {
      const token = bearerToken(request);
      if (!token) {
        return reply
          .code(401)
          .send(authProblem(request, "UNAUTHENTICATED", "Authentication is required."));
      }
      await authService.disableAccount({
        administratorToken: token,
        targetUserId: userIdSchema.parse(request.params.userId),
        requestId: request.id
      });
      return reply.code(204).send();
    }
  );
}

function sensitiveRateLimiter(maximum: number) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 60) {
    throw new Error("Sensitive authentication rate limit must be between 1 and 60");
  }
  const rates = new Map<string, { windowStartedAt: number; count: number }>();
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    const current = rates.get(request.ip);
    if (!current || now - current.windowStartedAt >= 60_000) {
      rates.set(request.ip, { windowStartedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > maximum) {
      return reply
        .header("retry-after", "60")
        .code(429)
        .send(authProblem(request, "RATE_LIMITED", "Too many authentication requests."));
    }
  };
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}

function constantTimeSecretEqual(supplied: string, expected: string): boolean {
  const suppliedHash = createHash("sha256").update(supplied, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

function authProblem(request: FastifyRequest, code: string, message: string) {
  return { error: { code, message, requestId: request.id } };
}
