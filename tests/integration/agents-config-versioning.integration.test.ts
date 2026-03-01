import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 55350 + Math.floor(Math.random() * 2000);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-agent-versioning-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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
  method: "GET" | "POST" | "PATCH",
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const requestInit: RequestInit = {
    method,
    headers: {
      ...headers
    }
  };

  if (method !== "GET") {
    requestInit.headers = {
      "Content-Type": "application/json",
      ...headers
    };
    requestInit.body = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${endpoint}`, requestInit);
  return {
    status: response.status,
    body: (await response.json()) as unknown
  };
}

test("agents config versioning supports rollback to previous state", async () => {
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

    const register = await sendJson(
      "POST",
      "/api/auth/register",
      {
        username: `agent_versioning_${Date.now()}`,
        password: "AgentVersionPass123!"
      },
      {
        "x-client-platform": "web"
      }
    );
    assert.equal(register.status, 201);
    const token = (register.body as { token?: string }).token;
    assert.ok(token);

    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "x-client-platform": "web"
    };

    const createAgent = await sendJson(
      "POST",
      "/api/agents",
      {
        name: "Sentinel Base",
        role: "guardian",
        detail: "base profile",
        memoryScope: "private"
      },
      authHeaders
    );
    assert.equal(createAgent.status, 201);
    const agentId = (createAgent.body as { id?: string }).id;
    assert.ok(agentId);

    const versionsAfterCreate = await sendJson("GET", `/api/agents/${agentId}/versions?limit=20`, {}, authHeaders);
    assert.equal(versionsAfterCreate.status, 200);
    const versionsCreateBody = versionsAfterCreate.body as {
      latestVersion: number;
      items: Array<{ version: number; reason: string }>;
    };
    assert.ok(versionsCreateBody.latestVersion >= 1);
    assert.ok(versionsCreateBody.items.some((item) => item.version === 1));

    const updateAgent = await sendJson(
      "PATCH",
      `/api/agents/${agentId}`,
      {
        name: "Sentinel Tuned",
        detail: "updated profile"
      },
      authHeaders
    );
    assert.equal(updateAgent.status, 200);

    const connectAgent = await sendJson(
      "POST",
      `/api/agents/${agentId}/connect`,
      {
        provider: "api",
        model: "dummy-local",
        apiKey: "dummy_secret_12345",
        params: {
          temperature: 0.2
        }
      },
      authHeaders
    );
    assert.equal(connectAgent.status, 200);

    const currentAgent = await sendJson("GET", `/api/agents/${agentId}`, {}, authHeaders);
    assert.equal(currentAgent.status, 200);
    const currentAgentBody = currentAgent.body as {
      name: string;
      status: string;
      provider: string | null;
      model: string | null;
      connection: unknown;
    };
    assert.equal(currentAgentBody.name, "Sentinel Tuned");
    assert.equal(currentAgentBody.status, "connected");
    assert.equal(currentAgentBody.provider, "api");
    assert.equal(currentAgentBody.model, "dummy-local");
    assert.ok(currentAgentBody.connection);

    const versionsBeforeRollback = await sendJson("GET", `/api/agents/${agentId}/versions?limit=50`, {}, authHeaders);
    assert.equal(versionsBeforeRollback.status, 200);
    const versionsBeforeBody = versionsBeforeRollback.body as {
      latestVersion: number;
      items: Array<{ version: number; reason: string }>;
    };
    const previousLatest = versionsBeforeBody.latestVersion;
    assert.ok(previousLatest >= 3);

    const rollback = await sendJson(
      "POST",
      `/api/agents/${agentId}/rollback`,
      {
        version: 1,
        note: "restore baseline"
      },
      authHeaders
    );
    assert.equal(rollback.status, 200);
    const rollbackBody = rollback.body as {
      rolledBackToVersion: number;
      newVersion: number;
    };
    assert.equal(rollbackBody.rolledBackToVersion, 1);
    assert.ok(rollbackBody.newVersion > previousLatest);

    const revertedAgent = await sendJson("GET", `/api/agents/${agentId}`, {}, authHeaders);
    assert.equal(revertedAgent.status, 200);
    const revertedBody = revertedAgent.body as {
      name: string;
      detail: string | null;
      status: string;
      provider: string | null;
      model: string | null;
      connection: unknown;
    };
    assert.equal(revertedBody.name, "Sentinel Base");
    assert.equal(revertedBody.detail, "base profile");
    assert.equal(revertedBody.status, "disconnected");
    assert.equal(revertedBody.provider, null);
    assert.equal(revertedBody.model, null);
    assert.equal(revertedBody.connection, null);

    const versionsAfterRollback = await sendJson("GET", `/api/agents/${agentId}/versions?limit=10`, {}, authHeaders);
    assert.equal(versionsAfterRollback.status, 200);
    const versionsAfterBody = versionsAfterRollback.body as {
      latestVersion: number;
      items: Array<{ version: number; reason: string }>;
    };
    assert.equal(versionsAfterBody.latestVersion, rollbackBody.newVersion);
    assert.ok(versionsAfterBody.items[0]?.reason.startsWith("rollback to v1"));
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
