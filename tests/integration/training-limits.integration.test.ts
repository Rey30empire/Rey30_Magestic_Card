import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4626;
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-training-limits-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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

async function registerUser(username: string, password: string): Promise<string> {
  const register = await postJson(
    "/api/auth/register",
    {
      username,
      password
    },
    {
      "x-client-platform": "web"
    }
  );
  assert.equal(register.status, 201);
  const token = (register.body as { token?: string }).token;
  assert.ok(token);
  return token as string;
}

test("training jobs enforce per-user and global active limits", async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_QUEUE_BACKEND: "local",
    TRAINING_MAX_ACTIVE_PER_USER: "1",
    TRAINING_MAX_ACTIVE_GLOBAL: "2"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const tokenA = await registerUser(`limit_user_a_${Date.now()}`, "LimitPass123!");
    const tokenB = await registerUser(`limit_user_b_${Date.now()}`, "LimitPass123!");
    const tokenC = await registerUser(`limit_user_c_${Date.now()}`, "LimitPass123!");

    const createA1 = await postJson(
      "/api/training/jobs",
      {
        mode: "profile-tuning",
        config: {
          simulateStepDelayMs: 3000
        }
      },
      {
        Authorization: `Bearer ${tokenA}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(createA1.status, 201);

    const createA2 = await postJson(
      "/api/training/jobs",
      {
        mode: "profile-tuning",
        config: {
          simulateStepDelayMs: 3000
        }
      },
      {
        Authorization: `Bearer ${tokenA}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(createA2.status, 429);
    const createA2Body = createA2.body as { limitScope?: string };
    assert.equal(createA2Body.limitScope, "per-user");

    const createB1 = await postJson(
      "/api/training/jobs",
      {
        mode: "profile-tuning",
        config: {
          simulateStepDelayMs: 3000
        }
      },
      {
        Authorization: `Bearer ${tokenB}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(createB1.status, 201);

    const createC1 = await postJson(
      "/api/training/jobs",
      {
        mode: "profile-tuning",
        config: {
          simulateStepDelayMs: 3000
        }
      },
      {
        Authorization: `Bearer ${tokenC}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(createC1.status, 429);
    const createC1Body = createC1.body as { limitScope?: string };
    assert.equal(createC1Body.limitScope, "global");
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
