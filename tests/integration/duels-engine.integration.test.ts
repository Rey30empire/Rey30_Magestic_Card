import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4765 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-duels-engine-int-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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

test("duel engine simulate endpoint is deterministic", async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret_for_duel_engine",
    TRAINING_QUEUE_BACKEND: "local"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const user = await registerUser(`engine_${Date.now()}`, "EnginePass123!");
    const authHeaders = {
      Authorization: `Bearer ${user.token}`,
      "x-client-platform": "web"
    };

    const payload = {
      maxTurns: 14,
      left: {
        deckName: "Imperial",
        cards: [
          {
            name: "Atlas",
            rarity: "epic",
            attack: 12,
            defense: 14,
            speed: 8,
            abilities: ["shield", "regen"]
          },
          {
            name: "Raven",
            rarity: "rare",
            attack: 10,
            defense: 8,
            speed: 12,
            abilities: ["quick-step"]
          }
        ]
      },
      right: {
        deckName: "Raiders",
        cards: [
          {
            name: "Crusher",
            rarity: "epic",
            attack: 13,
            defense: 11,
            speed: 7,
            abilities: ["fury"]
          },
          {
            name: "Shade",
            rarity: "rare",
            attack: 9,
            defense: 8,
            speed: 11,
            abilities: ["pierce"]
          }
        ]
      }
    };

    const runA = await postJson("/api/duels/engine/simulate", payload, authHeaders);
    assert.equal(runA.status, 200);
    const runABody = runA.body as {
      seed?: string;
      winner?: string;
      turns?: number;
      timeline?: unknown[];
      summary?: Record<string, unknown>;
    };
    assert.ok(runABody.seed);
    assert.ok(Array.isArray(runABody.timeline));

    const runB = await postJson("/api/duels/engine/simulate", payload, authHeaders);
    assert.equal(runB.status, 200);
    const runBBody = runB.body as {
      seed?: string;
      winner?: string;
      turns?: number;
      timeline?: unknown[];
      summary?: Record<string, unknown>;
    };

    assert.equal(runBBody.seed, runABody.seed);
    assert.equal(runBBody.winner, runABody.winner);
    assert.equal(runBBody.turns, runABody.turns);
    assert.deepEqual(runBBody.summary, runABody.summary);
    assert.deepEqual(runBBody.timeline, runABody.timeline);

    const explicitSeedPayload = {
      ...payload,
      seed: "integration-seed-001"
    };
    const explicitA = await postJson("/api/duels/engine/simulate", explicitSeedPayload, authHeaders);
    const explicitB = await postJson("/api/duels/engine/simulate", explicitSeedPayload, authHeaders);
    assert.equal(explicitA.status, 200);
    assert.equal(explicitB.status, 200);
    assert.deepEqual(explicitB.body, explicitA.body);

    const invalid = await postJson(
      "/api/duels/engine/simulate",
      {
        maxTurns: 5,
        left: { cards: [] },
        right: { cards: [] }
      },
      authHeaders
    );
    assert.equal(invalid.status, 400);
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
