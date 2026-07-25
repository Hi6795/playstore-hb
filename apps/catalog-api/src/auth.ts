import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual
} from "node:crypto";
import type { Role } from "./model.js";

export const SCRYPT_PARAMETERS = Object.freeze({
  N: 32_768,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 32,
  maxmem: 64 * 1024 * 1024
});

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,79}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RECOVERY_CODE_PATTERN = /^[A-F0-9]{32}$/;
const INVALID_PASSWORD_HASH = "invalid-password-hash";
const AUTH_ROLES: readonly Role[] = [
  "submitter",
  "reviewer",
  "hardware_tester",
  "publisher",
  "administrator"
];

export type AuthUserStatus = "pending" | "active" | "locked" | "disabled";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string | null;
  passwordAlgorithm: "scrypt" | "argon2id" | "external" | null;
  status: AuthUserStatus;
  sessionVersion: number;
  roles: Role[];
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  tokenHash: string;
  csrfTokenHash: string;
  sessionVersion: number;
  userAgentHash: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  rotatedFrom: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

export interface RecoveryCodeRecord {
  id: string;
  userId: string;
  codeHash: string;
  createdAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export interface AuthAuditEvent {
  id: string;
  occurredAt: string;
  requestId: string;
  actorUserId: string | null;
  actorSubject: string;
  action: string;
  resourceType: "user" | "session" | "authentication";
  resourceId: string;
  details: Record<string, unknown>;
}

export interface AuthSessionContext {
  session: AuthSession;
  user: AuthUser;
}

export interface LoginFailurePolicy {
  maximumAttempts: number;
  windowMs: number;
}

export interface BootstrapAdministratorRecord {
  user: AuthUser;
  recoveryCodes: RecoveryCodeRecord[];
}

export interface AuthRepository {
  bootstrapAdministrator(record: BootstrapAdministratorRecord): Promise<AuthUser | null>;
  findUserByUsername(normalizedUsername: string): Promise<AuthUser | null>;
  findUserById(userId: string): Promise<AuthUser | null>;
  createSession(session: AuthSession): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<AuthSessionContext | null>;
  revokeSession(tokenHash: string, revokedAt: string, reason: string): Promise<boolean>;
  rotateSession(
    previousTokenHash: string,
    replacement: AuthSession,
    rotatedAt: string
  ): Promise<boolean>;
  recordLoginSuccess(userId: string, occurredAt: string): Promise<void>;
  recordLoginFailure(
    userId: string,
    occurredAt: string,
    policy: LoginFailurePolicy
  ): Promise<{ attempts: number; locked: boolean }>;
  consumeAdministratorRecoveryCode(
    normalizedUsername: string,
    codeHash: string,
    replacementPasswordHash: string,
    occurredAt: string
  ): Promise<AuthUser | null>;
  disableUser(userId: string, occurredAt: string): Promise<AuthUser | null>;
  writeAudit(event: AuthAuditEvent): Promise<void>;
}

export interface AuthServiceOptions {
  now?: () => Date;
  sessionTtlMs?: number;
  maximumFailedAttempts?: number;
  failedAttemptWindowMs?: number;
  recoveryCodeCount?: number;
}

export interface BootstrapAdministratorInput {
  username: string;
  displayName: string;
  password: string;
  requestId: string;
}

export interface LoginInput {
  username: string;
  password: string;
  requestId: string;
  userAgent?: string;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  principal: AuthPrincipal;
}

export interface AuthPrincipal {
  userId: string;
  subject: string;
  username: string;
  roles: Role[];
  sessionId: string;
}

export class AuthError extends Error {
  constructor(
    public readonly code:
      | "INVALID_AUTH_INPUT"
      | "BOOTSTRAP_UNAVAILABLE"
      | "AUTHENTICATION_FAILED"
      | "RECOVERY_FAILED"
      | "FORBIDDEN"
      | "NOT_FOUND",
    message: string,
    public readonly statusCode: number,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertNewPassword(password);
  const salt = randomBytes(SCRYPT_PARAMETERS.saltLength);
  const derived = await deriveScrypt(password, salt);
  return [
    "scrypt",
    "v1",
    String(SCRYPT_PARAMETERS.N),
    String(SCRYPT_PARAMETERS.r),
    String(SCRYPT_PARAMETERS.p),
    salt.toString("base64url"),
    derived.toString("base64url")
  ].join("$");
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parsed = parsePasswordHash(encodedHash);
  const passwordForKdf =
    typeof password === "string" && Buffer.byteLength(password, "utf8") <= 1024
      ? password
      : "invalid-password-candidate";
  if (!parsed) {
    const derived = await deriveScrypt(passwordForKdf, Buffer.alloc(SCRYPT_PARAMETERS.saltLength));
    return timingSafeEqual(derived, Buffer.alloc(SCRYPT_PARAMETERS.keyLength)) && false;
  }
  const derived = await deriveScrypt(passwordForKdf, parsed.salt);
  return timingSafeEqual(derived, parsed.digest);
}

export function normalizeUsername(username: string): string {
  return username.normalize("NFKC").trim().toLowerCase();
}

export function hashSessionToken(token: string): string {
  return sha256Hex(`playstore-hb:session:v1:${token}`);
}

export function hashRecoveryCode(code: string): string {
  return sha256Hex(`playstore-hb:recovery:v1:${normalizeRecoveryCode(code)}`);
}

export class AuthService {
  private readonly now: () => Date;
  private readonly sessionTtlMs: number;
  private readonly failurePolicy: LoginFailurePolicy;
  private readonly recoveryCodeCount: number;

