import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { grantAdminRoleForTest } from "./helpers/test-db";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4730 + Math.floor(Math.random() * 100);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-admin-ops-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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
): Promise<{ status: number; body: unknown; requestId: string | null }> {
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
    requestId: response.headers.get("x-request-id")
  };
}

async function getJson(
  endpoint: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown; requestId: string | null }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "GET",
    headers
  });

  return {
    status: response.status,
    body: (await response.json()) as unknown,
    requestId: response.headers.get("x-request-id")
  };
}

async function registerUser(username: string): Promise<{ userId: string; token: string; username: string }> {
  const register = await postJson(
    "/api/auth/register",
    { username, password: "OpsMetricsPass123!" },
    {
      "x-client-platform": "web"
    }
  );
  assert.equal(register.status, 201);
  const body = register.body as { token?: string; user?: { id?: string } };
  assert.ok(body.token);
  assert.ok(body.user?.id);

  return {
    userId: body.user!.id as string,
    token: body.token as string,
    username
  };
}

test("admin ops metrics exposes cards/marketplace 409 and rate-limit 429 counters", async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_QUEUE_BACKEND: "local",
    API_RATE_LIMIT_MAX: "8",
    OPS_ALERT_CARDS_409_15M: "1",
    OPS_ALERT_MARKETPLACE_409_15M: "1",
    OPS_ALERT_RATE_LIMIT_429_15M: "1"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const seller = await registerUser(`ops_seller_${Date.now()}`);
    const buyer = await registerUser(`ops_buyer_${Date.now()}`);
    const admin = await registerUser(`ops_admin_${Date.now()}`);
    await grantAdminRoleForTest(dbPath, admin.userId);

    const adminLoginRetry = await postJson(
      "/api/auth/login",
      {
        username: admin.username,
        password: "OpsMetricsPass123!"
      },
      {
        "x-client-platform": "web"
      }
    );
    assert.equal(adminLoginRetry.status, 200);
    const adminToken = (adminLoginRetry.body as { token?: string }).token;
    assert.ok(adminToken);

    const cardPayload = {
      name: `Ops Sentinel ${Date.now()}`,
      rarity: "rare",
      cardClass: "guardian",
      abilities: ["block", "taunt"],
      summonCost: 4,
      energy: 6,
      baseStats: {
        attack: 9,
        defense: 12,
        speed: 7
      },
      isOriginal: true
    };

    const createSellerCard = await postJson("/api/cards", cardPayload, {
      Authorization: `Bearer ${seller.token}`,
      "x-client-platform": "web"
    });
    assert.equal(createSellerCard.status, 201);
    const cardId = (createSellerCard.body as { cardId?: string }).cardId;
    assert.ok(cardId);

    const createDuplicateCard = await postJson("/api/cards", cardPayload, {
      Authorization: `Bearer ${buyer.token}`,
      "x-client-platform": "web"
    });
    assert.equal(createDuplicateCard.status, 409);

    const createListing = await postJson(
      "/api/marketplace/listings",
      {
        cardId,
        priceCredits: 3
      },
      {
        Authorization: `Bearer ${seller.token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(createListing.status, 201);

    const createListingDuplicate = await postJson(
      "/api/marketplace/listings",
      {
        cardId,
        priceCredits: 4
      },
      {
        Authorization: `Bearer ${seller.token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(createListingDuplicate.status, 409);

    let seen429 = false;
    for (let index = 0; index < 16; index += 1) {
      const response = await getJson("/api/cards", {
        "x-client-platform": "web"
      });
      if (response.status === 429) {
        seen429 = true;
        break;
      }
    }
    assert.equal(seen429, true);

    const metrics = await getJson("/api/admin/ops/metrics?windowMinutes=15", {
      Authorization: `Bearer ${adminToken}`,
      "x-client-platform": "web"
    });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.requestId);

    const body = metrics.body as {
      window: {
        counts: {
          cardsConflict409: number;
          marketplaceConflict409: number;
          rateLimited429: number;
        };
      };
      training: {
        queueDepth: number;
      };
      alerts: string[];
    };

    assert.ok(body.window.counts.cardsConflict409 >= 1);
    assert.ok(body.window.counts.marketplaceConflict409 >= 1);
    assert.ok(body.window.counts.rateLimited429 >= 1);
    assert.ok(body.training.queueDepth >= 0);
    assert.ok(Array.isArray(body.alerts));
    assert.ok(body.alerts.length >= 1);

    const historyRequestId = `ops-history-${Date.now()}`;
    const history = await getJson("/api/admin/ops/metrics/history?minutes=15&limit=60", {
      Authorization: `Bearer ${adminToken}`,
      "x-client-platform": "web",
      "x-request-id": historyRequestId
    });
    assert.equal(history.status, 200);
    assert.equal(history.requestId, historyRequestId);

    const historyBody = history.body as {
      items: Array<{
        minuteKey: number;
        counts: {
          totalRequests: number;
        };
      }>;
    };
    assert.ok(Array.isArray(historyBody.items));
    assert.ok(historyBody.items.length >= 1);
    assert.ok(historyBody.items[0].minuteKey > 0);
    assert.ok(historyBody.items[0].counts.totalRequests >= 1);
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
