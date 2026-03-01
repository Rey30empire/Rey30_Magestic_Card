import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4623;
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-ext-worker-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

type TrainingJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

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
  while (Date.now() - started < timeoutMs) {
    const jobs = await getJobs(token);
    const row = jobs.find((job) => job.id === jobId);
    if (row && row.status === target) {
      return row;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for job ${jobId} to become ${target}`);
}

test("training external worker mode processes queued jobs", async () => {
  const commonEnv = {
    ...process.env,
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_RUNNER_MODE: "external",
    TRAINING_QUEUE_BACKEND: "local",
    TRAINING_WORKER_POLL_MS: "100"
  };

  const apiServer: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env: {
      ...commonEnv,
      PORT: String(port)
    },
    stdio: "pipe"
  });

  let worker: ChildProcess | null = null;

  try {
    await waitForHealth();

    worker = spawn("node", ["dist/worker.js"], {
      cwd: repoRoot,
      env: commonEnv,
      stdio: "pipe"
    });

    await sleep(350);

    const username = `ext_worker_${Date.now()}`;
    const register = await postJson(
      "/api/auth/register",
      {
        username,
        password: "ExternalPass123!"
      },
      {
        "x-client-platform": "web"
      }
    );
    assert.equal(register.status, 201);
    const token = (register.body as { token?: string }).token;
    assert.ok(token);

    const create = await postJson(
      "/api/training/jobs",
      {
        mode: "profile-tuning",
        config: {
          simulateStepDelayMs: 120
        }
      },
      {
        Authorization: `Bearer ${token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(create.status, 201);
    const jobId = (create.body as { id?: string }).id;
    assert.ok(jobId);

    const final = await waitForJobStatus(token as string, jobId as string, "succeeded");
    assert.equal(final.status, "succeeded");
  } finally {
    if (worker) {
      worker.kill("SIGTERM");
    }
    apiServer.kill("SIGTERM");

    await sleep(350);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
