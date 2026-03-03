import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { grantAdminRoleForTest, isSqlServerPrimaryForTests, runStatementForTest } from "./helpers/test-db";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4890 + Math.floor(Math.random() * 120);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-mcp-hybrid-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

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
    body: await parseResponseBody(response)
  };
}

async function getJson(endpoint: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "GET",
    headers
  });

  return {
    status: response.status,
    body: await parseResponseBody(response)
  };
}

async function putJson(
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    body: await parseResponseBody(response)
  };
}

function startServer(envVars: NodeJS.ProcessEnv): ChildProcess {
  return spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env: envVars,
    stdio: "pipe"
  });
}

async function seedBudgetForDay(dayKey: string, spentUsd: number): Promise<void> {
  const now = new Date().toISOString();

  if (isSqlServerPrimaryForTests()) {
    await runStatementForTest(
      dbPath,
      `
        IF EXISTS (SELECT 1 FROM mcp_hybrid_budget_daily WHERE day_key = ?)
        BEGIN
          UPDATE mcp_hybrid_budget_daily
          SET spent_usd = ?, updated_at = ?
          WHERE day_key = ?;
        END
        ELSE
        BEGIN
          INSERT INTO mcp_hybrid_budget_daily (day_key, spent_usd, created_at, updated_at)
          VALUES (?, ?, ?, ?);
        END
      `,
      [dayKey, spentUsd, now, dayKey, dayKey, spentUsd, now, now]
    );
    return;
  }

  await runStatementForTest(
    dbPath,
    `
      INSERT INTO mcp_hybrid_budget_daily (day_key, spent_usd, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(day_key) DO UPDATE SET
        spent_usd = excluded.spent_usd,
        updated_at = excluded.updated_at
    `,
    [dayKey, spentUsd, now, now]
  );
}