  constructor(
    private readonly repository: AuthRepository,
    options: AuthServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.sessionTtlMs = boundedInteger(
      options.sessionTtlMs ?? 8 * 60 * 60 * 1000,
      5 * 60 * 1000,
      7 * 24 * 60 * 60 * 1000,
      "sessionTtlMs"
    );
    this.failurePolicy = {
      maximumAttempts: boundedInteger(
        options.maximumFailedAttempts ?? 5,
        3,
        20,
        "maximumFailedAttempts"
      ),
      windowMs: boundedInteger(
        options.failedAttemptWindowMs ?? 15 * 60 * 1000,
        60_000,
        24 * 60 * 60 * 1000,
        "failedAttemptWindowMs"
      )
    };
    this.recoveryCodeCount = boundedInteger(
      options.recoveryCodeCount ?? 10,
      5,
      20,
      "recoveryCodeCount"
    );
  }

  async bootstrapAdministrator(
    input: BootstrapAdministratorInput
  ): Promise<{ user: AuthUser; recoveryCodes: string[] }> {
    const username = validatedUsername(input.username);
    const displayName = validatedDisplayName(input.displayName);
    assertRequestId(input.requestId);
    const passwordHash = await hashPassword(input.password);
    const now = this.now().toISOString();
    const userId = randomUUID();
    const recoveryCodes = Array.from(
      { length: this.recoveryCodeCount },
      () => generateRecoveryCode()
    );
    const user: AuthUser = {
      id: userId,
      username,
      displayName,
      passwordHash,
      passwordAlgorithm: "scrypt",
      status: "active",
      sessionVersion: 1,
      roles: ["administrator"],
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now
    };
    const stored = await this.repository.bootstrapAdministrator({
      user,
      recoveryCodes: recoveryCodes.map((code) => ({
        id: randomUUID(),
        userId,
        codeHash: hashRecoveryCode(code),
        createdAt: now,
        usedAt: null,
        revokedAt: null
      }))
    });
    if (!stored) {
      throw new AuthError(
        "BOOTSTRAP_UNAVAILABLE",
        "Administrator bootstrap has already been completed.",
        409
      );
    }
    await this.repository.writeAudit({
      id: randomUUID(),
      occurredAt: now,
      requestId: input.requestId,
      actorUserId: stored.id,
      actorSubject: stored.username,
      action: "auth.bootstrap.completed",
      resourceType: "user",
      resourceId: stored.id,
      details: { roles: stored.roles, recoveryCodeCount: recoveryCodes.length }
    });
    return { user: publicUser(stored), recoveryCodes };
  }

