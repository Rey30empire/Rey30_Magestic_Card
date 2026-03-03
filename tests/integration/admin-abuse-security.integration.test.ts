import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { grantAdminRoleForTest } from "./helpers/test-db";

const repoRoot = path.resolve(__dirname, "..", "..");
let baseUrl = "";
const dbPath = path.join(os.tmpdir(), `rey30-int-admin-abuse-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function allocateTestPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port || port <= 0) {
          reject(new Error("Failed to allocate test port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) {
    return;
  }

  const onExit = new Promise<void>((resolve) => {
    server.once("exit", () => resolve());
  });

  server.kill("SIGTERM");
  await Promise.race([onExit, sleep(1500)]);

  if (server.exitCode === null) {
    server.kill("SIGKILL");
    await Promise.race([onExit, sleep(1000)]);
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
  const port = await allocateTestPort();
  baseUrl = `http://127.0.0.1:${port}`;

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
    await grantAdminRoleForTest(dbPath, admin.userId);

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
        name: `Abuse Sentinel ${Date.now()}`,
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

    let blockedAttempt: { status: number; body: unknown } | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      blockedAttempt = await postJson(
        "/api/marketplace/listings",
        { cardId, priceCredits: 8 + attempt },
        {
          Authorization: `Bearer ${seller.token}`,
          "x-client-platform": "web"
        }
      );

      if (blockedAttempt.status === 429) {
        break;
      }
    }

    assert.equal(blockedAttempt?.status, 429);
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
    await stopServer(server);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
