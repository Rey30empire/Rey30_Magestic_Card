import { Queue } from "bullmq";
import { env } from "../config/env";

type RedisConnectionOptions = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  maxRetriesPerRequest: number;
  connectTimeout: number;
  commandTimeout: number;
  lazyConnect: boolean;
  enableOfflineQueue: boolean;
  retryStrategy: () => null;
};

type HybridResultEvent = {
  userId: string;
  requestId: string;
  tool: string;
  category: string;
  routeMode: "local" | "api";
  providerId: string;
  estimatedCostUsd: number;
  latencyMs: number;
  createdAt: string;
  payload: unknown;
};

let queue: Queue | null = null;

function isRedisConfigured(): boolean {
  return Boolean(env.REDIS_URL && env.REDIS_URL.trim().length > 0);
}

function normalizeBusTimeoutMs(): number {
  return Math.max(250, env.MCP_HYBRID_RESULT_BUS_TIMEOUT_MS);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function resetQueueConnection(): Promise<void> {
  const current = queue;
  queue = null;
  if (!current) {
    return;
  }

  try {
    await current.close();
  } catch {
    // best effort close
  }
}

function buildRedisConnectionOptions(): RedisConnectionOptions {
  const redisUrl = new URL(env.REDIS_URL as string);
  const dbRaw = redisUrl.pathname.replace("/", "");
  const db = dbRaw.length > 0 ? Number(dbRaw) : undefined;
  const timeoutMs = normalizeBusTimeoutMs();

  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || "6379"),
    username: redisUrl.username || undefined,
    password: redisUrl.password || undefined,
    db: Number.isFinite(db) ? db : undefined,
    maxRetriesPerRequest: 1,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
    lazyConnect: true,
    enableOfflineQueue: false,
    retryStrategy: () => null
  };
}

function getQueue(): Queue | null {
  if (!isRedisConfigured()) {
    return null;
  }

  if (queue) {
    return queue;
  }

  queue = new Queue(env.MCP_HYBRID_RESULTS_QUEUE, {
    connection: buildRedisConnectionOptions()
  });
  return queue;
}

export async function publishHybridResultEvent(input: HybridResultEvent): Promise<{
  enqueued: boolean;
  queueName: string;
  jobId: string | null;
  reason: string | null;
}> {
  const queueName = env.MCP_HYBRID_RESULTS_QUEUE;
  const timeoutMs = normalizeBusTimeoutMs();
  const q = getQueue();
  if (!q) {
    return {
      enqueued: false,
      queueName,
      jobId: null,
      reason: "redis_not_configured"
    };
  }

  try {
    const job = await withTimeout(
      q.add("mcp.hybrid.result", input, {
        removeOnComplete: 500,
        removeOnFail: 1000
      }),
      timeoutMs,
      "hybrid_result_bus.enqueue"
    );
    return {
      enqueued: true,
      queueName,
      jobId: String(job.id ?? ""),
      reason: null
    };
  } catch (error) {
    await resetQueueConnection();
    return {
      enqueued: false,
      queueName,
      jobId: null,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function getHybridResultBusSnapshot(): Promise<{
  enabled: boolean;
  queueName: string;
  connected: boolean;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  } | null;
  reason: string | null;
}> {
  const queueName = env.MCP_HYBRID_RESULTS_QUEUE;
  const timeoutMs = normalizeBusTimeoutMs();
  const q = getQueue();
  if (!q) {
    return {
      enabled: false,
      queueName,
      connected: false,
      counts: null,
      reason: "redis_not_configured"
    };
  }

  try {
    const counts = await withTimeout(
      q.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused"),
      timeoutMs,
      "hybrid_result_bus.snapshot"
    );
    return {
      enabled: true,
      queueName,
      connected: true,
      counts: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        paused: counts.paused ?? 0
      },
      reason: null
    };
  } catch (error) {
    await resetQueueConnection();
    return {
      enabled: true,
      queueName,
      connected: false,
      counts: null,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
