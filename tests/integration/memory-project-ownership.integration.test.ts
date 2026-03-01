import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4621;
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-memory-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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

test("memory project writes are owner-scoped", async () => {
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

    const tokenA = await registerUser(`owner_${Date.now()}`, "OwnerPass123!");
    const tokenB = await registerUser(`other_${Date.now()}`, "OtherPass123!");

    const projectCreate = await postJson(
      "/api/projects",
      { name: "Owner Project", description: "Integration project" },
      {
        Authorization: `Bearer ${tokenA}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(projectCreate.status, 201);

    const projectId = (projectCreate.body as { id?: string }).id;
    assert.ok(projectId);

    const ownerMemory = await postJson(
      "/api/memory",
      {
        projectId,
        scope: "project",
        text: "owner memory"
      },
      {
        Authorization: `Bearer ${tokenA}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(ownerMemory.status, 201);

    const forbiddenMemory = await postJson(
      "/api/memory",
      {
        projectId,
        scope: "project",
        text: "cross-user write"
      },
      {
        Authorization: `Bearer ${tokenB}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(forbiddenMemory.status, 403);

    const forbiddenProjectRulesRead = await getJson(`/api/rules/project?projectId=${projectId}`, {
      Authorization: `Bearer ${tokenB}`,
      "x-client-platform": "web"
    });
    assert.equal(forbiddenProjectRulesRead.status, 403);
  } finally {
    server.kill("SIGTERM");
    await sleep(250);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
