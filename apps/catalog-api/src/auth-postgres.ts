import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Role } from "./model.js";
import {
  type AuthAuditEvent,
  type AuthRepository,
  type AuthSession,
  type AuthSessionContext,
  type AuthUser,
  type BootstrapAdministratorRecord,
  type LoginFailurePolicy
} from "./auth.js";

const roles = new Set<Role>([
  "submitter",
  "reviewer",
  "hardware_tester",
  "publisher",
  "administrator"
]);
const AUDIT_CHAIN_LOCK = "726577864213";

interface UserRow extends QueryResultRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  password_algorithm: string | null;
  status: string;
  session_version: number;
  roles: string[] | null;
  last_login_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SessionRow extends UserRow {
  session_id: string;
  user_id: string;
  token_hash: string;
  csrf_token_hash: string;
  session_session_version: number;
  user_agent_hash: string | null;
  session_created_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
  rotated_from: string | null;
  revoked_at: Date | string | null;
  revocation_reason: string | null;
}

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool) {}

  async bootstrapAdministrator(
    record: BootstrapAdministratorRecord
  ): Promise<AuthUser | null> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [AUDIT_CHAIN_LOCK]);
      const existing = await client.query(
        `SELECT 1
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
          WHERE ur.role = 'administrator'
            AND ur.revoked_at IS NULL
            AND u.deleted_at IS NULL
          LIMIT 1`
      );
      if (existing.rowCount) return null;

      await client.query(
        `INSERT INTO users(
           id, username, display_name, password_hash, password_algorithm, status,
           session_version, last_login_at, created_at, updated_at
         ) VALUES($1,$2,$3,$4,'scrypt','active',$5,$6,$7,$8)`,
        [
          record.user.id,
          record.user.username,
          record.user.displayName,
          record.user.passwordHash,
          record.user.sessionVersion,
          record.user.lastLoginAt,
          record.user.createdAt,
          record.user.updatedAt
        ]
      );
      await client.query(
        `INSERT INTO user_roles(user_id, role, granted_by, granted_at)
         VALUES($1,'administrator',$1,$2)`,
        [record.user.id, record.user.createdAt]
      );
      for (const code of record.recoveryCodes) {
        await client.query(
          `INSERT INTO recovery_codes(
             id, user_id, code_hash, created_at, used_at, revoked_at
           ) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            code.id,
            code.userId,
            code.codeHash,
            code.createdAt,
            code.usedAt,
            code.revokedAt
          ]
        );
      }
      return record.user;
    });
  }

  async findUserByUsername(normalizedUsername: string): Promise<AuthUser | null> {
    return this.queryUser(
      this.pool,
      "lower(u.username) = $1 AND u.deleted_at IS NULL",
      [normalizedUsername]
    );
  }

  async findUserById(userId: string): Promise<AuthUser | null> {
    return this.queryUser(
      this.pool,
      "u.id = $1 AND u.deleted_at IS NULL",
      [userId]
    );
  }

  async createSession(session: AuthSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions(
         id, user_id, token_hash, csrf_token_hash, session_version,
         user_agent_hash, created_at, last_seen_at, expires_at, rotated_from,
         revoked_at, revocation_reason
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        session.id,
        session.userId,
        session.tokenHash,
        session.csrfTokenHash,
        session.sessionVersion,
        session.userAgentHash,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
        session.rotatedFrom,
        session.revokedAt,
        session.revocationReason
      ]
    );
  }

  async findSessionByTokenHash(tokenHash: string): Promise<AuthSessionContext | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT
         s.id AS session_id,
         s.user_id,
         s.token_hash,
         s.csrf_token_hash,
         s.session_version AS session_session_version,
         s.user_agent_hash,
         s.created_at AS session_created_at,
         s.last_seen_at,
         s.expires_at,
         s.rotated_from,
         s.revoked_at,
         s.revocation_reason,
         u.id,
         u.username,
         u.display_name,
         u.password_hash,
         u.password_algorithm,
         u.status,
         u.session_version,
         u.last_login_at,
         u.created_at,
         u.updated_at,
         COALESCE(
           array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL AND ur.revoked_at IS NULL),
           ARRAY[]::text[]
         ) AS roles
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       WHERE s.token_hash = $1
         AND u.deleted_at IS NULL
       GROUP BY s.id, u.id`,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      session: {
        id: row.session_id,
        userId: row.user_id,
        tokenHash: row.token_hash,
        csrfTokenHash: row.csrf_token_hash,
        sessionVersion: Number(row.session_session_version),
        userAgentHash: row.user_agent_hash,
        createdAt: iso(row.session_created_at),
        lastSeenAt: iso(row.last_seen_at),
        expiresAt: iso(row.expires_at),
        rotatedFrom: row.rotated_from,
        revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
        revocationReason: row.revocation_reason
      },
      user: mapUser(row)
    };
  }

  async revokeSession(
    tokenHash: string,
    revokedAt: string,
    reason: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE sessions
          SET revoked_at = $2, revocation_reason = $3
        WHERE token_hash = $1
          AND revoked_at IS NULL`,
      [tokenHash, revokedAt, reason]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async rotateSession(
    previousTokenHash: string,
    replacement: AuthSession,
    rotatedAt: string
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const previous = await client.query<{
        id: string;
        user_id: string;
        expires_at: Date | string;
        revoked_at: Date | string | null;
      }>(
        `SELECT id, user_id, expires_at, revoked_at
           FROM sessions
          WHERE token_hash = $1
          FOR UPDATE`,
        [previousTokenHash]
      );
      const row = previous.rows[0];
      if (
        !row ||
        row.revoked_at ||
        Date.parse(iso(row.expires_at)) <= Date.parse(rotatedAt) ||
        row.user_id !== replacement.userId
      ) {
        return false;
      }
      await client.query(
        `UPDATE sessions
            SET revoked_at = $2, revocation_reason = 'rotated'
          WHERE token_hash = $1`,
        [previousTokenHash, rotatedAt]
      );
      await client.query(
        `INSERT INTO sessions(
           id, user_id, token_hash, csrf_token_hash, session_version,
           user_agent_hash, created_at, last_seen_at, expires_at, rotated_from,
           revoked_at, revocation_reason
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          replacement.id,
          replacement.userId,
          replacement.tokenHash,
          replacement.csrfTokenHash,
          replacement.sessionVersion,
          replacement.userAgentHash,
          replacement.createdAt,
          replacement.lastSeenAt,
          replacement.expiresAt,
          row.id,
          replacement.revokedAt,
          replacement.revocationReason
        ]
      );
      return true;
    });
  }

  async recordLoginSuccess(userId: string, occurredAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE users
          SET last_login_at = $2, updated_at = $2
        WHERE id = $1
          AND deleted_at IS NULL`,
      [userId, occurredAt]
    );
  }

  async recordLoginFailure(
    userId: string,
    occurredAt: string,
    policy: LoginFailurePolicy
  ): Promise<{ attempts: number; locked: boolean }> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);
      const since = new Date(Date.parse(occurredAt) - policy.windowMs).toISOString();
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM audit_events
          WHERE actor_user_id = $1
            AND action = 'auth.login.failed'
            AND occurred_at >= $2`,
        [userId, since]
      );
      const attempts = Number(count.rows[0]?.count ?? 0);
      const locked = attempts >= policy.maximumAttempts;
      if (locked) {
        await client.query(
          `UPDATE users
              SET status = 'locked',
                  session_version = session_version + 1,
                  updated_at = $2
            WHERE id = $1
              AND status = 'active'
              AND deleted_at IS NULL`,
          [userId, occurredAt]
        );
        await client.query(
          `UPDATE sessions
              SET revoked_at = $2, revocation_reason = 'account_locked'
            WHERE user_id = $1
              AND revoked_at IS NULL`,
          [userId, occurredAt]
        );
      }
      return { attempts, locked };
    });
  }

  async consumeAdministratorRecoveryCode(
    normalizedUsername: string,
    codeHash: string,
    replacementPasswordHash: string,
    occurredAt: string
  ): Promise<AuthUser | null> {
    return this.transaction(async (client) => {
      const result = await client.query<{ user_id: string; recovery_id: string }>(
        `SELECT u.id AS user_id, rc.id AS recovery_id
           FROM users u
           JOIN user_roles ur
             ON ur.user_id = u.id
            AND ur.role = 'administrator'
            AND ur.revoked_at IS NULL
           JOIN recovery_codes rc
             ON rc.user_id = u.id
            AND rc.code_hash = $2
            AND rc.used_at IS NULL
            AND rc.revoked_at IS NULL
          WHERE lower(u.username) = $1
            AND u.status <> 'disabled'
            AND u.deleted_at IS NULL
          FOR UPDATE OF u, rc`,
        [normalizedUsername, codeHash]
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        "UPDATE recovery_codes SET used_at = $2 WHERE id = $1 AND used_at IS NULL",
        [row.recovery_id, occurredAt]
      );
      await client.query(
        `UPDATE users
            SET password_hash = $2,
                password_algorithm = 'scrypt',
                status = 'active',
                session_version = session_version + 1,
                updated_at = $3
          WHERE id = $1`,
        [row.user_id, replacementPasswordHash, occurredAt]
      );
      await client.query(
        `UPDATE sessions
            SET revoked_at = $2, revocation_reason = 'account_recovered'
          WHERE user_id = $1
            AND revoked_at IS NULL`,
        [row.user_id, occurredAt]
      );
      return this.queryUser(client, "u.id = $1 AND u.deleted_at IS NULL", [
        row.user_id
      ]);
    });
  }

  async disableUser(userId: string, occurredAt: string): Promise<AuthUser | null> {
    return this.transaction(async (client) => {
      const changed = await client.query(
        `UPDATE users
            SET status = 'disabled',
                session_version = session_version + 1,
                updated_at = $2
          WHERE id = $1
            AND deleted_at IS NULL`,
        [userId, occurredAt]
      );
      if ((changed.rowCount ?? 0) !== 1) return null;
      await client.query(
        `UPDATE sessions
            SET revoked_at = $2, revocation_reason = 'account_disabled'
          WHERE user_id = $1
            AND revoked_at IS NULL`,
        [userId, occurredAt]
      );
      return this.queryUser(client, "u.id = $1 AND u.deleted_at IS NULL", [userId]);
    });
  }

  async writeAudit(event: AuthAuditEvent): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [AUDIT_CHAIN_LOCK]);
      const previous = await client.query<{ event_hash: string }>(
        `SELECT event_hash
           FROM audit_events
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1`
      );
      const previousHash = previous.rows[0]?.event_hash ?? null;
      const eventHash = hashAuditEvent(previousHash, event);
      await client.query(
        `INSERT INTO audit_events(
           id, occurred_at, request_id, actor_user_id, actor_subject, action,
           resource_type, resource_id, details, previous_event_hash, event_hash
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          event.id,
          event.occurredAt,
          event.requestId,
          event.actorUserId,
          event.actorSubject,
          event.action,
          event.resourceType,
          event.resourceId,
          event.details,
          previousHash,
          eventHash
        ]
      );
    });
  }

  private async queryUser(
    client: Queryable,
    whereClause: string,
    values: unknown[]
  ): Promise<AuthUser | null> {
    const result = await client.query<UserRow>(
      `SELECT
         u.id,
         u.username,
         u.display_name,
         u.password_hash,
         u.password_algorithm,
         u.status,
         u.session_version,
         u.last_login_at,
         u.created_at,
         u.updated_at,
         COALESCE(
           array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL AND ur.revoked_at IS NULL),
           ARRAY[]::text[]
         ) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       WHERE ${whereClause}
       GROUP BY u.id
       LIMIT 1`,
      values
    );
    const row = result.rows[0];
    return row ? mapUser(row) : null;
  }

  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapUser(row: UserRow): AuthUser {
  if (
    !["pending", "active", "locked", "disabled"].includes(row.status) ||
    ![null, "scrypt", "argon2id", "external"].includes(row.password_algorithm)
  ) {
    throw new Error("INVALID_AUTH_USER_ROW");
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    passwordAlgorithm: row.password_algorithm as AuthUser["passwordAlgorithm"],
    status: row.status as AuthUser["status"],
    sessionVersion: Number(row.session_version),
    roles: (row.roles ?? []).filter((role): role is Role => roles.has(role as Role)),
    lastLoginAt: row.last_login_at ? iso(row.last_login_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function hashAuditEvent(previousHash: string | null, event: AuthAuditEvent): string {
  const payload = JSON.stringify({
    previousHash,
    id: event.id,
    occurredAt: event.occurredAt,
    requestId: event.requestId,
    actorUserId: event.actorUserId,
    actorSubject: event.actorSubject,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    details: event.details
  });
  return createHash("sha256").update(payload).digest("hex");
}
