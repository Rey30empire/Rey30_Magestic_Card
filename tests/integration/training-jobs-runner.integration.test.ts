import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4622;
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-training-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

type TrainingJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  errorMessage: string | null;
  mode: string;
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

async function registerUser(username: string, password: string): Promise<string> {
  const register = await postJson(
    "/api/auth/register",
    { username, password },
    {
      "x-client-platform": "web"
    }
  );
  assert.equal(register.status, 201);

  const body = register.body as { token?: string };
  assert.ok(body.token);
  return body.token as string;
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

test("training jobs runner completes and supports cancellation", async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_QUEUE_BACKEND: "local"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const token = await registerUser(`trainer_${Date.now()}`, "TrainerPass123!");

    const createSuccessJob = await postJson(
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
    assert.equal(createSuccessJob.status, 201);

    const successJobId = (createSuccessJob.body as { id?: string }).id;
    assert.ok(successJobId);

    const succeeded = await waitForJobStatus(token, successJobId as string, "succeeded");
    assert.equal(succeeded.status, "succeeded");

    const createCancelJob = await postJson(
      "/api/training/jobs",
      {
        mode: "profile-tuning",
        config: {
          simulateStepDelayMs: 2500
        }
      },
      {
        Authorization: `Bearer ${token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(createCancelJob.status, 201);

    const cancelJobId = (createCancelJob.body as { id?: string }).id;
    assert.ok(cancelJobId);

    const cancel = await postJson(
      `/api/training/jobs/${cancelJobId}/cancel`,
      {},
      {
        Authorization: `Bearer ${token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(cancel.status, 200);

    const cancelled = await waitForJobStatus(token, cancelJobId as string, "failed");
    assert.equal(cancelled.status, "failed");
    assert.equal(cancelled.errorMessage, "cancelled by user");
  } finally {
    server.kill("SIGTERM");
    await sleep(250);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
