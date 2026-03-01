import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import sqlite3 from "sqlite3";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 55600 + Math.floor(Math.random() * 2000);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-tool-runs-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

type DbGet = <T>(sql: string, params?: Array<string | number | null>) => Promise<T | undefined>;
type DbRun = (sql: string, params?: Array<string | number | null>) => Promise<void>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openDb(filePath: string): { get: DbGet; run: DbRun; close: () => Promise<void> } {
  const sqlite = sqlite3.verbose();
  const db = new sqlite.Database(filePath);

  const get: DbGet = <T>(sql: string, params: Array<string | number | null> = []) =>
    new Promise<T | undefined>((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row as T | undefined);
      });
    });

  const run: DbRun = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

  const close = () =>
    new Promise<void>((resolve, reject) => {
      db.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

  return { get, run, close };
}

async function grantAdminRole(filePath: string, userId: string): Promise<void> {
  const db = openDb(filePath);
  try {
    const adminRole = await db.get<{ id: string }>("SELECT id FROM roles WHERE key = 'admin'");
    assert.ok(adminRole?.id);
    await db.run(
      `
        INSERT OR IGNORE INTO user_roles (id, user_id, role_id, assigned_by, created_at)
        VALUES (?, ?, ?, NULL, ?)
      `,
      [randomUUID(), userId, adminRole.id, new Date().toISOString()]
    );
    await db.run("UPDATE users SET role = 'admin' WHERE id = ?", [userId]);
  } finally {
    await db.close();
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

    await grantAdminRole(dbPath, userId as string);

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
    server.kill("SIGTERM");
    await sleep(300);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
