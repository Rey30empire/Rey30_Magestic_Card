import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4620;
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-int-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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

test("register + me returns roles/permissions/platform", async () => {
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

    const username = `int_user_${Date.now()}`;
    const password = "IntegrationPass123!";

    const register = await postJson(
      "/api/auth/register",
      { username, password },
      {
        "x-client-platform": "web"
      }
    );

    assert.equal(register.status, 201);

    const registerBody = register.body as {
      token?: string;
      user?: {
        id: string;
      };
    };

    assert.ok(registerBody.token);
    assert.ok(registerBody.user?.id);

    const me = await getJson("/api/me", {
      Authorization: `Bearer ${registerBody.token}`,
      "x-client-platform": "mobile"
    });

    assert.equal(me.status, 200);
    const meBody = me.body as {
      id: string;
      username: string;
      role: string;
      roles: string[];
      permissions: string[];
      platform: string;
    };

    assert.equal(meBody.username, username);
    assert.equal(meBody.platform, "mobile");
    assert.ok(Array.isArray(meBody.roles));
    assert.ok(meBody.roles.includes("user"));
    assert.ok(Array.isArray(meBody.permissions));

    const acsHome = await getJson("/api/me/acs-home?includeCounts=true", {
      Authorization: `Bearer ${registerBody.token}`,
      "x-client-platform": "mobile"
    });

    assert.equal(acsHome.status, 200);
    const acsBody = acsHome.body as {
      platform: string;
      user: { id: string; username: string; roles: string[]; permissions: string[] };
      creator: { isApprovedCreator: boolean; applicationStatus: string | null };
      modules: Array<{ key: string; available: boolean; reason?: string | null }>;
      trainingModes: Array<{ mode: string; allowed: boolean; requiredPlatform: string | null }>;
      counts?: Record<string, number>;
    };

    assert.equal(acsBody.platform, "mobile");
    assert.equal(acsBody.user.username, username);
    assert.ok(Array.isArray(acsBody.user.roles));
    assert.ok(Array.isArray(acsBody.user.permissions));
    assert.equal(acsBody.creator.isApprovedCreator, false);
    assert.equal(acsBody.creator.applicationStatus, null);
    assert.ok(Array.isArray(acsBody.modules));
    assert.ok(acsBody.modules.length >= 1);
    const acsHomeModule = acsBody.modules.find((module) => module.key === "acsHome");
    assert.ok(acsHomeModule);
    assert.equal(acsHomeModule?.available, true);
    const trainingModes = new Map(acsBody.trainingModes.map((item) => [item.mode, item]));
    assert.equal(trainingModes.get("profile-tuning")?.allowed, true);
    assert.equal(trainingModes.get("fine-tuning")?.allowed, false);
    assert.equal(trainingModes.get("fine-tuning")?.requiredPlatform, "desktop");
    assert.ok(acsBody.counts);
    assert.equal(typeof acsBody.counts?.projects, "number");
    assert.equal(typeof acsBody.counts?.trainingJobsTotal, "number");

    const acsHomeNoCounts = await getJson("/api/me/acs-home?includeCounts=false", {
      Authorization: `Bearer ${registerBody.token}`,
      "x-client-platform": "desktop"
    });
    assert.equal(acsHomeNoCounts.status, 200);
    const acsNoCountsBody = acsHomeNoCounts.body as { platform: string; counts?: Record<string, number> };
    assert.equal(acsNoCountsBody.platform, "desktop");
    assert.equal("counts" in acsNoCountsBody, false);
  } finally {
    server.kill("SIGTERM");
    await sleep(250);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
