import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import engineApi from "../../reycad/src/engine/api/engineApi";
import { useEditorStore } from "../../reycad/src/editor/state/editorStore";
import { createProject } from "../../reycad/src/engine/scenegraph/factory";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4710 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-reymeshy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
const sidecarPath = path.join(os.tmpdir(), `reymeshy-fake-sidecar-${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`);

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

  const output = {
    remeshed: { vertices, indices, uvs },
    uv_unwrapped: { vertices, indices, uvs },
    lod_optimized: { vertices, indices: lodIndices, uvs }
  };
  process.stdout.write(JSON.stringify(output));
});
`;
  fs.writeFileSync(filePath, script, "utf8");
}

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
    key(index: number): string | null {
      const keys = [...map.keys()];
      return keys[index] ?? null;
    },
    get length(): number {
      return map.size;
    }
  };
}

test("reymeshy e2e: api metrics + reycad bridge cleanup", async () => {
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
    REYMESHY_SIDECAR_TIMEOUT_MS: "8000"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  const originalFetch = globalThis.fetch;
  const originalStorage = (globalThis as { localStorage?: unknown }).localStorage;

  try {
    await waitForHealth();

    const username = `reymeshy_int_${Date.now()}`;
    const register = await postJson(
      "/api/auth/register",
      { username, password: "ReyMeshyPass123!" },
      { "x-client-platform": "web" }
    );
    assert.equal(register.status, 201);
    const token = (register.body as { token?: string }).token;
    assert.ok(token);

    const statusBefore = await getJson("/api/reymeshy/status?windowMinutes=15", {
      Authorization: `Bearer ${token}`
    });
    assert.equal(statusBefore.status, 200);
    const statusBeforeBody = statusBefore.body as {
      metrics?: { totals?: { requests?: number } };
      enabledByServer?: boolean;
    };
    assert.equal(statusBeforeBody.enabledByServer, true);
    assert.ok(typeof statusBeforeBody.metrics?.totals?.requests === "number");

    const cleanup = await postJson(
      "/api/reymeshy/cleanup",
      {
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
      },
      {
        Authorization: `Bearer ${token}`
      }
    );
    assert.equal(cleanup.status, 200);
    const cleanupBody = cleanup.body as {
      ok?: boolean;
      summary?: { inputTriangles?: number; outputTriangles?: number };
    };
    assert.equal(cleanupBody.ok, true);
    assert.equal(typeof cleanupBody.summary?.inputTriangles, "number");
    assert.equal(typeof cleanupBody.summary?.outputTriangles, "number");

    const statusAfter = await getJson("/api/reymeshy/status?windowMinutes=15", {
      Authorization: `Bearer ${token}`
    });
    assert.equal(statusAfter.status, 200);
    const statusAfterBody = statusAfter.body as {
      metrics?: {
        totals?: { requests?: number; ok?: number; failed?: number };
        last?: { outcome?: string | null; inputTriangles?: number | null };
      };
    };
    assert.ok((statusAfterBody.metrics?.totals?.requests ?? 0) >= 1);
    assert.ok((statusAfterBody.metrics?.totals?.ok ?? 0) >= 1);
    assert.equal(statusAfterBody.metrics?.last?.outcome, "ok");

    const storage = createMemoryStorage();
    storage.setItem("rey30_frontend_token", token!);
    storage.setItem("app.reymeshy.enabled", "1");
    (globalThis as { localStorage?: unknown }).localStorage = storage;

    (globalThis as { fetch: typeof fetch }).fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (typeof input === "string" && input.startsWith("/")) {
        return originalFetch(`${baseUrl}${input}`, init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    useEditorStore.getState().loadProject(createProject());
    const nodeId = engineApi.createPrimitive("sphere", { r: 10, widthSegments: 24, heightSegments: 16 });
    const report = await engineApi.cleanupNodeWithReyMeshy(nodeId);
    assert.equal(report.nodeId, nodeId);
    assert.ok(report.inputTriangles > 0);

    const history = engineApi.listReyMeshyHistory(nodeId, 5);
    assert.ok(history.length >= 1);
    assert.equal(history[0].status, "ok");
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    if (originalStorage === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as { localStorage?: unknown }).localStorage = originalStorage;
    }

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
