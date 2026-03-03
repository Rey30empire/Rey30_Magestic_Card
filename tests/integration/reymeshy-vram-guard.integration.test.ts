import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4780 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-reymeshy-vram-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
const vramProbeScriptPath = path.join(os.tmpdir(), `reymeshy-vram-probe-${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`);

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

  const parsed = (await response.json()) as unknown;
  return { status: response.status, body: parsed };
}

async function getJson(endpoint: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "GET",
    headers
  });

  const parsed = (await response.json()) as unknown;
  return { status: response.status, body: parsed };
}

function writeVramProbeScript(filePath: string): void {
  const script = `
process.stdout.write("0, GPU-aaaa, NVIDIA GeForce RTX 4090, 24564, 23000, 1564\\n");
`;
  fs.writeFileSync(filePath, script, "utf8");
}

test("reymeshy vram guard blocks cleanup and jobs when constrained", async () => {
  writeVramProbeScript(vramProbeScriptPath);

  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_QUEUE_BACKEND: "local",
    REYMESHY_SIDECAR_ENABLED: "true",
    VRAM_SENTINEL_ENABLED: "true",
    VRAM_SENTINEL_FAIL_OPEN: "false",
    VRAM_SENTINEL_POLL_MS: "100",
    VRAM_SENTINEL_COMMAND_TIMEOUT_MS: "1500",
    VRAM_SENTINEL_COMMAND: "node",
    VRAM_SENTINEL_COMMAND_ARGS: vramProbeScriptPath,
    REYMESHY_VRAM_MAX_USED_MB: "22000",
    REYMESHY_VRAM_MIN_FREE_MB: "1200",
    REYMESHY_VRAM_TASK_RESERVE_MB: "1200"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const username = `reymeshy_vram_${Date.now()}`;
    const register = await postJson(
      "/api/auth/register",
      { username, password: "ReyMeshyPass123!" },
      { "x-client-platform": "web" }
    );
    assert.equal(register.status, 201);
    const token = (register.body as { token?: string }).token;
    assert.ok(token);

    await sleep(250);
    const statusResponse = await getJson("/api/reymeshy/status", {
      Authorization: `Bearer ${token}`
    });
    assert.equal(statusResponse.status, 200);
    const statusBody = statusResponse.body as {
      vram?: {
        enabled?: boolean;
        healthy?: boolean;
        constrained?: boolean;
        reason?: string | null;
      };
    };
    assert.equal(statusBody.vram?.enabled, true);
    assert.equal(statusBody.vram?.healthy, true);
    assert.equal(statusBody.vram?.constrained, true);
    assert.ok((statusBody.vram?.reason ?? "").includes("max_used_mb"));

    const payload = {
      mesh: {
        vertices: [
          0, 0, 0,
          1, 0, 0,
          1, 1, 0,
          0, 1, 0
        ],
        indices: [0, 1, 2, 0, 2, 3],
        uvs: []
      }
    };

    const createJob = await postJson("/api/reymeshy/jobs", payload, {
      Authorization: `Bearer ${token}`
    });
    assert.equal(createJob.status, 503);
    assert.equal((createJob.body as { error?: string }).error, "Feature disabled by VRAM constraints");

    const cleanup = await postJson("/api/reymeshy/cleanup", payload, {
      Authorization: `Bearer ${token}`
    });
    assert.equal(cleanup.status, 503);
    assert.equal((cleanup.body as { error?: string }).error, "Feature disabled by VRAM constraints");
  } finally {
    server.kill("SIGTERM");
    await sleep(250);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
    if (fs.existsSync(vramProbeScriptPath)) {
      fs.rmSync(vramProbeScriptPath, { force: true });
    }
  }
});
