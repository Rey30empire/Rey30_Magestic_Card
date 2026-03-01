import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import sqlite3 from "sqlite3";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 55100 + Math.floor(Math.random() * 2000);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-admin-abuse-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

type DbGet = <T>(sql: string, params?: Array<string | number | null>) => Promise<T | undefined>;
type DbRun = (sql: string, params?: Array<string | number | null>) => Promise<void>;

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
    body: (await response.json()) as unknown
  };
}

async function getJson(endpoint: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "GET",
    headers
  });

  return {
    status: response.status,
    body: (await response.json()) as unknown
  };
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

async function registerUser(username: string): Promise<{ userId: string; token: string; username: string }> {
  const register = await postJson(
    "/api/auth/register",
    { username, password: "AbusePhase5Pass123!" },
    {
      "x-client-platform": "web"
    }
  );
  assert.equal(register.status, 201);
  const body = register.body as { token?: string; user?: { id?: string; username?: string } };
  assert.ok(body.token);
  assert.ok(body.user?.id);
  assert.ok(body.user?.username);

  return {
    userId: body.user.id as string,
    token: body.token as string,
    username: body.user.username as string
  };
}

test("admin abuse endpoints expose incidents and allow resolving block", async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_QUEUE_BACKEND: "local",
    ABUSE_RISK_WINDOW_MS: "900000",
    ABUSE_RISK_BLOCK_THRESHOLD: "60",
    ABUSE_RISK_BLOCK_MS: "300000",
    ABUSE_RISK_INCIDENT_COOLDOWN_MS: "60000",
    API_RATE_LIMIT_MAX: "200"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const seller = await registerUser(`abuse_seller_${Date.now()}`);
    const admin = await registerUser(`abuse_admin_${Date.now()}`);
    await grantAdminRole(dbPath, admin.userId);

    const adminLogin = await postJson(
      "/api/auth/login",
      {
        username: admin.username,
        password: "AbusePhase5Pass123!"
      },
      { "x-client-platform": "web" }
    );
    assert.equal(adminLogin.status, 200);
    const adminToken = (adminLogin.body as { token?: string }).token;
    assert.ok(adminToken);

    const createCard = await postJson(
      "/api/cards",
      {
        name: "Abuse Sentinel",
        rarity: "rare",
        cardClass: "guardian",
        abilities: ["block", "counter"],
        summonCost: 4,
        energy: 6,
        baseStats: {
          attack: 8,
          defense: 11,
          speed: 7
        },
        isOriginal: true
      },
      {
        Authorization: `Bearer ${seller.token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(createCard.status, 201);
    const cardId = (createCard.body as { cardId?: string }).cardId;
    assert.ok(cardId);

    const createListing = await postJson(
      "/api/marketplace/listings",
      { cardId, priceCredits: 5 },
      {
        Authorization: `Bearer ${seller.token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(createListing.status, 201);

    const dupOne = await postJson(
      "/api/marketplace/listings",
      { cardId, priceCredits: 6 },
      {
        Authorization: `Bearer ${seller.token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(dupOne.status, 409);

    const dupTwo = await postJson(
      "/api/marketplace/listings",
      { cardId, priceCredits: 7 },
      {
        Authorization: `Bearer ${seller.token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(dupTwo.status, 409);

    const blockedAttempt = await postJson(
      "/api/marketplace/listings",
      { cardId, priceCredits: 8 },
      {
        Authorization: `Bearer ${seller.token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(blockedAttempt.status, 429);
    const blockedBody = blockedAttempt.body as { incidentId?: string; blockedUntil?: string };
    assert.ok(blockedBody.incidentId);
    assert.ok(blockedBody.blockedUntil);

    const incidentsResponse = await getJson("/api/admin/security/abuse/incidents?status=open&limit=50", {
      Authorization: `Bearer ${adminToken}`,
      "x-client-platform": "web"
    });
    assert.equal(incidentsResponse.status, 200);
    const incidentsBody = incidentsResponse.body as {
      items: Array<{ id: string; userId: string; status: string; score: number; blockUntil: string | null }>;
    };
    assert.ok(Array.isArray(incidentsBody.items));
    assert.ok(incidentsBody.items.length >= 1);

    const sellerIncident = incidentsBody.items.find((item) => item.userId === seller.userId);
    assert.ok(sellerIncident);
    assert.equal(sellerIncident?.status, "open");
    assert.ok((sellerIncident?.score ?? 0) >= 60);

    const summaryResponse = await getJson("/api/admin/security/abuse/summary?windowMinutes=60", {
      Authorization: `Bearer ${adminToken}`,
      "x-client-platform": "web"
    });
    assert.equal(summaryResponse.status, 200);
    const summaryBody = summaryResponse.body as { openIncidents: number; activeBlocks: number };
    assert.ok(summaryBody.openIncidents >= 1);
    assert.ok(summaryBody.activeBlocks >= 1);

    const resolveResponse = await postJson(
      `/api/admin/security/abuse/incidents/${sellerIncident!.id}/resolve`,
      {
        note: "false positive in integration test",
        unblockUser: true
      },
      {
        Authorization: `Bearer ${adminToken}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(resolveResponse.status, 200);
    const resolveBody = resolveResponse.body as { incident?: { status?: string } };
    assert.equal(resolveBody.incident?.status, "resolved");

    const afterResolveAttempt = await postJson(
      "/api/marketplace/listings",
      { cardId, priceCredits: 9 },
      {
        Authorization: `Bearer ${seller.token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(afterResolveAttempt.status, 409);
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