  async login(input: LoginInput): Promise<LoginResult> {
    assertRequestId(input.requestId);
    const normalized = normalizeUsername(
      typeof input.username === "string" ? input.username : ""
    );
    const usernameIsValid = USERNAME_PATTERN.test(normalized);
    const user = usernameIsValid
      ? await this.repository.findUserByUsername(normalized)
      : null;
    const passwordValid = await verifyPassword(
      typeof input.password === "string" ? input.password : "",
      user?.passwordHash ?? INVALID_PASSWORD_HASH
    );
    const canLogin =
      Boolean(user) &&
      passwordValid &&
      user!.passwordAlgorithm === "scrypt" &&
      user!.status === "active";

    if (!canLogin) {
      if (user?.status === "active") {
        await this.repository.writeAudit(
          this.auditForAuthenticationFailure(input.requestId, normalized, user, false)
        );
        const failure = await this.repository.recordLoginFailure(
          user.id,
          this.now().toISOString(),
          this.failurePolicy
        );
        if (failure.locked) {
          await this.repository.writeAudit({
            id: randomUUID(),
            occurredAt: this.now().toISOString(),
            requestId: input.requestId,
            actorUserId: user.id,
            actorSubject: user.username,
            action: "auth.account.locked",
            resourceType: "user",
            resourceId: user.id,
            details: { failedAttempts: failure.attempts }
          });
        }
      } else {
        await this.repository.writeAudit(
          this.auditForAuthenticationFailure(
            input.requestId,
            normalized,
            user,
            user?.status === "locked"
          )
        );
      }
      throw new AuthError(
        "AUTHENTICATION_FAILED",
        "Authentication failed.",
        401,
        1000
      );
    }

    const now = this.now();
    await this.repository.recordLoginSuccess(user!.id, now.toISOString());
    const refreshedUser = (await this.repository.findUserById(user!.id)) ?? user!;
    const issued = await this.issueSession(
      refreshedUser,
      now,
      input.userAgent,
      null
    );
    await this.repository.writeAudit({
      id: randomUUID(),
      occurredAt: now.toISOString(),
      requestId: input.requestId,
      actorUserId: refreshedUser.id,
      actorSubject: refreshedUser.username,
      action: "auth.login.succeeded",
      resourceType: "session",
      resourceId: issued.principal.sessionId,
      details: { expiresAt: issued.expiresAt }
    });
    return issued;
  }

  async authenticate(token: string): Promise<AuthPrincipal | null> {
    if (!SESSION_TOKEN_PATTERN.test(token)) return null;
    const context = await this.repository.findSessionByTokenHash(hashSessionToken(token));
    if (!context) return null;
    const nowMs = this.now().getTime();
    if (
      context.session.revokedAt ||
      Date.parse(context.session.expiresAt) <= nowMs ||
      context.user.status !== "active" ||
      context.session.sessionVersion !== context.user.sessionVersion
    ) {
      return null;
    }
    return principalFrom(context);
  }

  async logout(token: string, requestId: string): Promise<boolean> {
    assertRequestId(requestId);
    if (!SESSION_TOKEN_PATTERN.test(token)) return false;
    const tokenHash = hashSessionToken(token);
    const context = await this.repository.findSessionByTokenHash(tokenHash);
    const now = this.now().toISOString();
    const revoked = await this.repository.revokeSession(tokenHash, now, "logout");
    if (revoked && context) {
      await this.repository.writeAudit({
        id: randomUUID(),
        occurredAt: now,
        requestId,
        actorUserId: context.user.id,
        actorSubject: context.user.username,
        action: "auth.logout",
        resourceType: "session",
        resourceId: context.session.id,
        details: {}
      });
    }
    return revoked;
  }

