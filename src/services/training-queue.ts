import { Queue, Worker } from "bullmq";
import { env } from "../config/env";
import { prepareTrainingJobForRequeue } from "./training-jobs";
import { createTraceId, getTraceContext, runWithTraceContext, withSpan } from "./ops-tracing";

type TrainingQueuePayload = {
  jobId: string;
  traceId?: string;
  requestId?: string;
};

type TrainingDlqPayload = {
  jobId: string;
  queueJobId: string;
  failedAt: string;
  attemptsMade: number;
  maxAttempts: number;
  reason: string;
};

export type TrainingDlqItem = {
  id: string;
  name: string;
  state: string;
  createdAt: string;
  attemptsMade: number;
  payload: TrainingDlqPayload;
};

export const TRAINING_DLQ_STATES = ["waiting", "delayed", "failed", "active", "completed"] as const;
export type TrainingDlqState = (typeof TRAINING_DLQ_STATES)[number];

export type TrainingDlqBatchRequeueResult = {
  requested: number;
  attempted: number;
  requeued: number;
  failed: number;
  requeuedTrainingJobIds: string[];
  failures: Array<{
    dlqJobId: string;
    reason: string;
  }>;
};

export type TrainingQueueCountSnapshot = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
};

export type TrainingQueueMetrics = {
  backend: "redis";
  queueName: string;
  dlqName: string;
  queue: TrainingQueueCountSnapshot;
  dlq: TrainingQueueCountSnapshot;
  timestamp: string;
};

type RedisConnectionOptions = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  maxRetriesPerRequest: null;
};

let queue: Queue | null = null;
let dlq: Queue | null = null;
let worker: Worker | null = null;

function isRedisConfigured(): boolean {
  return Boolean(env.REDIS_URL && env.REDIS_URL.trim().length > 0);
}

export function isRedisTrainingQueueEnabled(): boolean {
  return env.TRAINING_QUEUE_BACKEND === "redis";
}

function ensureRedisReady(): void {
  if (!isRedisTrainingQueueEnabled()) {
    throw new Error("Redis training queue backend is disabled");
  }

  if (!isRedisConfigured()) {
    throw new Error("REDIS_URL is required when TRAINING_QUEUE_BACKEND=redis");
  }
}

function buildRedisConnectionOptions(): RedisConnectionOptions {
  ensureRedisReady();

  const redisUrl = new URL(env.REDIS_URL as string);
  const dbRaw = redisUrl.pathname.replace("/", "");
  const db = dbRaw.length > 0 ? Number(dbRaw) : undefined;

  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || "6379"),
    username: redisUrl.username || undefined,
    password: redisUrl.password || undefined,
    db: Number.isFinite(db) ? db : undefined,
    maxRetriesPerRequest: null
  };
}

function getQueue(): Queue {
  if (queue) {
    return queue;
  }

  queue = new Queue(env.TRAINING_QUEUE_NAME, {
    connection: buildRedisConnectionOptions()
  });

  return queue;
}

function getDlqQueue(): Queue {
  if (dlq) {
    return dlq;
  }

  dlq = new Queue(env.TRAINING_DLQ_NAME, {
    connection: buildRedisConnectionOptions()
  });

  return dlq;
}

function sanitizeQueueNumber(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.trunc(value);
  return Math.min(max, Math.max(min, rounded));
}

async function getQueueCounts(queueInstance: Queue): Promise<TrainingQueueCountSnapshot> {
  const counts = await queueInstance.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused");
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
    paused: counts.paused ?? 0
  };
}

function mapDlqPayload(raw: unknown): TrainingDlqPayload {
  const input = raw as Partial<TrainingDlqPayload> | undefined;
  return {
    jobId: String(input?.jobId ?? ""),
    queueJobId: String(input?.queueJobId ?? ""),
    failedAt: String(input?.failedAt ?? ""),
    attemptsMade: Number.isFinite(Number(input?.attemptsMade)) ? Number(input?.attemptsMade) : 0,
    maxAttempts: Number.isFinite(Number(input?.maxAttempts)) ? Number(input?.maxAttempts) : 0,
    reason: String(input?.reason ?? "unknown")
  };
}

async function pushFailedJobToDlq(job: {
  id: string | number | undefined;
  attemptsMade: number;
  maxAttempts: number;
  data: Partial<TrainingQueuePayload>;
  reason: string;
}): Promise<void> {
  await withSpan(
    {
      name: "queue.dlq.push",
      kind: "queue",
      attributes: {
        queueName: env.TRAINING_DLQ_NAME,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.maxAttempts
      }
    },
    async () => {
      const payload: TrainingDlqPayload = {
        jobId: String(job.data.jobId ?? ""),
        queueJobId: String(job.id ?? ""),
        failedAt: new Date().toISOString(),
        attemptsMade: job.attemptsMade,
        maxAttempts: job.maxAttempts,
        reason: job.reason
      };

      const dlqQueue = getDlqQueue();
      await dlqQueue.add("training.job.failed", payload, {
        jobId: `${payload.queueJobId}:${payload.failedAt}`,
        removeOnComplete: 1000,
        attempts: 1
      });
    }
  );
}

