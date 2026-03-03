import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { grantAdminRoleForTest } from "./helpers/test-db";

const repoRoot = path.resolve(__dirname, "..", "..");
let baseUrl = "";
const dbPath = path.join(os.tmpdir(), `rey30-int-tool-runs-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function allocateTestPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port || port <= 0) {
          reject(new Error("Failed to allocate test port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) {
    return;
  }

  const onExit = new Promise<void>((resolve) => {
    server.once("exit", () => resolve());
  });

  server.kill("SIGTERM");
  await Promise.race([onExit, sleep(1500)]);

  if (server.exitCode === null) {
    server.kill("SIGKILL");
    await Promise.race([onExit, sleep(1000)]);
  }
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
  method: "GET" | "POST",
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method,
    headers: {
      ...headers
    }
  };
  if (method !== "GET") {
    init.headers = {
      "Content-Type": "application/json",
      ...headers
    };
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${endpoint}`, init);
  return {
    status: response.status,
    body: (await response.json()) as unknown
  };
}

test("agent tool run history stores and lists dev-tools executions", async () => {
  const port = await allocateTestPort();
  baseUrl = `http://127.0.0.1:${port}`;

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

    const username = `tool_history_${Date.now()}`;
    const password = "ToolHistoryPass123!";
    const register = await sendJson("POST", "/api/auth/register", { username, password }, { "x-client-platform": "web" });
    assert.equal(register.status, 201);
    const registerBody = register.body as { user?: { id?: string }; token?: string };
    const userId = registerBody.user?.id;
    assert.ok(userId);

    await grantAdminRoleForTest(dbPath, userId as string);

    const login = await sendJson(
      "POST",
      "/api/auth/login",
      { username, password },
      { "x-client-platform": "web" }
    );
    assert.equal(login.status, 200);
    const token = (login.body as { token?: string }).token;
    assert.ok(token);

    const headers = {
      Authorization: `Bearer ${token}`,
      "x-client-platform": "web"
    };

    const createAgent = await sendJson(
      "POST",
      "/api/agents",
      {
        name: "Tool Runner",
        role: "ops",
        detail: "agent for tool history",
        personality: "strict and deterministic",
        lore: "history validation",
        memoryScope: "private"
      },
      headers
    );
    assert.equal(createAgent.status, 201);
    const agentId = (createAgent.body as { id?: string }).id;
    assert.ok(agentId);

    const assignTool = await sendJson(
      "POST",
      `/api/agents/${agentId}/tools`,
      {
        updates: [
          {
            toolKey: "agent.profileEcho",
            allowed: true,
            config: {}
          }
        ]
      },
      headers
    );
    assert.equal(assignTool.status, 200);

    const sandbox = await sendJson("POST", `/api/agents/${agentId}/sandbox-test`, {}, headers);
    assert.equal(sandbox.status, 200);
    const sandboxBody = sandbox.body as { status?: string };
    assert.equal(sandboxBody.status, "passed");

    const runTool = await sendJson(
      "POST",
      "/api/dev-tools/agent.profileEcho/run",
      {
        agentId,
        input: {
          includeStatus: true
        }
      },
      headers
    );
    assert.equal(runTool.status, 200);

    const history = await sendJson("GET", `/api/agents/${agentId}/tool-runs?status=success&limit=20`, {}, headers);
    assert.equal(history.status, 200);
    const historyBody = history.body as {
      agentId: string;
      items: Array<{
        toolKey: string;
        status: string;
        latencyMs: number;
        input: Record<string, unknown>;
      }>;
    };
    assert.equal(historyBody.agentId, agentId);
    assert.ok(Array.isArray(historyBody.items));
    assert.ok(historyBody.items.length >= 1);

    const runItem = historyBody.items.find((item) => item.toolKey === "agent.profileEcho");
    assert.ok(runItem);
    assert.equal(runItem?.status, "success");
    assert.ok((runItem?.latencyMs ?? -1) >= 0);
  } finally {
    await stopServer(server);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