  async rotateSession(
    token: string,
    requestId: string,
    userAgent?: string
  ): Promise<LoginResult> {
    assertRequestId(requestId);
    if (!SESSION_TOKEN_PATTERN.test(token)) {
      throw new AuthError("AUTHENTICATION_FAILED", "Authentication failed.", 401);
    }
    const tokenHash = hashSessionToken(token);
    const context = await this.repository.findSessionByTokenHash(tokenHash);
    if (!context || !(await this.authenticate(token))) {
      throw new AuthError("AUTHENTICATION_FAILED", "Authentication failed.", 401);
    }
    const now = this.now();
    const replacement = createSessionRecord(
      context.user,
      now,
      this.sessionTtlMs,
      context.session.id,
      userAgent
    );
    const rotated = await this.repository.rotateSession(
      tokenHash,
      replacement.session,
      now.toISOString()
    );
    if (!rotated) {
      throw new AuthError("AUTHENTICATION_FAILED", "Authentication failed.", 401);
    }
    const result = {
      token: replacement.token,
      expiresAt: replacement.session.expiresAt,
      principal: principalFrom({ session: replacement.session, user: context.user })
    };
    await this.repository.writeAudit({
      id: randomUUID(),
      occurredAt: now.toISOString(),
      requestId,
      actorUserId: context.user.id,
      actorSubject: context.user.username,
      action: "auth.session.rotated",
      resourceType: "session",
      resourceId: replacement.session.id,
      details: { rotatedFrom: context.session.id, expiresAt: replacement.session.expiresAt }
    });
    return result;
  }

  async recoverAdministrator(input: {
    username: string;
    recoveryCode: string;
    newPassword: string;
    requestId: string;
  }): Promise<void> {
    assertRequestId(input.requestId);
    const normalized = normalizeUsername(input.username);
    const code = normalizeRecoveryCode(input.recoveryCode);
    const passwordHash = await hashPassword(input.newPassword);
    const user = USERNAME_PATTERN.test(normalized)
      ? await this.repository.findUserByUsername(normalized)
      : null;
    const recovered =
      RECOVERY_CODE_PATTERN.test(code) && user?.status !== "disabled"
        ? await this.repository.consumeAdministratorRecoveryCode(
            normalized,
            hashRecoveryCode(code),
            passwordHash,
            this.now().toISOString()
          )
        : null;
    const occurredAt = this.now().toISOString();
    if (!recovered) {
      await this.repository.writeAudit({
        id: randomUUID(),
        occurredAt,
        requestId: input.requestId,
        actorUserId: user?.id ?? null,
        actorSubject: user?.username ?? anonymousSubject(normalized),
        action: "auth.recovery.failed",
        resourceType: "authentication",
        resourceId: user?.id ?? anonymousSubject(normalized),
        details: {}
      });
      throw new AuthError("RECOVERY_FAILED", "Account recovery failed.", 401, 1000);
    }
    await this.repository.writeAudit({
      id: randomUUID(),
      occurredAt,
      requestId: input.requestId,
      actorUserId: recovered.id,
      actorSubject: recovered.username,
      action: "auth.recovery.succeeded",
      resourceType: "user",
      resourceId: recovered.id,
      details: { sessionsRevoked: true }
    });
  }

  async disableAccount(input: {
    administratorToken: string;
    targetUserId: string;
    requestId: string;
  }): Promise<void> {
    assertRequestId(input.requestId);
    const principal = await this.authenticate(input.administratorToken);
    if (!principal || !principal.roles.includes("administrator")) {
      throw new AuthError("FORBIDDEN", "This action is not permitted.", 403);
    }
    if (principal.userId === input.targetUserId) {
      throw new AuthError("FORBIDDEN", "This action is not permitted.", 403);
    }
    const now = this.now().toISOString();
    const disabled = await this.repository.disableUser(input.targetUserId, now);
    if (!disabled) throw new AuthError("NOT_FOUND", "The user does not exist.", 404);
    await this.repository.writeAudit({
      id: randomUUID(),
      occurredAt: now,
      requestId: input.requestId,
      actorUserId: principal.userId,
      actorSubject: principal.subject,
      action: "auth.account.disabled",
      resourceType: "user",
      resourceId: disabled.id,
      details: { sessionsRevoked: true }
    });
  }

