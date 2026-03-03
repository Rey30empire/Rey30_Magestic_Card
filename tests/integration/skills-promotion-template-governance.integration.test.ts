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
const dbPath = path.join(
  os.tmpdir(),
  `rey30-int-skill-template-governance-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
);

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

async function sendJson(
  method: "GET" | "POST",
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method,
    headers: {
      ...headers
    }
  };

  if (method !== "GET") {
    init.headers = {
      "Content-Type": "application/json",
      ...headers
    };
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${endpoint}`, init);
  return {
    status: response.status,
    body: (await response.json()) as unknown
  };
}

test("skills promotion and template governance flows work with quality gates", async () => {
  const port = await allocateTestPort();
  baseUrl = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: "integration_test_secret",
    TRAINING_QUEUE_BACKEND: "local",
    TEMPLATE_QUALITY_MIN_SCORE: "45",
    MARKETPLACE_APP_VERSION: "1.0.0"
  };

  const server: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "pipe"
  });

  try {
    await waitForHealth();

    const username = `skill_tpl_admin_${Date.now()}`;
    const password = "SkillTplPass123!";
    const register = await sendJson("POST", "/api/auth/register", { username, password }, { "x-client-platform": "web" });
    assert.equal(register.status, 201);
    const userId = (register.body as { user?: { id?: string } }).user?.id;
    assert.ok(userId);
    await grantAdminRoleForTest(dbPath, userId as string);

    const login = await sendJson("POST", "/api/auth/login", { username, password }, { "x-client-platform": "web" });
    assert.equal(login.status, 200);
    const token = (login.body as { token?: string }).token;
    assert.ok(token);

    const headers = {
      Authorization: `Bearer ${token}`,
      "x-client-platform": "web"
    };

    const createSkill = await sendJson(
      "POST",
      "/api/skills",
      {
        name: `SkillGovernance${Date.now()}`,
        version: "1.0.0",
        description: "Skill for promotion governance testing",
        environment: "draft",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" }
          },
          required: ["text"]
        },
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" }
          },
          required: ["ok"]
        },
        requiredTools: ["agent.profileEcho"],
        tests: [
          {
            name: "basic",
            input: { text: "hello" },
            expectedOutput: { ok: true }
          }
        ]
      },
      headers
    );
    assert.equal(createSkill.status, 201);
    const skillId = (createSkill.body as { id?: string }).id;
    assert.ok(skillId);

    const promoteStaging = await sendJson(
      "POST",
      `/api/skills/${skillId}/promote`,
      {
        targetEnvironment: "staging",
        note: "ready for staging"
      },
      headers
    );
    assert.equal(promoteStaging.status, 200);

    const promoteProd = await sendJson(
      "POST",
      `/api/skills/${skillId}/promote`,
      {
        targetEnvironment: "prod",
        note: "ready for production"
      },
      headers
    );
    assert.equal(promoteProd.status, 200);

    const promotions = await sendJson("GET", `/api/skills/${skillId}/promotions?limit=20`, {}, headers);
    assert.equal(promotions.status, 200);
    const promotionsBody = promotions.body as { items: Array<{ fromEnvironment: string; toEnvironment: string }> };
    assert.ok(promotionsBody.items.length >= 2);

    const createAgent = await sendJson(
      "POST",
      "/api/agents",
      {
        name: "Governance Agent",
        role: "strategist",
        detail: "high quality reusable template profile",
        personality: "analytical and collaborative assistant",
        lore: "trained for governance and release workflows",
        memoryScope: "private"
      },
      headers
    );
    assert.equal(createAgent.status, 201);
    const agentId = (createAgent.body as { id?: string }).id;
    assert.ok(agentId);

    const setRules = await sendJson(
      "POST",
      `/api/agents/${agentId}/rules`,
      {
        level: "agent",
        title: "Safety",
        content: "Always validate outputs and avoid unsafe actions.",
        enforcement: "hard",
        priority: 80,
        active: true
      },
      headers
    );
    assert.equal(setRules.status, 201);

    const assignSkills = await sendJson(
      "POST",
      `/api/agents/${agentId}/skills`,
      {
        updates: [
          {
            skillId,
            enabled: true,
            config: {}
          }
        ]
      },
      headers
    );
    assert.equal(assignSkills.status, 200);

    const assignTools = await sendJson(
      "POST",
      `/api/agents/${agentId}/tools`,
      {
        updates: [
          {
            toolKey: "agent.profileEcho",
            allowed: true,
            config: {}
          }
        ]
      },
      headers
    );
    assert.equal(assignTools.status, 200);

    const sandbox = await sendJson("POST", `/api/agents/${agentId}/sandbox-test`, {}, headers);
    assert.equal(sandbox.status, 200);
    assert.equal((sandbox.body as { status?: string }).status, "passed");

    const templateKey = `tpl-${Date.now()}`;
    const publishV1 = await sendJson(
      "POST",
      "/api/agent-marketplace/templates",
      {
        agentId,
        name: "Governed Template",
        description: "Version 1",
        tags: ["governance", "v1"],
        templateKey,
        compatibilityMin: "1.0.0"
      },
      headers
    );
    assert.equal(publishV1.status, 201);
    const tpl1 = publishV1.body as { id?: string; version?: number; templateKey?: string };
    assert.ok(tpl1.id);
    assert.equal(tpl1.version, 1);
    assert.equal(tpl1.templateKey, templateKey);

    const publishV2 = await sendJson(
      "POST",
      "/api/agent-marketplace/templates",
      {
        agentId,
        name: "Governed Template",
        description: "Version 2",
        tags: ["governance", "v2"],
        templateKey,
        compatibilityMin: "1.0.0"
      },
      headers
    );
    assert.equal(publishV2.status, 201);
    const tpl2 = publishV2.body as { id?: string; version?: number; templateKey?: string };
    assert.ok(tpl2.id);
    assert.equal(tpl2.version, 2);

    const deprecateV1 = await sendJson(
      "POST",
      `/api/agent-marketplace/templates/${tpl1.id}/moderate`,
      {
        action: "deprecate",
        note: "v2 replaces v1"
      },
      headers
    );
    assert.equal(deprecateV1.status, 200);
    assert.equal((deprecateV1.body as { status?: string }).status, "deprecated");

    const importDeprecated = await sendJson(
      "POST",
      `/api/agent-marketplace/templates/${tpl1.id}/import`,
      {
        nameOverride: "Should fail"
      },
      {
        ...headers,
        "x-client-app-version": "1.0.0"
      }
    );
    assert.equal(importDeprecated.status, 409);

    const importActive = await sendJson(
      "POST",
      `/api/agent-marketplace/templates/${tpl2.id}/import`,
      {
        nameOverride: "Imported Governance Agent"
      },
      {
        ...headers,
        "x-client-app-version": "1.0.0"
      }
    );
    assert.equal(importActive.status, 201);
  } finally {
    await stopServer(server);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
