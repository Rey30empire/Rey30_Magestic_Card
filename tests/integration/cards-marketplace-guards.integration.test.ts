import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4720 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-cards-market-int-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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

async function registerUser(username: string, password: string): Promise<{ token: string; userId: string }> {
  const register = await postJson(
    "/api/auth/register",
    { username, password },
    {
      "x-client-platform": "web"
    }
  );

  assert.equal(register.status, 201);
  const body = register.body as { token?: string; user?: { id: string } };
  assert.ok(body.token);
  assert.ok(body.user?.id);

  return {
    token: body.token as string,
    userId: body.user!.id
  };
}

test("cards and marketplace guards prevent duplicates and double selling", async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret_for_cards_market",
    TRAINING_QUEUE_BACKEND: "local"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const seller = await registerUser(`seller_${Date.now()}`, "SellerPass123!");
    const buyer = await registerUser(`buyer_${Date.now()}`, "BuyerPass123!");

    const cardPayload = {
      name: "Atlas Guardian",
      rarity: "epic",
      cardClass: "tank",
      abilities: ["fortify", "taunt"],
      summonCost: 6,
      energy: 8,
      baseStats: {
        attack: 12,
        defense: 16,
        speed: 8
      },
      isOriginal: true
    };

    const sellerCardCreate = await postJson("/api/cards", cardPayload, {
      Authorization: `Bearer ${seller.token}`,
      "x-client-platform": "web"
    });
    assert.equal(sellerCardCreate.status, 201);
    const sellerCardBody = sellerCardCreate.body as { cardId?: string };
    assert.ok(sellerCardBody.cardId);

    const duplicateCardCreate = await postJson(
      "/api/cards",
      {
        ...cardPayload,
        name: " atlas guardian ",
        cardClass: "Tank",
        abilities: ["TAUNT", "fortify"]
      },
      {
        Authorization: `Bearer ${buyer.token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(duplicateCardCreate.status, 409);

    const listingCreate = await postJson(
      "/api/marketplace/listings",
      {
        cardId: sellerCardBody.cardId,
        priceCredits: 3
      },
      {
        Authorization: `Bearer ${seller.token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(listingCreate.status, 201);
    const listingBody = listingCreate.body as { listingId?: string };
    assert.ok(listingBody.listingId);

    const listingDuplicate = await postJson(
      "/api/marketplace/listings",
      {
        cardId: sellerCardBody.cardId,
        priceCredits: 4
      },
      {
        Authorization: `Bearer ${seller.token}`,
        "x-client-platform": "web"
      }
    );
    assert.equal(listingDuplicate.status, 409);

    const buyFirst = await postJson(`/api/marketplace/listings/${listingBody.listingId}/buy`, {}, {
      Authorization: `Bearer ${buyer.token}`,
      "x-client-platform": "web"
    });
    assert.equal(buyFirst.status, 200);

    const buySecond = await postJson(`/api/marketplace/listings/${listingBody.listingId}/buy`, {}, {
      Authorization: `Bearer ${seller.token}`,
      "x-client-platform": "web"
    });
    assert.equal(buySecond.status, 409);

    const cardRead = await getJson(`/api/cards/${sellerCardBody.cardId}`);
    assert.equal(cardRead.status, 200);
    const cardReadBody = cardRead.body as { ownerUserId?: string };
    assert.equal(cardReadBody.ownerUserId, buyer.userId);
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
