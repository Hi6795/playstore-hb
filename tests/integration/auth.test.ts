import { describe, expect, it } from "vitest";
import {
  AuthError,
  AuthService,
  MemoryAuthRepository,
  SCRYPT_PARAMETERS,
  hashPassword,
  hashRecoveryCode,
  hashSessionToken,
  verifyPassword
} from "../../apps/catalog-api/src/auth.js";

const originalPassword = "A long local administrator password 2026!";
const replacementPassword = "A different local administrator password 2026!";

function authFixture() {
  let now = Date.parse("2026-07-24T12:00:00.000Z");
  const repository = new MemoryAuthRepository();
  const service = new AuthService(repository, {
    now: () => new Date(now),
    sessionTtlMs: 5 * 60 * 1000,
    maximumFailedAttempts: 3,
    failedAttemptWindowMs: 10 * 60 * 1000,
    recoveryCodeCount: 5
  });
  return {
    repository,
    service,
    advance(milliseconds: number) {
      now += milliseconds;
    }
  };
}

async function bootstrap(service: AuthService) {
  return service.bootstrapAdministrator({
    username: " Admin.User ",
    displayName: " Local Administrator ",
    password: originalPassword,
    requestId: "bootstrap-request"
  });
}

function expectAuthError(
  error: unknown,
  code: AuthError["code"]
): void {
  expect(error).toBeInstanceOf(AuthError);
  expect(error).toMatchObject({ code });
}