export async function dispatchTrainingJobToQueue(jobId: string): Promise<void> {
  if (!isRedisTrainingQueueEnabled()) {
    return;
  }

  await withSpan(
    {
      name: "queue.dispatch.training.job",
      kind: "queue",
      attributes: {
        queueName: env.TRAINING_QUEUE_NAME,
        trainingJobId: jobId
      }
    },
    async () => {
      const attempts = sanitizeQueueNumber(env.TRAINING_QUEUE_ATTEMPTS, 5, 1, 50);
      const backoffDelay = sanitizeQueueNumber(env.TRAINING_QUEUE_BACKOFF_MS, 1000, 50, 60_000);
      const traceContext = getTraceContext();

      const q = getQueue();
      const queueJobOptions = {
        jobId,
        attempts,
        backoff: {
          type: "exponential" as const,
          delay: backoffDelay
        },
        removeOnComplete: 1000,
        removeOnFail: false
      };
      const payload = {
        jobId,
        traceId: traceContext?.traceId,
        requestId: traceContext?.requestId
      } satisfies TrainingQueuePayload;

      try {
        await q.add("training.job", payload, queueJobOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to enqueue training job";
        if (!(message.includes("Job") && message.includes("already exists"))) {
          throw new Error(`Failed to enqueue training job ${jobId}: ${message}`);
        }

        // Queue dedupe by jobId can happen on retries/recovery. If the old job is terminal,
        // recycle it so the training job can be re-dispatched.
        const existing = await q.getJob(jobId);
        if (!existing) {
          await q.add("training.job", payload, queueJobOptions);
          return;
        }

        const state = await existing.getState();
        if (state === "completed" || state === "failed") {
          await existing.remove();
          await q.add("training.job", payload, queueJobOptions);
          return;
        }

        if (state === "waiting" || state === "delayed" || state === "active") {
          return;
        }

        throw new Error(`Failed to enqueue training job ${jobId}: duplicate jobId in state ${state}`);
      }
    }
  );
}

export async function removeTrainingJobFromQueue(jobId: string): Promise<boolean> {
  if (!isRedisTrainingQueueEnabled()) {
    return false;
  }

  return withSpan(
    {
      name: "queue.remove.training.job",
      kind: "queue",
      attributes: {
        queueName: env.TRAINING_QUEUE_NAME,
        trainingJobId: jobId
      }
    },
    async () => {
      const q = getQueue();
      const queueJob = await q.getJob(jobId);
      if (!queueJob) {
        return false;
      }

      const state = await queueJob.getState();
      if (state === "active" || state === "completed" || state === "failed") {
        return false;
      }

      await queueJob.remove();
      return true;
    }
  );
}

export async function listTrainingDlqJobs(input?: {
  limit?: number;
  offset?: number;
  states?: TrainingDlqState[];
}): Promise<TrainingDlqItem[]> {
  if (!isRedisTrainingQueueEnabled()) {
    return [];
  }

  return withSpan(
    {
      name: "queue.dlq.list",
      kind: "queue",
      attributes: {
        queueName: env.TRAINING_DLQ_NAME
      }
    },
    async () => {
      const limit = sanitizeQueueNumber(input?.limit ?? 50, 50, 1, 500);
      const offset = sanitizeQueueNumber(input?.offset ?? 0, 0, 0, 20_000);
      const start = offset;
      const end = offset + limit - 1;
      const states = input?.states && input.states.length > 0 ? input.states : [...TRAINING_DLQ_STATES];

      const dlqQueue = getDlqQueue();
      const jobs = await dlqQueue.getJobs(states, start, end, true);

      const mapped = await Promise.all(
        jobs.map(async (job) => ({
          id: String(job.id ?? ""),
          name: job.name,
          state: await job.getState(),
          createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : new Date().toISOString(),
          attemptsMade: job.attemptsMade,
          payload: mapDlqPayload(job.data)
        }))
      );

      return mapped;
    }
  );
}

export async function requeueTrainingDlqBatch(input?: {
  limit?: number;
  offset?: number;
  removeOriginal?: boolean;
  states?: TrainingDlqState[];
}): Promise<TrainingDlqBatchRequeueResult> {
  if (!isRedisTrainingQueueEnabled()) {
    throw new Error("Redis training queue backend is disabled");
  }

  const removeOriginal = input?.removeOriginal ?? true;
  const items = await listTrainingDlqJobs({
    limit: input?.limit ?? 20,
    offset: input?.offset ?? 0,
    states: input?.states && input.states.length > 0 ? input.states : ["waiting", "delayed", "failed", "active"]
  });

  const failures: TrainingDlqBatchRequeueResult["failures"] = [];
  const requeuedTrainingJobIds: string[] = [];

  for (const item of items) {
    try {
      const requeued = await requeueTrainingDlqJob(item.id, { removeOriginal });
      requeuedTrainingJobIds.push(requeued.trainingJobId);
    } catch (error) {
      failures.push({
        dlqJobId: item.id,
        reason: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  return {
    requested: items.length,
    attempted: items.length,
    requeued: requeuedTrainingJobIds.length,
    failed: failures.length,
    requeuedTrainingJobIds,
    failures
  };
}

export async function getTrainingQueueMetrics(): Promise<TrainingQueueMetrics> {
  if (!isRedisTrainingQueueEnabled()) {
    throw new Error("Redis training queue backend is disabled");
  }

  return withSpan(
    {
      name: "queue.metrics.read",
      kind: "queue",
      attributes: {
        queueName: env.TRAINING_QUEUE_NAME,
        dlqName: env.TRAINING_DLQ_NAME
      }
    },
    async () => {
      const mainQueue = getQueue();
      const dlqQueue = getDlqQueue();

      const [queueCounts, dlqCounts] = await Promise.all([getQueueCounts(mainQueue), getQueueCounts(dlqQueue)]);

      return {
        backend: "redis",
        queueName: env.TRAINING_QUEUE_NAME,
        dlqName: env.TRAINING_DLQ_NAME,
        queue: queueCounts,
        dlq: dlqCounts,
        timestamp: new Date().toISOString()
      };
    }
  );
}

export async function requeueTrainingDlqJob(
  dlqJobId: string,
  options?: { removeOriginal?: boolean }
): Promise<{ trainingJobId: string; statusBefore: string; statusAfter: string }> {
  if (!isRedisTrainingQueueEnabled()) {
    throw new Error("Redis training queue backend is disabled");
  }

  return withSpan(
    {
      name: "queue.dlq.requeue",
      kind: "queue",
      attributes: {
        queueName: env.TRAINING_DLQ_NAME,
        dlqJobId
      }
    },
    async () => {
      const removeOriginal = options?.removeOriginal ?? true;
      const dlqQueue = getDlqQueue();
      const dlqJob = await dlqQueue.getJob(dlqJobId);
      if (!dlqJob) {
        throw new Error("DLQ job not found");
      }

      const payload = mapDlqPayload(dlqJob.data);
      if (!payload.jobId) {
        throw new Error("Invalid DLQ payload: missing jobId");
      }

      const prepared = await prepareTrainingJobForRequeue(payload.jobId, `job requeued from DLQ (${dlqJobId})`);
      await dispatchTrainingJobToQueue(payload.jobId);

      if (removeOriginal) {
        await dlqJob.remove();
      }

      return {
        trainingJobId: payload.jobId,
        statusBefore: prepared.statusBefore,
        statusAfter: prepared.statusAfter
      };
    }
  );
}

export async function startTrainingQueueConsumer(handler: (jobId: string) => Promise<void>): Promise<void> {
  if (!isRedisTrainingQueueEnabled()) {
    return;
  }

  if (worker) {
    return;
  }

  worker = new Worker(
    env.TRAINING_QUEUE_NAME,
    async (job) => {
      const payload = job.data as Partial<TrainingQueuePayload>;
      if (typeof payload?.jobId !== "string" || payload.jobId.length === 0) {
        throw new Error("Invalid training queue payload");
      }

      const traceId = typeof payload.traceId === "string" && payload.traceId.trim().length > 0 ? payload.traceId : createTraceId();

      await runWithTraceContext(
        {
          traceId,
          requestId: payload.requestId,
          activeSpanId: undefined
        },
        async () =>
          withSpan(
            {
              name: "queue.consume.training.job",
              kind: "queue",
              attributes: {
                queueName: env.TRAINING_QUEUE_NAME,
                trainingJobId: String(payload.jobId ?? ""),
                queueJobId: String(job.id ?? "")
              }
            },
            async () => {
              await handler(payload.jobId as string);
            }
          )
      );
    },
    {
      connection: buildRedisConnectionOptions(),
      concurrency: Math.max(1, env.TRAINING_WORKER_CONCURRENCY)
    }
  );

  worker.on("error", (error) => {
    console.error("[training-queue] worker error", error);
  });

  worker.on("failed", (job, error) => {
    console.error("[training-queue] job failed", {
      jobId: job?.id ?? null,
      reason: error?.message ?? "unknown"
    });

    if (!job) {
      return;
    }

    const maxAttemptsRaw = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
    const maxAttempts = sanitizeQueueNumber(maxAttemptsRaw, 1, 1, 50);
    const exhausted = job.attemptsMade >= maxAttempts;
    if (!exhausted) {
      return;
    }

    void pushFailedJobToDlq({
      id: job.id,
      data: job.data as Partial<TrainingQueuePayload>,
      attemptsMade: job.attemptsMade,
      maxAttempts,
      reason: error?.message ?? "unknown"
    }).catch((dlqError) => {
      console.error("[training-queue] failed to push DLQ payload", dlqError);
    });
  });

  await worker.waitUntilReady();
}

export async function stopTrainingQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }

  if (queue) {
    await queue.close();
    queue = null;
  }

  if (dlq) {
    await dlq.close();
    dlq = null;
  }
}
