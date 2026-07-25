import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApi } from "../../apps/catalog-api/src/app.js";
import { MemoryRepository } from "../../apps/catalog-api/src/repository.js";
import type { CatalogGame, CatalogManifest } from "../../core/src/types.js";
import { signCatalog } from "../../core/src/signedCatalog.js";
import { developmentGame } from "../fixtures/catalog.js";

const tokens = {
  submit: { subject: "alice", role: "submitter" as const },
  other: { subject: "mallory", role: "submitter" as const },
  review: { subject: "bob", role: "reviewer" as const },
  hardware: { subject: "helen", role: "hardware_tester" as const },
  publisher: { subject: "pat", role: "publisher" as const },
  publisherSubmitter: { subject: "alice", role: "publisher" as const },
  publisherReviewer: { subject: "bob", role: "publisher" as const },
  publisherHardwareTester: { subject: "helen", role: "publisher" as const },
  admin: { subject: "root", role: "administrator" as const }
};
const body = {
  gameId: "development-test-data",
  name: "DEVELOPMENT TEST DATA",
  developer: "Test suite",
  contact: "test@example.invalid",
  sourceUrl: "https://source.test.invalid/project",
  homepage: "https://home.test.invalid",
  version: "1.0.0",
  description: "Test-only submission object.",
  codeLicense: "MIT",
  dataLicense: "CC0-1.0",
  evidence: "TEST-ONLY",
  titleId: "PSTB10001",
  contentId: "IV0000-PSTB10001_00-DEVELOPMENTFIX01",
  categories: "arcade"
};
const game = developmentGame();
const productionGame = developmentGame({
  id: "security-test-release",
  name: "Security test release",
  publisher: "Test suite",
  summary: "A non-production test fixture for publication authorization.",
  description: "Used only to exercise the production publication security contract.",
  development_test_data: false
});
const packageMetadata = {
  filename: game.package.filename,
  sizeBytes: game.package.size_bytes,
  sha256: game.package.sha256,
  mime: "application/octet-stream",
  storageKey: "quarantine/submissions/development.pkg"
};
const mediaMetadata = {
  kind: "cover",
  mime: "image/png",
  width: 1000,
  height: 1500,
  sha256: "1".repeat(64),
  storageKey: "quarantine/submissions/cover.png"
};
const reviewChecks = {
  packageSha256: game.package.sha256,
  realAndFunctional: true,
  launchesOnPs4: true,
  matchesProject: true,
  redistributionDocumented: true,
  licenseTextsPresent: true,
  screenshotsAuthentic: true,
  noImproperCommercialData: true,
  compatibilityTruthful: true,
  reviewedHashMatches: true,
  notes: "Test workflow only"
};
const hardwareTest = {
  packageSha256: game.package.sha256,
  consoleModel: "slim",
  firmware: "11.02",
  environment: "Test-only fixture",
  result: "pass",
  notes: "Test workflow only"
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function createSubmitted(
  instance: FastifyInstance,
  selectedGame: CatalogGame = game
): Promise<string> {
  const submissionBody = { ...body, gameId: selectedGame.id };
  const create = await instance.inject({
    method: "POST",
    url: "/v1/admin/games",
    headers: { authorization: "Bearer submit" },
    payload: submissionBody
  });
  expect(create.statusCode).toBe(201);
  const id = create.json().id as string;
  expect(
    (
      await instance.inject({
        method: "PUT",
        url: `/v1/admin/games/${id}`,
        headers: { authorization: "Bearer submit" },
        payload: { submission: submissionBody, game: selectedGame }
      })
    ).statusCode
  ).toBe(200);
  expect(
    (
      await instance.inject({
        method: "POST",
        url: `/v1/admin/games/${id}/packages`,
        headers: { authorization: "Bearer submit" },
        payload: {
          ...packageMetadata,
          filename: selectedGame.package.filename,
          sizeBytes: selectedGame.package.size_bytes,
          sha256: selectedGame.package.sha256
        }
      })
    ).statusCode
  ).toBe(200);
  expect(
    (
      await instance.inject({
        method: "POST",
        url: `/v1/admin/games/${id}/submit-review`,
        headers: { authorization: "Bearer submit" }
      })
    ).statusCode
  ).toBe(200);
  return id;
}

describe("catalog API", () => {
  it("serves public health and empty catalog", async () => {
    app = await createApi({ tokens });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const catalog = await app.inject({ method: "GET", url: "/v1/catalog" });
    expect(catalog.json().games).toEqual([]);
  });

  it("requires authentication for submission", async () => {
    app = await createApi({ tokens });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/admin/games",
          payload: body
        })
      ).statusCode
    ).toBe(401);
  });

  it("rejects inherited bearer names and runtime-invalid principals", async () => {
    app = await createApi({
      tokens: {
        ...tokens,
        malformed: { subject: "attacker", role: "superuser" }
      }
    });
    for (const token of ["__proto__", "constructor", "toString", "malformed"]) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/admin/audit-log",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(response.statusCode, token).toBe(401);
    }
  });

  it("enforces independent, exact-role, hash-bound review decisions", async () => {
    const repository = new MemoryRepository();
    app = await createApi({ tokens, repository });
    const id = await createSubmitted(app);

    for (const token of ["submit", "publisher", "admin", "hardware"]) {
      const denied = await app.inject({
        method: "POST",
        url: `/v1/admin/games/${id}/approve`,
        headers: { authorization: `Bearer ${token}` },
        payload: reviewChecks
      });
      expect(denied.statusCode, token).toBe(403);
    }

    const wrongHash = await app.inject({
      method: "POST",
      url: `/v1/admin/games/${id}/approve`,
      headers: { authorization: "Bearer review" },
      payload: { ...reviewChecks, packageSha256: "f".repeat(64) }
    });
    expect(wrongHash.statusCode).toBe(409);
    expect(wrongHash.json().error.code).toBe("PACKAGE_HASH_MISMATCH");

    const approved = await app.inject({
      method: "POST",
      url: `/v1/admin/games/${id}/approve`,
      headers: { authorization: "Bearer review" },
      payload: reviewChecks
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: "awaiting_hardware_test",
      review: { reviewer: "bob", packageSha256: game.package.sha256 }
    });
    const audit = await app.inject({
      method: "GET",
      url: "/v1/admin/audit-log",
      headers: { authorization: "Bearer review" }
    });
    expect(audit.json().map((event: { action: string }) => event.action)).toContain(
      "submission.review-approve"
    );
  });

  it("binds hardware and final approval to the submitted package hash", async () => {
    app = await createApi({ tokens });
    const id = await createSubmitted(app);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/games/${id}/approve`,
          headers: { authorization: "Bearer review" },
          payload: reviewChecks
        })
      ).statusCode
    ).toBe(200);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/games/${id}/hardware-test`,
          headers: { authorization: "Bearer review" },
          payload: hardwareTest
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/games/${id}/hardware-test`,
          headers: { authorization: "Bearer hardware" },
          payload: { ...hardwareTest, packageSha256: "f".repeat(64) }
        })
      ).statusCode
    ).toBe(409);

    const tested = await app.inject({
      method: "POST",
      url: `/v1/admin/games/${id}/hardware-test`,
      headers: { authorization: "Bearer hardware" },
      payload: hardwareTest
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      status: "awaiting_final_approval",
      hardwareTest: { tester: "helen", packageSha256: game.package.sha256 }
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/games/${id}/final-approve`,
          headers: { authorization: "Bearer publisherReviewer" },
          payload: { packageSha256: game.package.sha256 }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/games/${id}/final-approve`,
          headers: { authorization: "Bearer publisherHardwareTester" },
          payload: { packageSha256: game.package.sha256 }
        })
      ).statusCode
    ).toBe(403);

    const final = await app.inject({
      method: "POST",
      url: `/v1/admin/games/${id}/final-approve`,
      headers: { authorization: "Bearer publisher" },
      payload: { packageSha256: game.package.sha256, notes: "Final test approval" }
    });
    expect(final.statusCode).toBe(200);
    expect(final.json()).toMatchObject({
      status: "approved",
      finalApproval: { publisher: "pat", packageSha256: game.package.sha256 }
    });
  });

  it("prevents a submitter, reviewer, or hardware tester from publishing the same release", async () => {
    const repository = new MemoryRepository();
    const pair = generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const now = new Date();
    const manifest: CatalogManifest = {
      schema_version: 1,
      catalog_version: `${now.toISOString().slice(0, 10).replaceAll("-", ".")}.3`,
      catalog_sequence: 1,
      generated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 86400_000).toISOString(),
      minimum_client_version: "0.1.0",
      key_id: "test-production-key",
      channel: "stable",
      games: [productionGame]
    };
    app = await createApi({
      tokens,
      repository,
      trustedKeys: [{ id: manifest.key_id, publicKeyPem: publicPem }]
    });
    const id = await createSubmitted(app, productionGame);
    for (const [path, token, payload] of [
      ["approve", "review", reviewChecks],
      ["hardware-test", "hardware", hardwareTest],
      [
        "final-approve",
        "publisher",
        { packageSha256: productionGame.package.sha256, notes: "Final test approval" }
      ]
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/admin/games/${id}/${path}`,
        headers: { authorization: `Bearer ${token}` },
        payload
      });
      expect(response.statusCode, path).toBe(200);
    }

    const signature = signCatalog(manifest, privatePem);
    for (const token of [
      "publisherSubmitter",
      "publisherReviewer",
      "publisherHardwareTester"
    ]) {
      const denied = await app.inject({
        method: "POST",
        url: "/v1/admin/catalog/publish",
        headers: { authorization: `Bearer ${token}` },
        payload: { manifest, signature }
      });
      expect(denied.statusCode, token).toBe(403);
      expect(denied.json().error.code, token).toBe("SEPARATION_OF_DUTIES_REQUIRED");
    }

    const published = await app.inject({
      method: "POST",
      url: "/v1/admin/catalog/publish",
      headers: { authorization: "Bearer publisher" },
      payload: { manifest, signature }
    });
    expect(published.statusCode).toBe(200);
  });

  it("enforces submission ownership and prevents state regression", async () => {
    app = await createApi({ tokens });
    const create = await app.inject({
      method: "POST",
      url: "/v1/admin/games",
      headers: { authorization: "Bearer submit" },
      payload: body
    });
    const id = create.json().id as string;

    for (const path of ["packages", "media", "submit-review"]) {
      const payload =
        path === "packages" ? packageMetadata : path === "media" ? mediaMetadata : undefined;
      const denied = await app.inject({
        method: "POST",
        url: `/v1/admin/games/${id}/${path}`,
        headers: { authorization: "Bearer other" },
        ...(payload ? { payload } : {})
      });
      expect(denied.statusCode, path).toBe(403);
    }

    await app.inject({
      method: "PUT",
      url: `/v1/admin/games/${id}`,
      headers: { authorization: "Bearer submit" },
      payload: { submission: body, game }
    });
    await app.inject({
      method: "POST",
      url: `/v1/admin/games/${id}/packages`,
      headers: { authorization: "Bearer submit" },
      payload: packageMetadata
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/games/${id}/submit-review`,
          headers: { authorization: "Bearer submit" }
        })
      ).statusCode
    ).toBe(200);

    for (const [path, payload] of [
      ["packages", packageMetadata],
      ["media", mediaMetadata],
      ["submit-review", undefined]
    ] as const) {
      const regressed = await app.inject({
        method: "POST",
        url: `/v1/admin/games/${id}/${path}`,
        headers: { authorization: "Bearer submit" },
        ...(payload ? { payload } : {})
      });
      expect(regressed.statusCode, path).toBe(409);
      expect(regressed.json().error.code, path).toBe("INVALID_STATE");
    }
  });

  it("enforces upload filename and MIME validation", async () => {
    app = await createApi({ tokens });
    const create = await app.inject({
      method: "POST",
      url: "/v1/admin/games",
      headers: { authorization: "Bearer submit" },
      payload: body
    });
    const id = create.json().id;
    const result = await app.inject({
      method: "POST",
      url: `/v1/admin/games/${id}/packages`,
      headers: { authorization: "Bearer submit" },
      payload: {
        filename: "../evil.pkg",
        sizeBytes: 10,
        sha256: "0".repeat(64),
        mime: "text/plain",
        storageKey: "outside"
      }
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "The request did not pass validation."
    });
  });

  it("rejects duplicate title and content identifiers", async () => {
    app = await createApi({ tokens });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/admin/games",
          headers: { authorization: "Bearer submit" },
          payload: body
        })
      ).statusCode
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/admin/games",
          headers: { authorization: "Bearer submit" },
          payload: body
        })
      ).statusCode
    ).toBe(409);
  });

  it("supports explicit development admin CORS without credentials cookies", async () => {
    app = await createApi({ tokens });
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/admin/games",
      headers: { origin: "http://127.0.0.1:5174" }
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5174");
  });

  it("verifies an external signature before an atomic empty-catalog publication", async () => {
    const repository = new MemoryRepository();
    const pair = generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const now = new Date();
    const manifest: CatalogManifest = {
      schema_version: 1,
      catalog_version: `${now.toISOString().slice(0, 10).replaceAll("-", ".")}.2`,
      catalog_sequence: 1,
      generated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 86400_000).toISOString(),
      minimum_client_version: "0.1.0",
      key_id: "test-production-key",
      channel: "stable",
      games: []
    };
    app = await createApi({
      tokens,
      repository,
      trustedKeys: [{ id: manifest.key_id, publicKeyPem: publicPem }]
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/catalog/publish",
      headers: {
        authorization: "Bearer publisher",
        "idempotency-key": "publish-once"
      },
      payload: { manifest, signature: signCatalog(manifest, privatePem) }
    });
    expect(response.statusCode).toBe(200);
    expect((await repository.getPublishedCatalog()).manifest.catalog_sequence).toBe(1);
    expect((await repository.listAudit()).map((event) => event.action)).toContain(
      "catalog.publish"
    );
  });

  it("does not expose internal exception messages", async () => {
    const repository = new MemoryRepository();
    repository.listSubmissions = async () => {
      throw new Error("postgresql://operator:secret@example.invalid/private");
    };
    app = await createApi({ tokens, repository });
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/games",
      headers: { authorization: "Bearer submit" },
      payload: body
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("operator");
    expect(response.body).not.toContain("secret");
    expect(response.json().error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The server could not complete the request."
    });
  });
});
