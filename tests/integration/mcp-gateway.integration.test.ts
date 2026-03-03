import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4810 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
const sidecarPath = path.join(os.tmpdir(), `reymeshy-fake-mcp-sidecar-${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`);

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

function writeFakeSidecarScript(filePath: string): void {
  const script = `
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let mesh;
  try {
    mesh = JSON.parse(raw || "{}");
  } catch {
    console.error("invalid_json");
    process.exit(2);
    return;
  }

  const vertices = Array.isArray(mesh.vertices) ? mesh.vertices : [];
  const indices = Array.isArray(mesh.indices) ? mesh.indices : [];
  const vertexCount = Math.floor(vertices.length / 3);
  const triangleCount = Math.floor(indices.length / 3);
  const lodTriangleCount = Math.max(1, Math.floor(triangleCount * 0.5));
  const lodIndices = indices.slice(0, lodTriangleCount * 3);
  const uvs = Array.isArray(mesh.uvs) && mesh.uvs.length > 0 ? mesh.uvs : Array.from({ length: vertexCount * 2 }, () => 0);

  setTimeout(() => {
    const output = {
      remeshed: { vertices, indices, uvs },
      uv_unwrapped: { vertices, indices, uvs },
      lod_optimized: { vertices, indices: lodIndices, uvs }
    };
    process.stdout.write(JSON.stringify(output));
  }, 120);
});
`;
  fs.writeFileSync(filePath, script, "utf8");
}

async function waitForJobDone(token: string, jobId: string, timeoutMs = 15_000): Promise<{ status: string; body: unknown }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await getJson(`/api/reymeshy/jobs/${jobId}`, {
      Authorization: `Bearer ${token}`
    });
    assert.equal(current.status, 200);
    const body = current.body as { job?: { status?: string } };
    const status = body.job?.status ?? "unknown";
    if (status === "succeeded" || status === "failed") {
      return { status, body: current.body };
    }
    await sleep(120);
  }

  throw new Error("Timed out waiting for job completion");
}

test("mcp gateway execute routes reymeshy and enforces tool toggles", async () => {
  writeFakeSidecarScript(sidecarPath);

  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_QUEUE_BACKEND: "local",
    REYMESHY_SIDECAR_ENABLED: "true",
    REYMESHY_SIDECAR_EXECUTABLE: "node",
    REYMESHY_SIDECAR_ARGS: sidecarPath,
    REYMESHY_SIDECAR_TIMEOUT_MS: "8000",
    MCP_GATEWAY_ENABLED: "true",
    MCP_TOOL_REYMESHY_ENABLED: "true",
    MCP_TOOL_OLLAMA_ENABLED: "false",
    MCP_TOOL_INSTANTMESH_ENABLED: "false",
    VRAM_SENTINEL_ENABLED: "false"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const register = await postJson(
      "/api/auth/register",
      { username: `mcp_gateway_${Date.now()}`, password: "McpPass123!" },
      { "x-client-platform": "web" }
    );
    assert.equal(register.status, 201);
    const token = (register.body as { token?: string }).token;
    assert.ok(token);

    const mcpStatus = await getJson("/api/mcp/status", {
      Authorization: `Bearer ${token}`
    });
    assert.equal(mcpStatus.status, 200);
    const mcpStatusBody = mcpStatus.body as {
      enabledByServer?: boolean;
      tools?: { reymeshyCleanup?: boolean; ollamaGenerate?: boolean };
    };
    assert.equal(mcpStatusBody.enabledByServer, true);
    assert.equal(mcpStatusBody.tools?.reymeshyCleanup, true);
    assert.equal(mcpStatusBody.tools?.ollamaGenerate, false);

    const meshPayload = {
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

    const executeAsync = await postJson(
      "/api/mcp/execute",
      {
        tool: "reymeshy.cleanup",
        async: true,
        input: meshPayload
      },
      {
        Authorization: `Bearer ${token}`
      }
    );
    assert.equal(executeAsync.status, 202);
    const asyncBody = executeAsync.body as {
      ok?: boolean;
      mode?: string;
      job?: { id?: string; statusEndpoint?: string };
    };
    assert.equal(asyncBody.ok, true);
    assert.equal(asyncBody.mode, "async");
    assert.ok(typeof asyncBody.job?.id === "string");
    assert.equal(asyncBody.job?.statusEndpoint, `/api/reymeshy/jobs/${asyncBody.job?.id}`);

    const done = await waitForJobDone(token!, asyncBody.job!.id as string);
    assert.equal(done.status, "succeeded");

    const executeSync = await postJson(
      "/api/mcp/execute",
      {
        tool: "reymeshy.cleanup",
        async: false,
        input: meshPayload
      },
      {
        Authorization: `Bearer ${token}`
      }
    );
    assert.equal(executeSync.status, 200);
    const syncBody = executeSync.body as {
      ok?: boolean;
      mode?: string;
      summary?: { inputTriangles?: number; outputTriangles?: number };
    };
    assert.equal(syncBody.ok, true);
    assert.equal(syncBody.mode, "sync");
    assert.equal(typeof syncBody.summary?.inputTriangles, "number");
    assert.equal(typeof syncBody.summary?.outputTriangles, "number");

    const disabledTool = await postJson(
      "/api/mcp/execute",
      {
        tool: "ollama.generate",
        input: {
          model: "llama3.1:8b",
          prompt: "hello"
        }
      },
      {
        Authorization: `Bearer ${token}`
      }
    );
    assert.equal(disabledTool.status, 503);
    assert.equal((disabledTool.body as { error?: string }).error, "MCP tool disabled: ollama.generate");
  } finally {
    server.kill("SIGTERM");
    await sleep(250);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
    if (fs.existsSync(sidecarPath)) {
      fs.rmSync(sidecarPath, { force: true });
    }
  }
});
