import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { Pool } from "pg";

const postgresUrl = process.env.POSTGRES_URL;
const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4626;
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-training-pg-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

type TrainingJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
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

async function waitForJobStatus(token: string, jobId: string, target: TrainingJob["status"], timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const jobs = await getJobs(token);
    const row = jobs.find((job) => job.id === jobId);
    if (row && row.status === target) {
      return;
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for job ${jobId} to become ${target}`);
}

if (!postgresUrl) {
  test("training postgres mirror integration requires POSTGRES_URL", { skip: true }, () => {});
} else {
  test("training postgres dual-write mirrors training jobs and audit logs", async () => {
    const serverEnv = {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: "integration_test_secret",
      TRAINING_RUNNER_MODE: "inline",
      TRAINING_QUEUE_BACKEND: "local",
      POSTGRES_URL: postgresUrl,
      POSTGRES_DUAL_WRITE: "true",
      POSTGRES_POOL_MAX: "2"
    };

    const server: ChildProcess = spawn("node", ["dist/index.js"], {
      cwd: repoRoot,
      env: serverEnv,
      stdio: "pipe"
    });

    const pgPool = new Pool({
      connectionString: postgresUrl,
      max: 2
    });

    let createdUserId: string | null = null;
    let createdJobId: string | null = null;

    try {
      await waitForHealth();

      const username = `pg_user_${Date.now()}`;
      const register = await postJson(
        "/api/auth/register",
        {
          username,
          password: "PostgresMirrorPass123!"
        },
        {
          "x-client-platform": "web"
        }
      );
      assert.equal(register.status, 201);

      const registerBody = register.body as {
        token?: string;
        user?: {
          id?: string;
        };
      };
      assert.ok(registerBody.token);
      assert.ok(registerBody.user?.id);
      createdUserId = registerBody.user?.id ?? null;

      const create = await postJson(
        "/api/training/jobs",
        {
          mode: "profile-tuning",
          config: {
            simulateStepDelayMs: 120
          }
        },
        {
          Authorization: `Bearer ${registerBody.token}`,
          "x-client-platform": "web"
        }
      );
      assert.equal(create.status, 201);

      const jobBody = create.body as { id?: string };
      assert.ok(jobBody.id);
      createdJobId = jobBody.id ?? null;

      await waitForJobStatus(registerBody.token as string, createdJobId as string, "succeeded");

      const mirroredJob = await pgPool.query<{
        id: string;
        user_id: string;
        status: string;
        platform: string;
      }>(
        `
          SELECT id, user_id, status, platform
          FROM training_jobs_mirror
          WHERE id = $1
        `,
        [createdJobId]
      );

      assert.equal(mirroredJob.rowCount, 1);
      assert.equal(mirroredJob.rows[0].id, createdJobId);
      assert.equal(mirroredJob.rows[0].user_id, createdUserId);
      assert.equal(mirroredJob.rows[0].status, "succeeded");
      assert.equal(mirroredJob.rows[0].platform, "web");

      const mirroredAudit = await pgPool.query<{
        action: string;
        payload: {
          jobId?: string;
        };
      }>(
        `
          SELECT action, payload
          FROM audit_logs_mirror
          WHERE user_id = $1
            AND action = 'training.jobs.create'
          ORDER BY id DESC
          LIMIT 1
        `,
        [createdUserId]
      );

      assert.equal(mirroredAudit.rowCount, 1);
      assert.equal(mirroredAudit.rows[0].action, "training.jobs.create");
      assert.equal(mirroredAudit.rows[0].payload?.jobId, createdJobId);
    } finally {
      if (createdJobId) {
        await pgPool.query("DELETE FROM training_jobs_mirror WHERE id = $1", [createdJobId]);
      }

      if (createdUserId) {
        await pgPool.query("DELETE FROM audit_logs_mirror WHERE user_id = $1", [createdUserId]);
      }

      await pgPool.end();

      server.kill("SIGTERM");
      await sleep(300);
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { force: true });
      }
    }
  });
}
