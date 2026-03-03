import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4740 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-reymeshy-jobs-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
const sidecarPath = path.join(os.tmpdir(), `reymeshy-fake-jobs-sidecar-${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`);

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

async function registerAndGetToken(username: string): Promise<string> {
  const register = await postJson(
    "/api/auth/register",
    { username, password: "ReyMeshyPass123!" },
    { "x-client-platform": "web" }
  );
  assert.equal(register.status, 201);
  const token = (register.body as { token?: string }).token;
  assert.ok(token);
  return token!;
}

async function waitForJobDone(token: string, jobId: string, timeoutMs = 15_000): Promise<{ states: string[]; body: unknown }> {
  const seenStates: string[] = [];
  const seenSet = new Set<string>();
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const current = await getJson(`/api/reymeshy/jobs/${jobId}`, {
      Authorization: `Bearer ${token}`
    });
    assert.equal(current.status, 200);
    const body = current.body as { job?: { status?: string } };
    const status = body.job?.status ?? "unknown";

    if (!seenSet.has(status)) {
      seenSet.add(status);
      seenStates.push(status);
    }

    if (status === "succeeded" || status === "failed") {
      return {
        states: seenStates,
        body: current.body
      };
    }

    await sleep(120);
  }

  throw new Error("Timed out waiting ReyMeshy job completion");
}

test("reymeshy jobs api: enqueue + poll + ownership", async () => {
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
    REYMESHY_JOB_CONCURRENCY: "2"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const userToken = await registerAndGetToken(`reymeshy_jobs_u1_${Date.now()}`);
    const otherUserToken = await registerAndGetToken(`reymeshy_jobs_u2_${Date.now()}`);

    const createJob = await postJson(
      "/api/reymeshy/jobs",
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
        Authorization: `Bearer ${userToken}`
      }
    );
    assert.equal(createJob.status, 202);
    const createBody = createJob.body as {
      ok?: boolean;
      job?: { id?: string; status?: string };
      poll?: { statusEndpoint?: string };
    };
    assert.equal(createBody.ok, true);
    assert.ok(createBody.job?.status === "queued" || createBody.job?.status === "running");
    assert.ok(typeof createBody.job?.id === "string");
    assert.equal(createBody.poll?.statusEndpoint, `/api/reymeshy/jobs/${createBody.job?.id}`);

    const jobId = createBody.job!.id as string;
    const done = await waitForJobDone(userToken, jobId);
    const doneBody = done.body as {
      ok?: boolean;
      job?: {
        status?: string;
        output?: { outputTriangles?: number | null };
        result?: unknown;
      };
    };

    assert.equal(doneBody.ok, true);
    assert.equal(doneBody.job?.status, "succeeded");
    assert.ok(typeof doneBody.job?.output?.outputTriangles === "number");
    assert.equal(doneBody.job?.result, null);

    const withResult = await getJson(`/api/reymeshy/jobs/${jobId}?includeResult=1`, {
      Authorization: `Bearer ${userToken}`
    });
    assert.equal(withResult.status, 200);
    const withResultBody = withResult.body as {
      job?: {
        result?: {
          remeshed?: { indices?: number[] };
          lod_optimized?: { indices?: number[] };
        } | null;
      };
    };
    assert.ok(Array.isArray(withResultBody.job?.result?.remeshed?.indices));
    assert.ok(Array.isArray(withResultBody.job?.result?.lod_optimized?.indices));

    const foreignRead = await getJson(`/api/reymeshy/jobs/${jobId}`, {
      Authorization: `Bearer ${otherUserToken}`
    });
    assert.equal(foreignRead.status, 404);

    const statusSnapshot = await getJson("/api/reymeshy/status?windowMinutes=15", {
      Authorization: `Bearer ${userToken}`
    });
    assert.equal(statusSnapshot.status, 200);
    const statusBody = statusSnapshot.body as {
      queue?: { concurrency?: number; totalJobs?: number };
      metrics?: { totals?: { requests?: number } };
    };
    assert.equal(statusBody.queue?.concurrency, 2);
    assert.ok((statusBody.queue?.totalJobs ?? 0) >= 1);
    assert.ok((statusBody.metrics?.totals?.requests ?? 0) >= 1);
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