  private async issueSession(
    user: AuthUser,
    now: Date,
    userAgent: string | undefined,
    rotatedFrom: string | null
  ): Promise<LoginResult> {
    const created = createSessionRecord(
      user,
      now,
      this.sessionTtlMs,
      rotatedFrom,
      userAgent
    );
    await this.repository.createSession(created.session);
    return {
      token: created.token,
      expiresAt: created.session.expiresAt,
      principal: principalFrom({ session: created.session, user })
    };
  }

  private auditForAuthenticationFailure(
    requestId: string,
    normalizedUsername: string,
    user: AuthUser | null,
    locked: boolean
  ): AuthAuditEvent {
    const occurredAt = this.now().toISOString();
    return {
      id: randomUUID(),
      occurredAt,
      requestId,
      actorUserId: user?.id ?? null,
      actorSubject: user?.username ?? anonymousSubject(normalizedUsername),
      action: "auth.login.failed",
      resourceType: "authentication",
      resourceId: user?.id ?? anonymousSubject(normalizedUsername),
      details: { accountLocked: locked }
    };
  }
}

export class MemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AuthUser>();
  private readonly userIdsByUsername = new Map<string, string>();
  private readonly sessions = new Map<string, AuthSession>();
  private readonly recoveryCodes = new Map<string, RecoveryCodeRecord>();
  private readonly failedAttempts = new Map<string, number[]>();
  private readonly auditEvents: AuthAuditEvent[] = [];

  async bootstrapAdministrator(
    record: BootstrapAdministratorRecord
  ): Promise<AuthUser | null> {
    const administratorExists = [...this.users.values()].some(
      (user) =>
        user.status !== "disabled" &&
        user.roles.includes("administrator")
    );
    if (
      administratorExists ||
      this.userIdsByUsername.has(record.user.username) ||
      record.recoveryCodes.some((recovery) =>
        this.recoveryCodes.has(recovery.codeHash)
      ) ||
      new Set(record.recoveryCodes.map((recovery) => recovery.codeHash)).size !==
        record.recoveryCodes.length
    ) {
      return null;
    }
    this.users.set(record.user.id, cloneUser(record.user));
    this.userIdsByUsername.set(record.user.username, record.user.id);
    for (const recovery of record.recoveryCodes) {
      this.recoveryCodes.set(recovery.codeHash, structuredClone(recovery));
    }
    return cloneUser(record.user);
  }

  async findUserByUsername(normalizedUsername: string): Promise<AuthUser | null> {
    const id = this.userIdsByUsername.get(normalizedUsername);
    return id ? this.findUserById(id) : null;
  }

  async findUserById(userId: string): Promise<AuthUser | null> {
    const user = this.users.get(userId);
    return user ? cloneUser(user) : null;
  }

  async createSession(session: AuthSession): Promise<void> {
    if (this.sessions.has(session.tokenHash)) throw new Error("SESSION_TOKEN_COLLISION");
    this.sessions.set(session.tokenHash, structuredClone(session));
  }

  async findSessionByTokenHash(tokenHash: string): Promise<AuthSessionContext | null> {
    const session = this.sessions.get(tokenHash);
    if (!session) return null;
    const user = this.users.get(session.userId);
    return user
      ? { session: structuredClone(session), user: cloneUser(user) }
      : null;
  }

