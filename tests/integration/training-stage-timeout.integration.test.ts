import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4700 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-training-stage-timeout-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

type TrainingJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  errorMessage: string | null;
  logs: string[];
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

async function waitForFailedJob(token: string, jobId: string, timeoutMs = 20_000): Promise<TrainingJob> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const jobs = await getJobs(token);
    const row = jobs.find((job) => job.id === jobId);
    if (row && row.status === "failed") {
      return row;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for job ${jobId} to fail`);
}

test("training job fails with stage timeout when a step exceeds stage budget", async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_QUEUE_BACKEND: "local",
    TRAINING_STAGE_TIMEOUT_MS: "0"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const username = `stgto_${Date.now()}`;
    const register = await postJson(
      "/api/auth/register",
      { username, password: "StageTimeoutPass123!" },
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
          simulateStepDelayMs: 900,
          stageTimeoutMs: 300
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

    const failed = await waitForFailedJob(token as string, jobId as string);
    assert.equal(failed.errorMessage, "stage timeout");
    const logs = Array.isArray(failed.logs) ? failed.logs.join(" | ") : "";
    assert.ok(logs.includes("stage"), `Expected stage timeout logs, received: ${logs}`);
    assert.ok(logs.includes("timed out"), `Expected timeout logs, received: ${logs}`);
    assert.equal(logs.includes("completed successfully"), false);
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
