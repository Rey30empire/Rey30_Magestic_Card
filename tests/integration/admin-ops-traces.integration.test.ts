import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import sqlite3 from "sqlite3";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4740 + Math.floor(Math.random() * 100);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-admin-ops-traces-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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
): Promise<{ status: number; body: unknown; requestId: string | null; traceId: string | null }> {
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
    body: (await response.json()) as unknown,
    requestId: response.headers.get("x-request-id"),
    traceId: response.headers.get("x-trace-id")
  };
}

async function getJson(
  endpoint: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown; requestId: string | null; traceId: string | null }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "GET",
    headers
  });

  return {
    status: response.status,
    body: (await response.json()) as unknown,
    requestId: response.headers.get("x-request-id"),
    traceId: response.headers.get("x-trace-id")
  };
}

type DbGet = <T>(sql: string, params?: Array<string | number | null>) => Promise<T | undefined>;
type DbRun = (sql: string, params?: Array<string | number | null>) => Promise<void>;

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

test("admin ops traces endpoints expose request/db spans and export NDJSON", async () => {
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

    const adminRegister = await postJson(
      "/api/auth/register",
      { username: `ops_trace_admin_${Date.now()}`, password: "OpsTracePass123!" },
      {
        "x-client-platform": "web",
        "x-request-id": `req-register-${Date.now()}`,
        "x-trace-id": `trace-register-${Date.now()}`
      }
    );
    assert.equal(adminRegister.status, 201);
    const adminId = (adminRegister.body as { user?: { id?: string } }).user?.id;
    assert.ok(adminId);
    await grantAdminRole(dbPath, adminId as string);

    const adminLogin = await postJson(
      "/api/auth/login",
      {
        username: (adminRegister.body as { user?: { username?: string } }).user?.username,
        password: "OpsTracePass123!"
      },
      {
        "x-client-platform": "web"
      }
    );
    assert.equal(adminLogin.status, 200);
    const adminToken = (adminLogin.body as { token?: string }).token;
    assert.ok(adminToken);

    const traceProbeId = `trace-probe-${Date.now()}`;
    const probe = await getJson("/api/cards", {
      "x-client-platform": "web",
      "x-trace-id": traceProbeId,
      "x-request-id": `req-probe-${Date.now()}`
    });
    assert.equal(probe.status, 200);
    assert.equal(probe.traceId, traceProbeId);

    const traces = await getJson("/api/admin/ops/traces?minutes=30&limit=500", {
      Authorization: `Bearer ${adminToken}`,
      "x-client-platform": "web"
    });
    assert.equal(traces.status, 200);
    assert.ok(traces.requestId);

    const tracesBody = traces.body as {
      items: Array<{
        traceId: string;
        kind: string;
        status: string;
      }>;
    };
    assert.ok(Array.isArray(tracesBody.items));
    assert.ok(tracesBody.items.length >= 1);
    assert.ok(tracesBody.items.some((item) => item.kind === "request"));
    assert.ok(tracesBody.items.some((item) => item.kind === "db"));
    assert.ok(tracesBody.items.some((item) => item.traceId === traceProbeId));

    const exportRequestId = `req-export-${Date.now()}`;
    const exportResponse = await fetch(`${baseUrl}/api/admin/ops/traces/export?minutes=30&limit=200&format=ndjson`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "x-client-platform": "web",
        "x-request-id": exportRequestId
      }
    });

    assert.equal(exportResponse.status, 200);
    assert.equal(exportResponse.headers.get("x-request-id"), exportRequestId);
    const contentType = exportResponse.headers.get("content-type") ?? "";
    assert.ok(contentType.includes("application/x-ndjson"));

    const ndjson = await exportResponse.text();
    const lines = ndjson
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert.ok(lines.length >= 1);
    const first = JSON.parse(lines[0]) as { kind?: string; traceId?: string };
    assert.ok(typeof first.traceId === "string");
    assert.ok(typeof first.kind === "string");
  } finally {
    server.kill("SIGTERM");
    await sleep(350);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
