import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4760 + Math.floor(Math.random() * 100);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-sensitive-rate-limit-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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

async function sendJson(
  method: "POST" | "PUT",
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
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

test("sensitive rate limit blocks excessive training create requests per user", async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_QUEUE_BACKEND: "local",
    SENSITIVE_RATE_LIMIT_WINDOW_MS: "60000",
    SENSITIVE_RATE_LIMIT_MAX_PER_USER: "2",
    SENSITIVE_RATE_LIMIT_MAX_PER_TOKEN: "200"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const register = await sendJson(
      "POST",
      "/api/auth/register",
      { username: `sensitive_user_${Date.now()}`, password: "SensitivePass123!" },
      { "x-client-platform": "web" }
    );
    assert.equal(register.status, 201);
    const token = (register.body as { token?: string }).token;
    assert.ok(token);

    const headers = {
      Authorization: `Bearer ${token}`,
      "x-client-platform": "web"
    };

    const createOne = await sendJson(
      "PUT",
      "/api/me/ai-config/permissions",
      {
        permissions: {
          readScene: true
        }
      },
      headers
    );
    assert.equal(createOne.status, 200);

    const createTwo = await sendJson(
      "PUT",
      "/api/me/ai-config/permissions",
      {
        permissions: {
          readScene: true
        }
      },
      headers
    );
    assert.equal(createTwo.status, 200);

    const createThree = await sendJson(
      "PUT",
      "/api/me/ai-config/permissions",
      {
        permissions: {
          readScene: true
        }
      },
      headers
    );
    assert.equal(createThree.status, 429);
    const body = createThree.body as { error?: string; limitScope?: string };
    assert.equal(body.limitScope, "user");
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
