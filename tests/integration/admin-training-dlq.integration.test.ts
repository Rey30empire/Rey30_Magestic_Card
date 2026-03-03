import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { grantAdminRoleForTest } from "./helpers/test-db";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4624;
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-admin-dlq-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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

test("admin training DLQ endpoints return 409 when queue backend is local", async () => {
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

    const username = `admin_dlq_${Date.now()}`;
    const password = "AdminDlqPass123!";

    const register = await postJson(
      "/api/auth/register",
      { username, password },
      {
        "x-client-platform": "web"
      }
    );
    assert.equal(register.status, 201);
    const userId = (register.body as { user?: { id?: string } }).user?.id;
    assert.ok(userId);

    await grantAdminRoleForTest(dbPath, userId as string);

    const login = await postJson(
      "/api/auth/login",
      { username, password },
      {
        "x-client-platform": "web"
      }
    );
    assert.equal(login.status, 200);
    const token = (login.body as { token?: string }).token;
    assert.ok(token);

    const dlqList = await getJson("/api/admin/training/dlq", {
      Authorization: `Bearer ${token}`,
      "x-client-platform": "web"
    });
    assert.equal(dlqList.status, 409);

    const queueMetrics = await getJson("/api/admin/training/queue-metrics", {
      Authorization: `Bearer ${token}`,
      "x-client-platform": "web"
    });
    assert.equal(queueMetrics.status, 409);

    const dlqRequeue = await postJson(
      "/api/admin/training/dlq/some-id/requeue",
      {},
      {
        Authorization: `Bearer ${token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(dlqRequeue.status, 409);

    const dlqBatchRequeue = await postJson(
      "/api/admin/training/dlq/requeue-batch",
      {},
      {
        Authorization: `Bearer ${token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(dlqBatchRequeue.status, 409);
  } finally {
    server.kill("SIGTERM");
    await sleep(250);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