  async revokeSession(
    tokenHash: string,
    revokedAt: string,
    reason: string
  ): Promise<boolean> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt) return false;
    session.revokedAt = revokedAt;
    session.revocationReason = reason;
    return true;
  }

  async rotateSession(
    previousTokenHash: string,
    replacement: AuthSession,
    rotatedAt: string
  ): Promise<boolean> {
    const previous = this.sessions.get(previousTokenHash);
    if (
      !previous ||
      previous.revokedAt ||
      Date.parse(previous.expiresAt) <= Date.parse(rotatedAt) ||
      this.sessions.has(replacement.tokenHash)
    ) {
      return false;
    }
    previous.revokedAt = rotatedAt;
    previous.revocationReason = "rotated";
    this.sessions.set(replacement.tokenHash, structuredClone(replacement));
    return true;
  }

  async recordLoginSuccess(userId: string, occurredAt: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;
    user.lastLoginAt = occurredAt;
    user.updatedAt = occurredAt;
    this.failedAttempts.delete(userId);
  }

  async recordLoginFailure(
    userId: string,
    occurredAt: string,
    policy: LoginFailurePolicy
  ): Promise<{ attempts: number; locked: boolean }> {
    const now = Date.parse(occurredAt);
    const recent = (this.failedAttempts.get(userId) ?? []).filter(
      (timestamp) => now - timestamp <= policy.windowMs
    );
    recent.push(now);
    this.failedAttempts.set(userId, recent);
    const user = this.users.get(userId);
    const locked = recent.length >= policy.maximumAttempts;
    if (user && locked) {
      user.status = "locked";
      user.sessionVersion += 1;
      user.updatedAt = occurredAt;
      this.revokeAllSessions(userId, occurredAt, "account_locked");
    }
    return { attempts: recent.length, locked };
  }

  async consumeAdministratorRecoveryCode(
    normalizedUsername: string,
    codeHash: string,
    replacementPasswordHash: string,
    occurredAt: string
  ): Promise<AuthUser | null> {
    const userId = this.userIdsByUsername.get(normalizedUsername);
    const user = userId ? this.users.get(userId) : undefined;
    const recovery = this.recoveryCodes.get(codeHash);
    if (
      !user ||
      !user.roles.includes("administrator") ||
      user.status === "disabled" ||
      !recovery ||
      recovery.userId !== user.id ||
      recovery.usedAt ||
      recovery.revokedAt
    ) {
      return null;
    }
    recovery.usedAt = occurredAt;
    user.passwordHash = replacementPasswordHash;
    user.passwordAlgorithm = "scrypt";
    user.status = "active";
    user.sessionVersion += 1;
    user.updatedAt = occurredAt;
    this.failedAttempts.delete(user.id);
    this.revokeAllSessions(user.id, occurredAt, "account_recovered");
    return cloneUser(user);
  }

  async disableUser(userId: string, occurredAt: string): Promise<AuthUser | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    user.status = "disabled";
    user.sessionVersion += 1;
    user.updatedAt = occurredAt;
    this.revokeAllSessions(user.id, occurredAt, "account_disabled");
    return cloneUser(user);
  }

  async writeAudit(event: AuthAuditEvent): Promise<void> {
    this.auditEvents.push(structuredClone(event));
  }

  inspectSessions(): AuthSession[] {
    return [...this.sessions.values()].map((session) => structuredClone(session));
  }

  inspectRecoveryCodes(): RecoveryCodeRecord[] {
    return [...this.recoveryCodes.values()].map((code) => structuredClone(code));
  }

  inspectAuditEvents(): AuthAuditEvent[] {
    return structuredClone(this.auditEvents);
  }

  private revokeAllSessions(userId: string, at: string, reason: string): void {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) {
        session.revokedAt = at;
        session.revocationReason = reason;
      }
    }
  }
}

function createSessionRecord(
  user: AuthUser,
  now: Date,
  ttlMs: number,
  rotatedFrom: string | null,
  userAgent?: string
): { token: string; session: AuthSession } {
  const token = randomBytes(32).toString("base64url");
  const createdAt = now.toISOString();
  const session: AuthSession = {
    id: randomUUID(),
    userId: user.id,
    tokenHash: hashSessionToken(token),
    csrfTokenHash: sha256Hex(randomBytes(32)),
    sessionVersion: user.sessionVersion,
    userAgentHash: userAgent ? sha256Hex(userAgent) : null,
    createdAt,
    lastSeenAt: createdAt,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    rotatedFrom,
    revokedAt: null,
    revocationReason: null
  };
  return { token, session };
}

