import { env } from "../config/env";
import { all, run } from "../db/sqlite";

export type OpsCounters = {
  totalRequests: number;
  cardsConflict409: number;
  marketplaceConflict409: number;
  rateLimited429: number;
  clientErrors4xx: number;
  serverErrors5xx: number;
};

type MinuteBucket = OpsCounters & {
  minuteKey: number;
};

type BootstrapFailure = {
  at: string;
  kind: "secrets_config" | "bootstrap_error";
  message: string;
};

type OpsMinuteMetricRow = {
  minute_key: number;
  bucket_started_at: string;
  total_requests: number;
  cards_conflict_409: number;
  marketplace_conflict_409: number;
  rate_limited_429: number;
  client_errors_4xx: number;
  server_errors_5xx: number;
  updated_at: string;
};

export type OpsMetricHistoryItem = {
  minuteKey: number;
  bucketStartedAt: string;
  counts: OpsCounters;
  updatedAt: string;
};

const startedAt = new Date();
const totals: OpsCounters = {
  totalRequests: 0,
  cardsConflict409: 0,
  marketplaceConflict409: 0,
  rateLimited429: 0,
  clientErrors4xx: 0,
  serverErrors5xx: 0
};
const perMinuteBuckets = new Map<number, MinuteBucket>();
const bootstrapFailures: BootstrapFailure[] = [];
const MAX_MINUTE_BUCKETS = 360;
let persistenceTimer: NodeJS.Timeout | null = null;

function createEmptyCounters(): OpsCounters {
  return {
    totalRequests: 0,
    cardsConflict409: 0,
    marketplaceConflict409: 0,
    rateLimited429: 0,
    clientErrors4xx: 0,
    serverErrors5xx: 0
  };
}

function addCounters(target: OpsCounters, delta: OpsCounters): void {
  target.totalRequests += delta.totalRequests;
  target.cardsConflict409 += delta.cardsConflict409;
  target.marketplaceConflict409 += delta.marketplaceConflict409;
  target.rateLimited429 += delta.rateLimited429;
  target.clientErrors4xx += delta.clientErrors4xx;
  target.serverErrors5xx += delta.serverErrors5xx;
}

function nowMinuteKey(nowMs = Date.now()): number {
  return Math.floor(nowMs / 60_000);
}

function minuteKeyToIso(minuteKey: number): string {
  return new Date(minuteKey * 60_000).toISOString();
}

function getMinuteBucket(minuteKey: number): MinuteBucket {
  const existing = perMinuteBuckets.get(minuteKey);
  if (existing) {
    return existing;
  }

  const bucket: MinuteBucket = {
    minuteKey,
    ...createEmptyCounters()
  };
  perMinuteBuckets.set(minuteKey, bucket);
  return bucket;
}

function pruneMinuteBuckets(currentMinuteKey: number): void {
  const minAllowed = currentMinuteKey - MAX_MINUTE_BUCKETS;
  for (const key of perMinuteBuckets.keys()) {
    if (key < minAllowed) {
      perMinuteBuckets.delete(key);
    }
  }
}

function classifyPathConflictMetric(pathname: string): Pick<OpsCounters, "cardsConflict409" | "marketplaceConflict409"> {
  if (pathname.startsWith("/api/cards")) {
    return { cardsConflict409: 1, marketplaceConflict409: 0 };
  }

  if (pathname.startsWith("/api/marketplace")) {
    return { cardsConflict409: 0, marketplaceConflict409: 1 };
  }

  return { cardsConflict409: 0, marketplaceConflict409: 0 };
}

function mapOpsMinuteMetricRow(row: OpsMinuteMetricRow): OpsMetricHistoryItem {
  return {
    minuteKey: row.minute_key,
    bucketStartedAt: row.bucket_started_at,
    counts: {
      totalRequests: row.total_requests,
      cardsConflict409: row.cards_conflict_409,
      marketplaceConflict409: row.marketplace_conflict_409,
      rateLimited429: row.rate_limited_429,
      clientErrors4xx: row.client_errors_4xx,
      serverErrors5xx: row.server_errors_5xx
    },
    updatedAt: row.updated_at
  };
}

export function recordHttpOutcome(pathname: string, statusCode: number): void {
  const minuteKey = nowMinuteKey();
  pruneMinuteBuckets(minuteKey);

  const delta = createEmptyCounters();
  delta.totalRequests = 1;

  if (statusCode >= 400 && statusCode <= 499) {
    delta.clientErrors4xx = 1;
  }
  if (statusCode >= 500) {
    delta.serverErrors5xx = 1;
  }
  if (statusCode === 409) {
    const conflictMetric = classifyPathConflictMetric(pathname);
    delta.cardsConflict409 = conflictMetric.cardsConflict409;
    delta.marketplaceConflict409 = conflictMetric.marketplaceConflict409;
  }
  if (statusCode === 429) {
    delta.rateLimited429 = 1;
  }

  addCounters(totals, delta);

  const bucket = getMinuteBucket(minuteKey);
  addCounters(bucket, delta);
}

