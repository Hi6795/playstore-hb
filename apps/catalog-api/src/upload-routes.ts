import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Principal } from "./model.js";
import {
  MultipartUploadService,
  type UploadActor,
  type UploadSession
} from "./uploads.js";

const uploadKindSchema = z.enum([
  "package",
  "cover",
  "background",
  "icon",
  "screenshot",
  "license",
  "redistribution_evidence",
  "third_party_notice"
]);
const initiateSchema = z.object({
  kind: uploadKindSchema,
  filename: z.string().min(1).max(255),
  contentType: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().positive()
}).strict();
const presignSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(4)
}).strict();
const completeSchema = z.object({
  parts: z.array(
    z.object({
      partNumber: z.number().int().min(1).max(10_000),
      etag: z.string().trim().min(1).max(200)
    }).strict()
  ).min(1).max(10_000)
}).strict();
const idSchema = z.uuid();

export function registerUploadRoutes(
  app: FastifyInstance,
  service: MultipartUploadService
): void {
  app.post<{ Params: { submissionId: string } }>(
    "/v1/admin/submissions/:submissionId/uploads/initiate",
    { preHandler: requireUploadActor },
    async (request, reply) => {
      const submissionId = idSchema.parse(request.params.submissionId);
      const body = initiateSchema.parse(request.body);
      const upload = await service.initiate(
        { submissionId, ...body },
        actor(request.principal!)
      );
      return reply.code(201).send(publicUpload(upload));
    }
  );

  app.post<{ Params: { uploadId: string } }>(
    "/v1/admin/uploads/:uploadId/parts/presign",
    { preHandler: requireUploadActor },
    async (request) => {
      const uploadId = idSchema.parse(request.params.uploadId);
      const body = presignSchema.parse(request.body);
      return {
        parts: await service.presignParts(
          uploadId,
          body.partNumbers,
          actor(request.principal!)
        )
      };
    }
  );

  app.get<{ Params: { uploadId: string } }>(
    "/v1/admin/uploads/:uploadId",
    { preHandler: requireUploadActor },
    async (request) => {
      const uploadId = idSchema.parse(request.params.uploadId);
      return publicUpload(await service.get(uploadId, actor(request.principal!)));
    }
  );

  app.get<{ Params: { uploadId: string } }>(
    "/v1/admin/uploads/:uploadId/parts",
    { preHandler: requireUploadActor },
    async (request) => {
      const uploadId = idSchema.parse(request.params.uploadId);
      return {
        parts: await service.listParts(uploadId, actor(request.principal!))
      };
    }
  );

  app.post<{ Params: { uploadId: string } }>(
    "/v1/admin/uploads/:uploadId/complete",
    { preHandler: requireUploadActor },
    async (request) => {
      const uploadId = idSchema.parse(request.params.uploadId);
      const body = completeSchema.parse(request.body);
      return publicUpload(
        await service.complete(uploadId, body.parts, actor(request.principal!))
      );
    }
  );

  app.post<{ Params: { uploadId: string } }>(
    "/v1/admin/uploads/:uploadId/abort",
    { preHandler: requireUploadActor },
    async (request) => {
      const uploadId = idSchema.parse(request.params.uploadId);
      return publicUpload(await service.abort(uploadId, actor(request.principal!)));
    }
  );

  app.post<{ Params: { uploadId: string } }>(
    "/v1/admin/uploads/:uploadId/retry-validation",
    { preHandler: requireUploadActor },
    async (request) => {
      const uploadId = idSchema.parse(request.params.uploadId);
      return publicUpload(
        await service.retryValidation(uploadId, actor(request.principal!))
      );
    }
  );

  app.delete<{ Params: { uploadId: string } }>(
    "/v1/admin/uploads/:uploadId",
    { preHandler: requireUploadActor },
    async (request, reply) => {
      const uploadId = idSchema.parse(request.params.uploadId);
      await service.delete(uploadId, actor(request.principal!));
      return reply.code(204).send();
    }
  );
}

async function requireUploadActor(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply | void> {
  if (!request.principal) {
    return reply.code(401).send({
      error: {
        code: "UNAUTHENTICATED",
        message: "A valid bearer token is required.",
        requestId: request.id
      }
    });
    return;
  }
  const roles = request.principal.roles ?? [request.principal.role];
  if (!roles.some((role) => role === "submitter" || role === "administrator")) {
    return reply.code(403).send({
      error: {
        code: "FORBIDDEN",
        message: "This role cannot manage submission uploads.",
        requestId: request.id
      }
    });
  }
}

function actor(principal: Principal): UploadActor {
  return {
    subject: principal.subject,
    role: principal.role,
    ...(principal.roles ? { roles: principal.roles } : {})
  };
}

function publicUpload(session: UploadSession) {
  return {
    id: session.id,
    submissionId: session.submissionId,
    fileId: session.fileId,
    kind: session.kind,
    filename: session.safeFilename,
    declaredContentType: session.declaredContentType,
    expectedSizeBytes: session.expectedSizeBytes,
    partSizeBytes: session.partSizeBytes,
    maximumParallelParts: session.maximumParallelParts,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    ...(session.completedAt ? { completedAt: session.completedAt } : {}),
    ...(session.completedSizeBytes
      ? { completedSizeBytes: session.completedSizeBytes }
      : {}),
    validationAttempts: session.validationAttempts
  };
}