test("mcp hybrid status + toggles endpoint", async () => {
  const username = `mcp_hybrid_${Date.now()}`;
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_QUEUE_BACKEND: "local",
    MCP_GATEWAY_ENABLED: "true",
    VRAM_SENTINEL_ENABLED: "false",
    REDIS_URL: "redis://127.0.0.1:6390"
  };

  let server: ChildProcess | null = startServer(env);

  try {
    await waitForHealth();

    const register = await postJson(
      "/api/auth/register",
      { username, password: "McpHybridPass123!" },
      { "x-client-platform": "web" }
    );
    assert.equal(register.status, 201);
    const registerBody = register.body as {
      token?: string;
      user?: {
        id?: string;
      };
    };
    const token = registerBody.token;
    const userId = registerBody.user?.id;
    assert.ok(token);
    assert.ok(userId);

    const before = await getJson("/api/mcp/hybrid/status", {
      Authorization: `Bearer ${token}`
    });
    assert.equal(before.status, 200);
    const beforeBody = before.body as {
      providersMeta?: { providersCount?: number };
      providers?: unknown[];
      hybrid?: { toggles?: { localEngineEnabled?: boolean; apiEngineEnabled?: boolean } };
    };
    assert.ok((beforeBody.providersMeta?.providersCount ?? 0) >= 1);
    assert.ok(Array.isArray(beforeBody.providers));
    assert.equal(typeof beforeBody.hybrid?.toggles?.localEngineEnabled, "boolean");
    assert.equal(typeof beforeBody.hybrid?.toggles?.apiEngineEnabled, "boolean");

    const toggleUpdate = await putJson(
      "/api/mcp/hybrid/toggles",
      {
        localEngineEnabled: false,
        apiEngineEnabled: true,
        preferLocalOverApi: false
      },
      {
        Authorization: `Bearer ${token}`
      }
    );
    assert.equal(toggleUpdate.status, 200);
    const toggleUpdateBody = toggleUpdate.body as {
      ok?: boolean;
      runtimeControl?: { enabled?: boolean; action?: string; reason?: string };
    };
    assert.equal(toggleUpdateBody.ok, true);
    assert.equal(toggleUpdateBody.runtimeControl?.enabled, false);
    assert.equal(toggleUpdateBody.runtimeControl?.action, "skipped");
    assert.equal(toggleUpdateBody.runtimeControl?.reason, "disabled_by_env");

    const after = await getJson("/api/mcp/hybrid/status", {
      Authorization: `Bearer ${token}`
    });
    assert.equal(after.status, 200);
    const afterBody = after.body as {
      hybrid?: { toggles?: { localEngineEnabled?: boolean; apiEngineEnabled?: boolean; preferLocalOverApi?: boolean } };
    };
    assert.equal(afterBody.hybrid?.toggles?.localEngineEnabled, false);
    assert.equal(afterBody.hybrid?.toggles?.apiEngineEnabled, true);
    assert.equal(afterBody.hybrid?.toggles?.preferLocalOverApi, false);

    const statusStartedAt = Date.now();
    const budgetStatus = await getJson("/api/mcp/status", {
      Authorization: `Bearer ${token}`
    });
    const statusLatencyMs = Date.now() - statusStartedAt;
    assert.equal(budgetStatus.status, 200);
    assert.ok(statusLatencyMs < 5000);
    const budgetStatusBody = budgetStatus.body as {
      budget?: { day?: string };
      resultBus?: { enabled?: boolean; connected?: boolean; reason?: string };
    };
    assert.equal(budgetStatusBody.resultBus?.enabled, true);
    assert.equal(budgetStatusBody.resultBus?.connected, false);
    assert.equal(typeof budgetStatusBody.resultBus?.reason, "string");
    const budgetDay = String(budgetStatusBody.budget?.day || "");
    assert.ok(budgetDay.length > 0);

    server.kill("SIGTERM");
    await sleep(300);
    await seedBudgetForDay(budgetDay, 2.75);
    server = startServer(env);
    await waitForHealth();

    const afterRestart = await getJson("/api/mcp/hybrid/status", {
      Authorization: `Bearer ${token}`
    });
    assert.equal(afterRestart.status, 200);
    const afterRestartBody = afterRestart.body as {
      hybrid?: { toggles?: { localEngineEnabled?: boolean; apiEngineEnabled?: boolean; preferLocalOverApi?: boolean } };
    };
    assert.equal(afterRestartBody.hybrid?.toggles?.localEngineEnabled, false);
    assert.equal(afterRestartBody.hybrid?.toggles?.apiEngineEnabled, true);
    assert.equal(afterRestartBody.hybrid?.toggles?.preferLocalOverApi, false);

    const budgetAfterRestart = await getJson("/api/mcp/status", {
      Authorization: `Bearer ${token}`
    });
    assert.equal(budgetAfterRestart.status, 200);
    const budgetAfterRestartBody = budgetAfterRestart.body as {
      budget?: { day?: string; spentUsd?: number; remainingUsd?: number; dailyBudgetUsd?: number };
    };
    assert.equal(budgetAfterRestartBody.budget?.day, budgetDay);
    assert.equal(Number(budgetAfterRestartBody.budget?.spentUsd), 2.75);
    assert.equal(
      Number(budgetAfterRestartBody.budget?.remainingUsd),
      Number(Number(budgetAfterRestartBody.budget?.dailyBudgetUsd || 0) - 2.75)
    );

    const forbiddenReset = await postJson(
      "/api/mcp/hybrid/budget/reset",
      {
        reason: "forbidden user should fail"
      },
      {
        Authorization: `Bearer ${token}`
      }
    );
    assert.equal(forbiddenReset.status, 403);

    await grantAdminRoleForTest(dbPath, userId as string);
    const adminLogin = await postJson(
      "/api/auth/login",
      { username, password: "McpHybridPass123!" },
      { "x-client-platform": "web" }
    );
    assert.equal(adminLogin.status, 200);
    const adminToken = (adminLogin.body as { token?: string }).token;
    assert.ok(adminToken);

    const reset = await postJson(
      "/api/mcp/hybrid/budget/reset",
      {
        reason: "integration reset check"
      },
      {
        Authorization: `Bearer ${adminToken}`
      }
    );
    assert.equal(reset.status, 200);
    const resetBody = reset.body as {
      ok?: boolean;
      day?: string;
      previousSpentUsd?: number;
      budget?: { spentUsd?: number };
    };
    assert.equal(resetBody.ok, true);
    assert.equal(resetBody.day, budgetDay);
    assert.equal(Number(resetBody.previousSpentUsd), 2.75);
    assert.equal(Number(resetBody.budget?.spentUsd), 0);

    const afterReset = await getJson("/api/mcp/status", {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(afterReset.status, 200);
    const afterResetBody = afterReset.body as {
      budget?: { day?: string; spentUsd?: number };
    };
    assert.equal(afterResetBody.budget?.day, budgetDay);
    assert.equal(Number(afterResetBody.budget?.spentUsd), 0);
  } finally {
    if (server) {
      server.kill("SIGTERM");
    }
    await sleep(250);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