describe("production local authentication", () => {
  it("uses explicit scrypt parameters, random salts, and constant-time verification", async () => {
    const first = await hashPassword(originalPassword);
    const second = await hashPassword(originalPassword);
    expect(first).not.toBe(second);
    expect(first).toMatch(
      new RegExp(
        `^scrypt\\$v1\\$${SCRYPT_PARAMETERS.N}\\$${SCRYPT_PARAMETERS.r}\\$${SCRYPT_PARAMETERS.p}\\$`
      )
    );
    expect(first).not.toContain(originalPassword);
    await expect(verifyPassword(originalPassword, first)).resolves.toBe(true);
    await expect(verifyPassword("incorrect password", first)).resolves.toBe(false);
    await expect(verifyPassword(originalPassword, "corrupt stored hash")).resolves.toBe(false);
  });

  it("bootstraps exactly one normalized local administrator and hashes recovery codes", async () => {
    const { repository, service } = authFixture();
    const created = await bootstrap(service);
    expect(created.user).toMatchObject({
      username: "admin.user",
      displayName: "Local Administrator",
      passwordHash: null,
      roles: ["administrator"],
      status: "active"
    });
    expect(created.recoveryCodes).toHaveLength(5);
    expect(new Set(created.recoveryCodes).size).toBe(5);

    const storedUser = await repository.findUserByUsername("admin.user");
    expect(storedUser?.passwordHash).toMatch(/^scrypt\$v1\$/);
    const storedRecovery = repository.inspectRecoveryCodes();
    expect(storedRecovery).toHaveLength(5);
    expect(storedRecovery[0]?.codeHash).toBe(hashRecoveryCode(created.recoveryCodes[0]!));
    for (const raw of created.recoveryCodes) {
      expect(JSON.stringify(storedRecovery)).not.toContain(raw);
    }

    await expect(
      service.bootstrapAdministrator({
        username: "second-admin",
        displayName: "Second Administrator",
        password: originalPassword,
        requestId: "second-bootstrap"
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectAuthError(error, "BOOTSTRAP_UNAVAILABLE");
      return true;
    });
  });

  it("logs in with an opaque bearer token and loads normalized roles", async () => {
    const { repository, service } = authFixture();
    await bootstrap(service);
    const login = await service.login({
      username: "ADMIN.USER",
      password: originalPassword,
      requestId: "login-request",
      userAgent: "test-agent/1"
    });
    expect(login.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(login.principal).toMatchObject({
      subject: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      username: "admin.user",
      roles: ["administrator"]
    });
    await expect(service.authenticate(login.token)).resolves.toEqual(login.principal);

    const stored = repository.inspectSessions();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(hashSessionToken(login.token));
    expect(stored[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored[0]?.csrfTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(login.token);
    expect(stored[0]?.userAgentHash).not.toContain("test-agent");
  });

  it("returns rate-friendly generic failures for bad and unknown credentials", async () => {
    const { repository, service } = authFixture();
    await bootstrap(service);
    for (const credentials of [
      { username: "admin.user", password: "wrong password" },
      { username: "unknown.user", password: "wrong password" }
    ]) {
      try {
        await service.login({
          ...credentials,
          requestId: `failure-${credentials.username}`
        });
        throw new Error("Expected authentication failure");
      } catch (error) {
        expectAuthError(error, "AUTHENTICATION_FAILED");
        expect(error).toMatchObject({
          message: "Authentication failed.",
          statusCode: 401,
          retryAfterMs: 1000
        });
      }
    }
    const events = repository.inspectAuditEvents();
    expect(events.filter((event) => event.action === "auth.login.failed")).toHaveLength(2);
    const unknown = events.find((event) => event.actorUserId === null);
    expect(unknown?.actorSubject).toMatch(/^unknown:[a-f0-9]{16}$/);
  });

  it("enforces expiration and logout revocation", async () => {
    const { service, advance } = authFixture();
    await bootstrap(service);
    const expiring = await service.login({
      username: "admin.user",
      password: originalPassword,
      requestId: "expiring-login"
    });
    advance(5 * 60 * 1000 + 1);
    await expect(service.authenticate(expiring.token)).resolves.toBeNull();

    const revocable = await service.login({
      username: "admin.user",
      password: originalPassword,
      requestId: "revocable-login"
    });
    await expect(service.logout(revocable.token, "logout-request")).resolves.toBe(true);
    await expect(service.authenticate(revocable.token)).resolves.toBeNull();
    await expect(service.logout(revocable.token, "logout-replay")).resolves.toBe(false);
  });

  it("rotates bearer sessions and immediately invalidates the previous token", async () => {
    const { repository, service } = authFixture();
    await bootstrap(service);
    const initial = await service.login({
      username: "admin.user",
      password: originalPassword,
      requestId: "initial-login"
    });
    const rotated = await service.rotateSession(
      initial.token,
      "rotation-request",
      "test-agent/2"
    );
    expect(rotated.token).not.toBe(initial.token);
    await expect(service.authenticate(initial.token)).resolves.toBeNull();
    await expect(service.authenticate(rotated.token)).resolves.toEqual(rotated.principal);
    const sessions = repository.inspectSessions();
    expect(sessions.find((session) => session.id === initial.principal.sessionId)).toMatchObject({
      revokedAt: "2026-07-24T12:00:00.000Z",
      revocationReason: "rotated"
    });
    expect(sessions.find((session) => session.id === rotated.principal.sessionId)).toMatchObject({
      rotatedFrom: initial.principal.sessionId,
      revokedAt: null
    });
  });

  it("locks repeated failures and permits only one use of a hashed recovery code", async () => {
    const { repository, service } = authFixture();
    const created = await bootstrap(service);
    const preRecoverySession = await service.login({
      username: "admin.user",
      password: originalPassword,
      requestId: "pre-recovery-login"
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(
        service.login({
          username: "admin.user",
          password: "wrong password",
          requestId: `bad-password-${attempt}`
        })
      ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    }
    await expect(
      service.login({
        username: "admin.user",
        password: originalPassword,
        requestId: "locked-login"
      })
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect((await repository.findUserByUsername("admin.user"))?.status).toBe("locked");
    await expect(service.authenticate(preRecoverySession.token)).resolves.toBeNull();

    const recoveryCode = created.recoveryCodes[0]!;
    await service.recoverAdministrator({
      username: "admin.user",
      recoveryCode,
      newPassword: replacementPassword,
      requestId: "recovery-request"
    });
    expect((await repository.findUserByUsername("admin.user"))?.status).toBe("active");
    await expect(
      service.recoverAdministrator({
        username: "admin.user",
        recoveryCode,
        newPassword: replacementPassword,
        requestId: "recovery-replay"
      })
    ).rejects.toMatchObject({ code: "RECOVERY_FAILED" });

    await expect(
      service.login({
        username: "admin.user",
        password: originalPassword,
        requestId: "old-password-login"
      })
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(
      service.login({
        username: "admin.user",
        password: replacementPassword,
        requestId: "new-password-login"
      })
    ).resolves.toMatchObject({
      principal: {
        subject: expect.any(String),
        username: "admin.user",
        roles: ["administrator"]
      }
    });
    expect(
      repository.inspectRecoveryCodes().find((code) => code.codeHash === hashRecoveryCode(recoveryCode))
        ?.usedAt
    ).toBe("2026-07-24T12:00:00.000Z");
  });

  it("never places raw credentials, session tokens, or recovery codes in audit events", async () => {
    const { repository, service } = authFixture();
    const created = await bootstrap(service);
    const login = await service.login({
      username: "admin.user",
      password: originalPassword,
      requestId: "audit-login"
    });
    await service.logout(login.token, "audit-logout");
    const serialized = JSON.stringify(repository.inspectAuditEvents());
    expect(serialized).not.toContain(originalPassword);
    expect(serialized).not.toContain(login.token);
    for (const code of created.recoveryCodes) {
      expect(serialized).not.toContain(code);
    }
  });
});
