import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../../apps/catalog-api/src/app.js";
import {
  AuthService,
  MemoryAuthRepository
} from "../../apps/catalog-api/src/auth.js";

const bootstrapToken = "development-bootstrap-token-with-32-bytes";
const password = "A secure local administrator password 2026!";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("authentication routes", () => {
  it("protects one-time bootstrap and authenticates opaque bearer sessions", async () => {
    const repository = new MemoryAuthRepository();
    const authService = new AuthService(repository);
    app = await createApi({ authService, authBootstrapToken: bootstrapToken });

    const wrongSecret = await app.inject({
      method: "POST",
      url: "/v1/auth/bootstrap",
      headers: { "x-bootstrap-token": "incorrect" },
      payload: {
        username: "admin.user",
        displayName: "Administrator",
        password
      }
    });
    expect(wrongSecret.statusCode).toBe(401);

    const bootstrapped = await app.inject({
      method: "POST",
      url: "/v1/auth/bootstrap",
      headers: { "x-bootstrap-token": bootstrapToken },
      payload: {
        username: "admin.user",
        displayName: "Administrator",
        password
      }
    });
    expect(bootstrapped.statusCode).toBe(201);
    expect(bootstrapped.headers["cache-control"]).toBe("no-store");
    expect(bootstrapped.json().recoveryCodes).toHaveLength(10);
    expect(bootstrapped.json().user.passwordHash).toBeNull();

    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/bootstrap",
      headers: { "x-bootstrap-token": bootstrapToken },
      payload: {
        username: "second.admin",
        displayName: "Second Administrator",
        password
      }
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("BOOTSTRAP_UNAVAILABLE");

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "ADMIN.USER", password }
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["cache-control"]).toBe("no-store");
    const token = login.json().token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const session = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().principal).toMatchObject({
      subject: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      username: "admin.user",
      roles: ["administrator"]
    });

    const audit = await app.inject({
      method: "GET",
      url: "/v1/admin/audit-log",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(audit.statusCode).toBe(200);

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(logout.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/auth/session",
          headers: { authorization: `Bearer ${token}` }
        })
      ).statusCode
    ).toBe(401);
  });

  it("does not expose bootstrap when no out-of-band token is configured", async () => {
    app = await createApi({
      authService: new AuthService(new MemoryAuthRepository())
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/bootstrap",
      payload: {
        username: "admin.user",
        displayName: "Administrator",
        password
      }
    });
    expect(response.statusCode).toBe(404);
  });
});
