import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import sqlite3 from "sqlite3";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4750 + Math.floor(Math.random() * 100);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-vault-security-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
const vaultSecret = "integration_vault_secret_1234567890";

type DbGet = <T>(sql: string, params?: Array<string | number | null>) => Promise<T | undefined>;
type DbRun = (sql: string, params?: Array<string | number | null>) => Promise<void>;

function toB64(value: Buffer): string {
  return value.toString("base64url");
}

function encryptLegacyV1(secret: string, keySecret: string): string {
  const key = createHash("sha256").update(keySecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${toB64(iv)}:${toB64(tag)}:${toB64(encrypted)}`;
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
  method: "POST" | "PUT",
  endpoint: string,
  bodyInput: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown; requestId: string | null; raw: string }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(bodyInput)
  });

  const raw = await response.text();
  let parsedBody: unknown = raw;
  try {
    parsedBody = JSON.parse(raw) as unknown;
  } catch {
    parsedBody = raw;
  }

  return {
    status: response.status,
    body: parsedBody,
    requestId: response.headers.get("x-request-id"),
    raw
  };
}

async function getJson(
  endpoint: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown; contentType: string | null; raw: string }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "GET",
    headers
  });

  const raw = await response.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    body = raw;
  }

  return {
    status: response.status,
    body,
    contentType: response.headers.get("content-type"),
    raw
  };
}

test("admin vault security endpoints rotate legacy v1 entries and audit chain verifies", async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    VAULT_SECRET: vaultSecret,
    TRAINING_QUEUE_BACKEND: "local"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const normalUserRegister = await sendJson(
      "POST",
      "/api/auth/register",
      { username: `vault_user_${Date.now()}`, password: "VaultPass123!" },
      { "x-client-platform": "web" }
    );
    assert.equal(normalUserRegister.status, 201);
    const userToken = (normalUserRegister.body as { token?: string }).token;
    assert.ok(userToken);

    const upsertAiConfig = await sendJson(
      "PUT",
      "/api/me/ai-config",
      {
        provider: "openai-compatible",
        model: "gpt-4.1-mini",
        endpoint: "https://api.openai.com/v1/chat/completions",
        apiKey: "sk-integration-abc-123",
        enabled: true
      },
      {
        Authorization: `Bearer ${userToken}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(upsertAiConfig.status, 200);

    const adminRegister = await sendJson(
      "POST",
      "/api/auth/register",
      { username: `vault_admin_${Date.now()}`, password: "VaultAdminPass123!" },
      { "x-client-platform": "web" }
    );
    assert.equal(adminRegister.status, 201);
    const adminId = (adminRegister.body as { user?: { id?: string } }).user?.id;
    assert.ok(adminId);
    await grantAdminRole(dbPath, adminId as string);

    const adminLogin = await sendJson(
      "POST",
      "/api/auth/login",
      { username: (adminRegister.body as { user?: { username?: string } }).user?.username, password: "VaultAdminPass123!" },
      { "x-client-platform": "web" }
    );
    assert.equal(adminLogin.status, 200);
    const adminToken = (adminLogin.body as { token?: string }).token;
    assert.ok(adminToken);

    const db = openDb(dbPath);
    let keysRef: string | undefined;
    try {
      const aiConfig = await db.get<{ keys_ref: string | null }>("SELECT keys_ref FROM user_ai_configs LIMIT 1");
      keysRef = aiConfig?.keys_ref ?? undefined;
      assert.ok(keysRef);

      const legacyPayload = encryptLegacyV1("sk-integration-abc-123", vaultSecret);
      await db.run("UPDATE vault_entries SET encrypted_value = ?, updated_at = ? WHERE id = ?", [
        legacyPayload,
        new Date().toISOString(),
        keysRef as string
      ]);
    } finally {
      await db.close();
    }

    const statusBefore = await getJson("/api/admin/security/vault/status?limit=5000", {
      Authorization: `Bearer ${adminToken}`,
      "x-client-platform": "web"
    });
    assert.equal(statusBefore.status, 200);
    const statusBeforeBody = statusBefore.body as { totals: { v1: number; v2: number } };
    assert.ok(statusBeforeBody.totals.v1 >= 1);

    const rotate = await sendJson(
      "POST",
      "/api/admin/security/vault/rotate",
      { limit: 5000 },
      {
        Authorization: `Bearer ${adminToken}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(rotate.status, 200);
    const rotateBody = rotate.body as { ok?: boolean; rotated?: number; failed?: number };
    assert.equal(rotateBody.ok, true);
    assert.ok((rotateBody.rotated ?? 0) >= 1);
    assert.equal(rotateBody.failed, 0);

    const statusAfter = await getJson("/api/admin/security/vault/status?limit=5000", {
      Authorization: `Bearer ${adminToken}`,
      "x-client-platform": "web"
    });
    assert.equal(statusAfter.status, 200);
    const statusAfterBody = statusAfter.body as { totals: { v1: number; v2: number } };
    assert.equal(statusAfterBody.totals.v1, 0);
    assert.ok(statusAfterBody.totals.v2 >= 1);

    const verifyAudit = await getJson("/api/admin/audit-logs/verify?limit=2000&offset=0", {
      Authorization: `Bearer ${adminToken}`,
      "x-client-platform": "web"
    });
    assert.equal(verifyAudit.status, 200);
    const verifyBody = verifyAudit.body as { ok?: boolean; verifiedRows?: number };
    assert.equal(verifyBody.ok, true);
    assert.ok((verifyBody.verifiedRows ?? 0) >= 1);
  } finally {
    server.kill("SIGTERM");
    await sleep(350);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
