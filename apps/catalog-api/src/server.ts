import type { TrustedKey } from "../../../core/src/signedCatalog.js";
import { isIP } from "node:net";
import { createApi } from "./app.js";
import { PostgresAuthRepository } from "./auth-postgres.js";
import { AuthService, MemoryAuthRepository } from "./auth.js";
import { ReadinessService } from "./readiness.js";
import { MemoryRepository, migrate, PostgresRepository } from "./repository.js";
import { S3MultipartStorage } from "./s3-storage.js";
import { MultipartUploadService, type UploadPolicy } from "./uploads.js";
import { PostgresUploadRepository } from "./uploads-postgres.js";

const production = process.env.NODE_ENV === "production";
const host = process.env.HOST ?? "127.0.0.1";
const port = integerEnvironment("PORT", 8080, 1, 65_535);
const databaseUrl = process.env.DATABASE_URL?.trim();

if (production && !databaseUrl) {
  throw new Error("Production requires DATABASE_URL; in-memory persistence is disabled");
}
if (production && process.env.S3_ALLOW_INSECURE_HTTP === "true") {
  throw new Error("Production forbids S3_ALLOW_INSECURE_HTTP");
}

const repository = databaseUrl
  ? await PostgresRepository.connect(databaseUrl)
  : new MemoryRepository();
if (repository instanceof PostgresRepository) await migrate(repository.pool);

const tokens = jsonEnvironment<Record<string, unknown>>("ADMIN_TOKENS_JSON", {});
if (Object.keys(tokens).length > 0 && production) {
  throw new Error("Production forbids static ADMIN_TOKENS_JSON credentials");
}
const bootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
if (bootstrapToken && Buffer.byteLength(bootstrapToken, "utf8") < 32) {
  throw new Error("ADMIN_BOOTSTRAP_TOKEN must contain at least 32 UTF-8 bytes");
}
const authService = new AuthService(
  repository instanceof PostgresRepository
    ? new PostgresAuthRepository(repository.pool)
    : new MemoryAuthRepository(),
  {
    sessionTtlMs: integerEnvironment(
      "AUTH_SESSION_TTL_SECONDS",
      8 * 60 * 60,
      5 * 60,
      7 * 24 * 60 * 60
    ) * 1000,
    maximumFailedAttempts: integerEnvironment(
      "AUTH_MAXIMUM_FAILED_ATTEMPTS",
      5,
      3,
      20
    ),
    failedAttemptWindowMs: integerEnvironment(
      "AUTH_FAILED_ATTEMPT_WINDOW_SECONDS",
      15 * 60,
      60,
      24 * 60 * 60
    ) * 1000
  }
);

