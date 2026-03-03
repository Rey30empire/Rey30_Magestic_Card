import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Queue } from "bullmq";
import test from "node:test";
import { grantAdminRoleForTest } from "./helpers/test-db";

const redisUrl = process.env.REDIS_URL;
const queueSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const trainingQueueName = `training-jobs-it-${queueSuffix}`;
const trainingDlqName = `training-jobs-dlq-it-${queueSuffix}`;

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4625;
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-redis-worker-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
const childStdio: "pipe" | "inherit" = process.env.IT_DEBUG_CHILDREN === "1" ? "inherit" : "pipe";

type TrainingJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

type DlqListResponse = {
  items: Array<{
    id: string;
    payload: {
      jobId: string;
    };
  }>;
};

type QueueMetricsResponse = {
  backend: "redis";
  queueName: string;
  dlqName: string;
  queue: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  };
  dlq: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  };
  alerts: string[];
};

type DlqBatchRequeueResponse = {
  ok: boolean;
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

function parseRedisConnection(url: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  maxRetriesPerRequest: null;
} {
  const parsed = new URL(url);
  const dbRaw = parsed.pathname.replace("/", "");
  const db = dbRaw.length > 0 ? Number(dbRaw) : undefined;

  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number.isFinite(db) ? db : undefined,
    maxRetriesPerRequest: null
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const body = (await response.json()) as { ok?: boolean };
        if (body.ok) {
          return;
        }
      }
    } catch {
      // retry
    }
    await sleep(250);
  }

  throw new Error("Timed out waiting for backend health");
}

async function postJson(
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    body: (await response.json()) as unknown
  };
}

async function getJson(endpoint: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "GET",
    headers
  });

  return {
    status: response.status,
    body: (await response.json()) as unknown
  };
}

async function getJobs(token: string): Promise<TrainingJob[]> {
  const response = await fetch(`${baseUrl}/api/training/jobs`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-client-platform": "web"
    }
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { items?: TrainingJob[] };
  return Array.isArray(body.items) ? body.items : [];
}

