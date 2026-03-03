import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4900 + Math.floor(Math.random() * 120);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-mcp-hybrid-jobs-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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

async function waitForHybridDispatchJobTerminal(
  token: string,
  jobId: string,
  timeoutMs = 12_000
): Promise<{ status: string; body: unknown }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await getJson(`/api/mcp/hybrid/jobs/${encodeURIComponent(jobId)}?includeResult=1`, {
      Authorization: `Bearer ${token}`
    });
    assert.equal(response.status, 200);
    const body = response.body as { job?: { status?: string } };
    const status = typeof body.job?.status === "string" ? body.job.status : "unknown";
    if (status === "succeeded" || status === "failed") {
      return { status, body: response.body };
    }
    await sleep(180);
  }

  throw new Error("Timed out waiting for hybrid dispatch job completion");
}

function startServer(envVars: NodeJS.ProcessEnv): ChildProcess {
  return spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env: envVars,
    stdio: "pipe"
  });
}

test("mcp hybrid async jobs: create + poll + ownership", async () => {
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

  const server = startServer(env);
  try {
    await waitForHealth();

    const registerA = await postJson(
      "/api/auth/register",
      { username: `hj1_${Date.now()}`, password: "McpHybridPass123!" },
      { "x-client-platform": "web" }
    );
    assert.equal(registerA.status, 201);
    const tokenA = (registerA.body as { token?: string }).token;
    assert.ok(tokenA);

    const registerB = await postJson(
      "/api/auth/register",
      { username: `hj2_${Date.now()}`, password: "McpHybridPass123!" },
      { "x-client-platform": "web" }
    );
    assert.equal(registerB.status, 201);
    const tokenB = (registerB.body as { token?: string }).token;
    assert.ok(tokenB);

    const createJob = await postJson(
      "/api/mcp/execute",
      {
        tool: "hybrid.dispatch",
        async: true,
        input: {
          category: "GEOMETRY_3D",
          providerId: "api.invalid",
          payload: {
            prompt: "test async job"
          }
        }
      },
      {
        Authorization: `Bearer ${tokenA}`
      }
    );
    assert.equal(createJob.status, 202);
    const createBody = createJob.body as {
      ok?: boolean;
      mode?: string;
      category?: string;
      job?: {
        id?: string;
        status?: string;
        statusEndpoint?: string;
      };
    };
    assert.equal(createBody.ok, true);
    assert.equal(createBody.mode, "async");
    assert.equal(createBody.category, "GEOMETRY_3D");
    assert.ok(typeof createBody.job?.id === "string");
    assert.ok(createBody.job?.status === "queued" || createBody.job?.status === "running");
    assert.equal(createBody.job?.statusEndpoint, `/api/mcp/hybrid/jobs/${createBody.job?.id}`);

    const ownerViewWithoutResult = await getJson(`/api/mcp/hybrid/jobs/${encodeURIComponent(String(createBody.job?.id || ""))}`, {
      Authorization: `Bearer ${tokenA}`
    });
    assert.equal(ownerViewWithoutResult.status, 200);
    const ownerViewWithoutResultBody = ownerViewWithoutResult.body as { job?: { output?: unknown } };
    assert.equal(ownerViewWithoutResultBody.job?.output ?? null, null);

    const terminal = await waitForHybridDispatchJobTerminal(tokenA as string, String(createBody.job?.id || ""));
    assert.equal(terminal.status, "failed");
    const terminalBody = terminal.body as {
      job?: {
        status?: string;
        output?: unknown;
        error?: { code?: string; message?: string };
      };
    };
    assert.equal(terminalBody.job?.status, "failed");
    assert.equal(terminalBody.job?.output ?? null, null);
    assert.equal(terminalBody.job?.error?.code, "dispatch_failed");
    assert.match(String(terminalBody.job?.error?.message || ""), /provider_not_found/i);

    const foreignRead = await getJson(`/api/mcp/hybrid/jobs/${encodeURIComponent(String(createBody.job?.id || ""))}`, {
      Authorization: `Bearer ${tokenB}`
    });
    assert.equal(foreignRead.status, 404);
  } finally {
    server.kill("SIGTERM");
    await sleep(250);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