export async function persistOpsMetricsToStorage(): Promise<number> {
  const currentMinute = nowMinuteKey();
  pruneMinuteBuckets(currentMinute);

  let persisted = 0;
  const nowIso = new Date().toISOString();
  for (const bucket of perMinuteBuckets.values()) {
    await run(
      `
        INSERT INTO ops_http_minute_metrics (
          minute_key, bucket_started_at, total_requests, cards_conflict_409, marketplace_conflict_409,
          rate_limited_429, client_errors_4xx, server_errors_5xx, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(minute_key) DO UPDATE SET
          total_requests = excluded.total_requests,
          cards_conflict_409 = excluded.cards_conflict_409,
          marketplace_conflict_409 = excluded.marketplace_conflict_409,
          rate_limited_429 = excluded.rate_limited_429,
          client_errors_4xx = excluded.client_errors_4xx,
          server_errors_5xx = excluded.server_errors_5xx,
          updated_at = excluded.updated_at
      `,
      [
        bucket.minuteKey,
        minuteKeyToIso(bucket.minuteKey),
        bucket.totalRequests,
        bucket.cardsConflict409,
        bucket.marketplaceConflict409,
        bucket.rateLimited429,
        bucket.clientErrors4xx,
        bucket.serverErrors5xx,
        nowIso
      ]
    );
    persisted += 1;
  }

  return persisted;
}

export async function listOpsMetricsHistory(input?: { minutes?: number; limit?: number }): Promise<OpsMetricHistoryItem[]> {
  const minutes = Math.max(1, Math.min(360, Math.trunc(input?.minutes ?? 60)));
  const limit = Math.max(1, Math.min(1000, Math.trunc(input?.limit ?? minutes)));
  const minMinuteKey = nowMinuteKey() - minutes + 1;
  const rows = await all<OpsMinuteMetricRow>(
    `
      SELECT
        minute_key,
        bucket_started_at,
        total_requests,
        cards_conflict_409,
        marketplace_conflict_409,
        rate_limited_429,
        client_errors_4xx,
        server_errors_5xx,
        updated_at
      FROM ops_http_minute_metrics
      WHERE minute_key >= ?
      ORDER BY minute_key DESC
      LIMIT ?
    `,
    [minMinuteKey, limit]
  );

  return rows.map(mapOpsMinuteMetricRow);
}

export function startOpsMetricsPersistence(): void {
  if (persistenceTimer) {
    return;
  }

  const flushMs = Math.max(5000, Math.trunc(env.OPS_METRICS_FLUSH_MS));
  persistenceTimer = setInterval(() => {
    void persistOpsMetricsToStorage().catch((error) => {
      console.error("[ops.metrics.persist.failed]", error);
    });
  }, flushMs);

  persistenceTimer.unref?.();
}

export async function stopOpsMetricsPersistence(): Promise<void> {
  if (persistenceTimer) {
    clearInterval(persistenceTimer);
    persistenceTimer = null;
  }

  await persistOpsMetricsToStorage().catch((error) => {
    console.error("[ops.metrics.persist.failed]", error);
  });
}

export function recordBootstrapFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const kind: BootstrapFailure["kind"] =
    message.includes("JWT_SECRET") || message.includes("VAULT_SECRET") ? "secrets_config" : "bootstrap_error";

  bootstrapFailures.push({
    at: new Date().toISOString(),
    kind,
    message
  });

  if (bootstrapFailures.length > 20) {
    bootstrapFailures.splice(0, bootstrapFailures.length - 20);
  }

  console.error("[ops.bootstrap.failure]", { kind, message });
}

export function getOpsMetricsSnapshot(windowMinutes = 15): {
  startedAt: string;
  timestamp: string;
  uptimeSeconds: number;
  totals: OpsCounters;
  window: {
    minutes: number;
    counts: OpsCounters;
  };
  bootstrapFailures: BootstrapFailure[];
} {
  const safeWindow = Math.max(1, Math.min(180, Math.trunc(windowMinutes)));
  const currentMinute = nowMinuteKey();
  const minMinute = currentMinute - safeWindow + 1;
  const windowCounters = createEmptyCounters();

  for (const [minuteKey, bucket] of perMinuteBuckets.entries()) {
    if (minuteKey < minMinute) {
      continue;
    }

    addCounters(windowCounters, bucket);
  }

  return {
    startedAt: startedAt.toISOString(),
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)),
    totals: { ...totals },
    window: {
      minutes: safeWindow,
      counts: windowCounters
    },
    bootstrapFailures: [...bootstrapFailures]
  };
}
