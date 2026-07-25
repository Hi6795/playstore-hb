import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../../apps/catalog-api/src/app.js";
import { ReadinessService } from "../../apps/catalog-api/src/readiness.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("readiness checks", () => {
  it("reports ready only when every dependency succeeds", async () => {
    const service = new ReadinessService({
      database: async () => undefined,
      storage: async () => undefined
    });
    await expect(service.check()).resolves.toMatchObject({
      ready: true,
      checks: {
        database: { ready: true },
        storage: { ready: true }
      }
    });
  });

  it("bounds failed and stalled dependency checks without leaking errors", async () => {
    const service = new ReadinessService(
      {
        database: async () => {
          throw new Error("postgresql://operator:secret@example.invalid/private");
        },
        storage: () => new Promise<void>(() => undefined)
      },
      100
    );
    const result = await service.check();
    expect(result).toMatchObject({
      ready: false,
      checks: {
        database: { ready: false },
        storage: { ready: false }
      }
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("serves readiness separately from liveness", async () => {
    app = await createApi({
      readiness: new ReadinessService({ database: async () => undefined })
    });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe("ready");

    await app.close();
    app = await createApi({
      readiness: new ReadinessService({
        database: async () => {
          throw new Error("unavailable");
        }
      })
    });
    const unavailable = await app.inject({ method: "GET", url: "/ready" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      status: "not_ready",
      checks: { database: { ready: false } }
    });
  });
});