async function waitForJobStatus(token: string, jobId: string, target: TrainingJob["status"], timeoutMs = 20_000): Promise<TrainingJob> {
  const started = Date.now();
  let lastStatus = "missing";
  while (Date.now() - started < timeoutMs) {
    const jobs = await getJobs(token);
    const row = jobs.find((job) => job.id === jobId);
    if (row && row.status === target) {
      return row;
    }
    if (row) {
      lastStatus = row.status;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for job ${jobId} to become ${target} (last status: ${lastStatus})`);
}

if (!redisUrl) {
  test("training redis integration requires REDIS_URL", { skip: true }, () => {});
} else {
  test("training external redis mode processes jobs and exposes DLQ admin flows", async () => {
    const commonEnv = {
      ...process.env,
      DB_PATH: dbPath,
      JWT_SECRET: "integration_test_secret",
      TRAINING_RUNNER_MODE: "external",
      TRAINING_QUEUE_BACKEND: "redis",
      TRAINING_QUEUE_NAME: trainingQueueName,
      TRAINING_DLQ_NAME: trainingDlqName,
      TRAINING_QUEUE_ATTEMPTS: "2",
      TRAINING_QUEUE_BACKOFF_MS: "100",
      TRAINING_WORKER_CONCURRENCY: "1",
      REDIS_URL: redisUrl
    };

    const apiServer: ChildProcess = spawn("node", ["dist/index.js"], {
      cwd: repoRoot,
      env: {
        ...commonEnv,
        PORT: String(port)
      },
      stdio: childStdio
    });

    let worker: ChildProcess | null = null;
    let queue: Queue | null = null;
    let dlqQueue: Queue | null = null;

    try {
      await waitForHealth();

      worker = spawn("node", ["dist/worker.js"], {
        cwd: repoRoot,
        env: commonEnv,
        stdio: childStdio
      });

      await sleep(500);

      const username = `redis_user_${Date.now()}`;
      const register = await postJson(
        "/api/auth/register",
        {
          username,
          password: "RedisUserPass123!"
        },
        {
          "x-client-platform": "web"
        }
      );
      assert.equal(register.status, 201);
      const userToken = (register.body as { token?: string }).token;
      assert.ok(userToken);

      const create = await postJson(
        "/api/training/jobs",
        {
          mode: "profile-tuning",
          config: {
            simulateStepDelayMs: 120
          }
        },
        {
          Authorization: `Bearer ${userToken}`,
          "x-client-platform": "web"
        }
      );
      assert.equal(create.status, 201);
      const trainingJobId = (create.body as { id?: string }).id;
      assert.ok(trainingJobId);

      const succeeded = await waitForJobStatus(userToken as string, trainingJobId as string, "succeeded");
      assert.equal(succeeded.status, "succeeded");

      const adminUsername = `redis_admin_${Date.now()}`;
      const adminRegister = await postJson(
        "/api/auth/register",
        {
          username: adminUsername,
          password: "RedisAdminPass123!"
        },
        {
          "x-client-platform": "web"
        }
      );
      assert.equal(adminRegister.status, 201);
      const adminUserId = (adminRegister.body as { user?: { id?: string } }).user?.id;
      assert.ok(adminUserId);
      await grantAdminRoleForTest(dbPath, adminUserId as string);

      const adminLogin = await postJson(
        "/api/auth/login",
        {
          username: adminUsername,
          password: "RedisAdminPass123!"
        },
        {
          "x-client-platform": "web"
        }
      );
      assert.equal(adminLogin.status, 200);
      const adminToken = (adminLogin.body as { token?: string }).token;
      assert.ok(adminToken);

      queue = new Queue(trainingQueueName, {
        connection: parseRedisConnection(redisUrl as string)
      });
      dlqQueue = new Queue(trainingDlqName, {
        connection: parseRedisConnection(redisUrl as string)
      });

      const invalidTrainingJobId = `missing-${Date.now()}`;
      const invalidTrainingJobIdBatch = `missing-batch-${Date.now()}`;
      await queue.add(
        "training.job",
        {
          jobId: invalidTrainingJobId
        },
        {
          jobId: invalidTrainingJobId,
          attempts: 2,
          backoff: {
            type: "exponential",
            delay: 100
          },
          removeOnFail: false
        }
      );
      await queue.add(
        "training.job",
        {
          jobId: invalidTrainingJobIdBatch
        },
        {
          jobId: invalidTrainingJobIdBatch,
          attempts: 2,
          backoff: {
            type: "exponential",
            delay: 100
          },
          removeOnFail: false
        }
      );

      let dlqItem: DlqListResponse["items"][number] | undefined;
      let dlqBatchItem: DlqListResponse["items"][number] | undefined;
      const started = Date.now();
      while (Date.now() - started < 25_000) {
        const dlq = await getJson("/api/admin/training/dlq?limit=50&offset=0", {
          Authorization: `Bearer ${adminToken}`,
          "x-client-platform": "web"
        });

        assert.equal(dlq.status, 200);
        const body = dlq.body as DlqListResponse;
        dlqItem = body.items.find((item) => item.payload.jobId === invalidTrainingJobId);
        dlqBatchItem = body.items.find((item) => item.payload.jobId === invalidTrainingJobIdBatch);
        if (dlqItem && dlqBatchItem) {
          break;
        }

        await sleep(300);
      }

      assert.ok(dlqItem, "Expected invalid job to reach DLQ");
      assert.ok(dlqBatchItem, "Expected second invalid job to reach DLQ");

      const metrics = await getJson("/api/admin/training/queue-metrics", {
        Authorization: `Bearer ${adminToken}`,
        "x-client-platform": "web"
      });
      assert.equal(metrics.status, 200);
      const metricsBody = metrics.body as QueueMetricsResponse;
      assert.equal(metricsBody.backend, "redis");
      assert.equal(metricsBody.queueName, trainingQueueName);
      assert.equal(metricsBody.dlqName, trainingDlqName);
      assert.ok(metricsBody.dlq.waiting + metricsBody.dlq.active + metricsBody.dlq.delayed >= 1);
      assert.ok(Array.isArray(metricsBody.alerts));

      const batchRequeue = await postJson(
        "/api/admin/training/dlq/requeue-batch",
        {
          limit: 50,
          removeOriginal: true,
          states: ["waiting", "delayed", "failed", "active"]
        },
        {
          Authorization: `Bearer ${adminToken}`,
          "x-client-platform": "web"
        }
      );
      assert.equal(batchRequeue.status, 200);
      const batchBody = batchRequeue.body as DlqBatchRequeueResponse;
      assert.equal(batchBody.ok, true);
      assert.ok(batchBody.failed >= 1);
      assert.ok(batchBody.failures.some((item) => item.reason.includes("Training job not found")));

      const createFailedTarget = await postJson(
        "/api/training/jobs",
        {
          mode: "profile-tuning",
          config: {
            simulateStepDelayMs: 120,
            simulateFailAttempts: 1,
            maxRetries: 0
          }
        },
        {
          Authorization: `Bearer ${userToken}`,
          "x-client-platform": "web"
        }
      );
      assert.equal(createFailedTarget.status, 201);
      const dlqRecoveryJobId = (createFailedTarget.body as { id?: string }).id;
      assert.ok(dlqRecoveryJobId);

      await waitForJobStatus(userToken as string, dlqRecoveryJobId as string, "failed", 20_000);

      const seededDlqJob = await dlqQueue.add(
        "training.job.failed",
        {
          jobId: dlqRecoveryJobId,
          queueJobId: `seed-${Date.now()}`,
          failedAt: new Date().toISOString(),
          attemptsMade: 1,
          maxAttempts: 1,
          reason: "seeded for requeue recovery test"
        },
        {
          jobId: `seeded-${dlqRecoveryJobId}-${Date.now()}`,
          attempts: 1,
          removeOnFail: false,
          removeOnComplete: 1000
        }
      );

      const requeue = await postJson(
        `/api/admin/training/dlq/${String(seededDlqJob.id)}/requeue`,
        {
          removeOriginal: true
        },
        {
          Authorization: `Bearer ${adminToken}`,
          "x-client-platform": "web"
        }
      );
      assert.equal(requeue.status, 200);
      const requeueBody = requeue.body as { trainingJobId?: string; statusBefore?: string; statusAfter?: string };
      assert.equal(requeueBody.trainingJobId, dlqRecoveryJobId);
      assert.equal(requeueBody.statusBefore, "failed");
      assert.equal(requeueBody.statusAfter, "queued");

      const recoveredFromDlq = await waitForJobStatus(userToken as string, dlqRecoveryJobId as string, "succeeded", 30_000);
      assert.equal(recoveredFromDlq.status, "succeeded");

      const createRecoveryJob = await postJson(
        "/api/training/jobs",
        {
          mode: "profile-tuning",
          config: {
            simulateStepDelayMs: 2200
          }
        },
        {
          Authorization: `Bearer ${userToken}`,
          "x-client-platform": "web"
        }
      );
      assert.equal(createRecoveryJob.status, 201);
      const restartRecoveryJobId = (createRecoveryJob.body as { id?: string }).id;
      assert.ok(restartRecoveryJobId);

      await waitForJobStatus(userToken as string, restartRecoveryJobId as string, "running", 15_000);

      if (worker) {
        worker.kill("SIGTERM");
        await sleep(750);
      }

      worker = spawn("node", ["dist/worker.js"], {
        cwd: repoRoot,
        env: commonEnv,
        stdio: childStdio
      });
      await sleep(700);

      const recoveredAfterRestart = await waitForJobStatus(userToken as string, restartRecoveryJobId as string, "succeeded", 35_000);
      assert.equal(recoveredAfterRestart.status, "succeeded");
    } finally {
      if (dlqQueue) {
        await dlqQueue.close();
      }
      if (queue) {
        await queue.close();
      }
      if (worker) {
        worker.kill("SIGTERM");
      }
      apiServer.kill("SIGTERM");

      await sleep(400);
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { force: true });
      }
    }
  });
}