const allowedOrigins = (
  process.env.ADMIN_ORIGINS ?? "http://127.0.0.1:5174,http://localhost:5174"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (production && allowedOrigins.some((origin) => !origin.startsWith("https://"))) {
  throw new Error("Production ADMIN_ORIGINS must contain only HTTPS origins");
}

const trustedKeys = jsonEnvironment<TrustedKey[]>("CATALOG_TRUSTED_KEYS_JSON", []);
const trustedProxies = trustedProxyEnvironment("TRUSTED_PROXY_CIDRS");
const uploadRuntime = createUploadRuntime(repository);
if (production && !uploadRuntime) {
  throw new Error("Production requires configured private S3-compatible quarantine storage");
}
const readiness =
  repository instanceof PostgresRepository && uploadRuntime
    ? new ReadinessService({
        database: async () => {
          await repository.pool.query("SELECT 1");
        },
        quarantineStorage: async () => {
          await uploadRuntime.storage.checkBucket(uploadRuntime.quarantineBucket);
        }
      })
    : undefined;

const app = await createApi({
  repository,
  ...(Object.keys(tokens).length ? { tokens } : {}),
  logger: true,
  allowedOrigins,
  trustedKeys,
  authService,
  ...(trustedProxies.length > 0 ? { trustedProxies } : {}),
  ...(bootstrapToken ? { authBootstrapToken: bootstrapToken } : {}),
  ...(uploadRuntime ? { uploadService: uploadRuntime.service } : {}),
  ...(readiness ? { readiness } : {})
});

let cleanupTimer: NodeJS.Timeout | undefined;
if (uploadRuntime) {
  cleanupTimer = setInterval(
    () => {
      void uploadRuntime.service.cleanupExpired().catch((error: unknown) => {
        app.log.error({ err: error }, "Expired multipart upload cleanup failed");
      });
    },
    integerEnvironment("UPLOAD_CLEANUP_INTERVAL_SECONDS", 900, 60, 86_400) * 1000
  );
  cleanupTimer.unref();
}

app.addHook("onClose", async () => {
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (repository instanceof PostgresRepository) await repository.pool.end();
});

await app.listen({ host, port });

interface UploadRuntime {
  service: MultipartUploadService;
  storage: S3MultipartStorage;
  quarantineBucket: string;
}

function createUploadRuntime(
  selectedRepository: MemoryRepository | PostgresRepository
): UploadRuntime | undefined {
  if (!(selectedRepository instanceof PostgresRepository)) return undefined;
  const configured =
    production ||
    Boolean(
      process.env.S3_ENDPOINT ||
        process.env.S3_ACCESS_KEY_ID ||
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
        process.env.AWS_WEB_IDENTITY_TOKEN_FILE
    );
  if (!configured) return undefined;
  const policy: Partial<UploadPolicy> = {
    quarantineBucket:
      process.env.UPLOAD_QUARANTINE_BUCKET?.trim() || "playstore-hb-quarantine",
    packagePartSizeBytes: integerEnvironment(
      "UPLOAD_PACKAGE_PART_SIZE_BYTES",
      64 * 1024 * 1024,
      5 * 1024 * 1024,
      5 * 1024 * 1024 * 1024
    ),
    maximumParallelParts: integerEnvironment(
      "UPLOAD_MAXIMUM_PARALLEL_PARTS",
      4,
      1,
      4
    ),
    presignedUrlLifetimeSeconds: integerEnvironment(
      "UPLOAD_PRESIGNED_URL_LIFETIME_SECONDS",
      15 * 60,
      60,
      15 * 60
    ),
    abandonedUploadHours: integerEnvironment(
      "UPLOAD_ABANDONED_HOURS",
      24,
      1,
      168
    ),
    maximumPackageSizeBytes: integerEnvironment(
      "UPLOAD_MAXIMUM_PACKAGE_SIZE_BYTES",
      50 * 1024 ** 3,
      1,
      50 * 1024 ** 3
    ),
    maximumMediaSizeBytes: integerEnvironment(
      "UPLOAD_MAXIMUM_MEDIA_SIZE_BYTES",
      512 * 1024 ** 2,
      1,
      2 * 1024 ** 3
    ),
    maximumEvidenceSizeBytes: integerEnvironment(
      "UPLOAD_MAXIMUM_EVIDENCE_SIZE_BYTES",
      100 * 1024 ** 2,
      1,
      2 * 1024 ** 3
    ),
    maximumActivePackageUploads: integerEnvironment(
      "UPLOAD_MAXIMUM_ACTIVE_PACKAGE_UPLOADS",
      3,
      1,
      20
    )
  };
  const storage = S3MultipartStorage.fromEnvironment();
  return {
    service: new MultipartUploadService(
      new PostgresUploadRepository(selectedRepository.pool),
      storage,
      policy
    ),
    storage,
    quarantineBucket: policy.quarantineBucket!
  };
}

function jsonEnvironment<T>(name: string, fallback: T): T {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function trustedProxyEnvironment(name: string): string[] {
  const value = process.env[name]?.trim();
  if (!value) return [];
  return value.split(",").map((entry) => {
    const candidate = entry.trim();
    const [address, prefixText, ...extra] = candidate.split("/");
    const family = isIP(address ?? "");
    if (family === 0 || extra.length > 0) {
      throw new Error(`${name} contains an invalid IP address or CIDR`);
    }
    if (prefixText !== undefined) {
      if (!/^[0-9]+$/.test(prefixText)) {
        throw new Error(`${name} contains an invalid CIDR prefix`);
      }
      const prefix = Number(prefixText);
      const maximum = family === 4 ? 32 : 128;
      if (prefix < 0 || prefix > maximum) {
        throw new Error(`${name} contains an invalid CIDR prefix`);
      }
    }
    return candidate;
  });
}
