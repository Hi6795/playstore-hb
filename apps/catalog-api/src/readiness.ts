export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, { ready: boolean; durationMs: number }>;
}

export type ReadinessProbe = () => Promise<void>;

export class ReadinessService {
  constructor(
    private readonly probes: Readonly<Record<string, ReadinessProbe>>,
    private readonly timeoutMs = 3_000
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new Error("Readiness timeout must be between 100 and 30000 milliseconds");
    }
    if (Object.keys(probes).length === 0) {
      throw new Error("At least one readiness probe is required");
    }
  }

  async check(): Promise<ReadinessResult> {
    const entries = await Promise.all(
      Object.entries(this.probes).map(async ([name, probe]) => {
        const startedAt = performance.now();
        let ready = false;
        try {
          await withTimeout(probe(), this.timeoutMs);
          ready = true;
        } catch {
          ready = false;
        }
        return [
          name,
          {
            ready,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt))
          }
        ] as const;
      })
    );
    const checks = Object.fromEntries(entries);
    return {
      ready: Object.values(checks).every((check) => check.ready),
      checks
    };
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("READINESS_TIMEOUT")), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