function principalFrom(context: AuthSessionContext): AuthPrincipal {
  return {
    userId: context.user.id,
    subject: context.user.id,
    username: context.user.username,
    roles: [...new Set(context.user.roles)].filter((role) => AUTH_ROLES.includes(role)).sort(),
    sessionId: context.session.id
  };
}

function publicUser(user: AuthUser): AuthUser {
  return { ...cloneUser(user), passwordHash: null };
}

function cloneUser(user: AuthUser): AuthUser {
  return { ...structuredClone(user), roles: [...user.roles] };
}

function parsePasswordHash(
  encoded: string
): { salt: Buffer; digest: Buffer } | null {
  const parts = encoded.split("$");
  if (
    parts.length !== 7 ||
    parts[0] !== "scrypt" ||
    parts[1] !== "v1" ||
    parts[2] !== String(SCRYPT_PARAMETERS.N) ||
    parts[3] !== String(SCRYPT_PARAMETERS.r) ||
    parts[4] !== String(SCRYPT_PARAMETERS.p) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[5]!) ||
    !/^[A-Za-z0-9_-]{86}$/.test(parts[6]!)
  ) {
    return null;
  }
  const salt = Buffer.from(parts[5]!, "base64url");
  const digest = Buffer.from(parts[6]!, "base64url");
  return salt.length === SCRYPT_PARAMETERS.saltLength &&
    digest.length === SCRYPT_PARAMETERS.keyLength
    ? { salt, digest }
    : null;
}

async function deriveScrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      SCRYPT_PARAMETERS.keyLength,
      {
        N: SCRYPT_PARAMETERS.N,
        r: SCRYPT_PARAMETERS.r,
        p: SCRYPT_PARAMETERS.p,
        maxmem: SCRYPT_PARAMETERS.maxmem
      },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      }
    );
  });
}

function assertNewPassword(password: string): void {
  const bytes = typeof password === "string" ? Buffer.byteLength(password, "utf8") : 0;
  if (bytes < 14 || bytes > 1024) {
    throw new AuthError(
      "INVALID_AUTH_INPUT",
      "The password must contain between 14 and 1024 UTF-8 bytes.",
      400
    );
  }
}

function validatedUsername(username: string): string {
  const normalized = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new AuthError(
      "INVALID_AUTH_INPUT",
      "The username must contain 3 to 80 supported characters.",
      400
    );
  }
  return normalized;
}

function validatedDisplayName(displayName: string): string {
  const normalized = displayName.normalize("NFKC").trim();
  if (normalized.length < 1 || normalized.length > 120) {
    throw new AuthError(
      "INVALID_AUTH_INPUT",
      "The display name must contain 1 to 120 characters.",
      400
    );
  }
  return normalized;
}

function normalizeRecoveryCode(code: string): string {
  return typeof code === "string"
    ? code.normalize("NFKC").replaceAll("-", "").trim().toUpperCase()
    : "";
}

function generateRecoveryCode(): string {
  return randomBytes(16)
    .toString("hex")
    .toUpperCase()
    .match(/.{1,4}/g)!
    .join("-");
}

function assertRequestId(requestId: string): void {
  if (
    typeof requestId !== "string" ||
    requestId.length < 1 ||
    requestId.length > 200 ||
    /[\u0000-\u001F\u007F]/.test(requestId)
  ) {
    throw new AuthError("INVALID_AUTH_INPUT", "A valid request ID is required.", 400);
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside the supported range`);
  }
  return value;
}

function anonymousSubject(normalizedUsername: string): string {
  return `unknown:${sha256Hex(normalizedUsername).slice(0, 16)}`;
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
