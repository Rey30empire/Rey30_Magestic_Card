import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4740 + Math.floor(Math.random() * 120);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-me-ai-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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

async function requestJson(
  method: "GET" | "POST" | "PUT",
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: method === "GET" ? undefined : JSON.stringify(body)
  });

  const parsed = (await response.json()) as unknown;
  return { status: response.status, body: parsed };
}

test("me ai-config endpoints enforce validation and policy gating", async () => {
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

    const username = `ai_cfg_user_${Date.now()}`;
    const password = "IntegrationPass123!";

    const register = await requestJson("POST", "/api/auth/register", { username, password }, { "x-client-platform": "web" });
    assert.equal(register.status, 201);
    const registerBody = register.body as { token?: string };
    assert.ok(registerBody.token, "register token missing");

    const authHeaders = {
      Authorization: `Bearer ${registerBody.token}`,
      "x-client-platform": "web"
    };

    const getInitial = await requestJson("GET", "/api/me/ai-config", undefined, authHeaders);
    assert.equal(getInitial.status, 200);
    const initialBody = getInitial.body as { configured?: boolean; enabled?: boolean; permissions?: Record<string, boolean> };
    assert.equal(initialBody.configured, false);
    assert.equal(initialBody.enabled, false);
    assert.equal(initialBody.permissions?.readScene, false);

    const enableWithoutKey = await requestJson(
      "PUT",
      "/api/me/ai-config",
      {
        provider: "openai-compatible",
        model: "gpt-4.1-mini",
        enabled: true
      },
      authHeaders
    );
    assert.equal(enableWithoutKey.status, 400);

    const blockedEndpoint = await requestJson(
      "PUT",
      "/api/me/ai-config",
      {
        provider: "openai-compatible",
        model: "gpt-4.1-mini",
        endpoint: "http://127.0.0.1:1234/v1/chat/completions",
        enabled: false
      },
      authHeaders
    );
    assert.equal(blockedEndpoint.status, 400);

    const configSaved = await requestJson(
      "PUT",
      "/api/me/ai-config",
      {
        provider: "openai-compatible",
        model: "gpt-4.1-mini",
        endpoint: "https://api.openai.com/v1/chat/completions",
        apiKey: "dummy_secret_1234567890",
        temperature: 0.2,
        maxTokens: 600,
        systemPrompt: "You are ReyCAD Assistant. Return JSON only.",
        enabled: true,
        permissions: {
          readScene: false,
          createGeometry: false,
          editGeometry: false,
          materials: false,
          booleans: false,
          templates: false,
          delete: false,
          cards: false,
          agents: false,
          skills: false,
          grid: false,
          export: false
        }
      },
      authHeaders
    );
    assert.equal(configSaved.status, 200);
    const configBody = configSaved.body as { configured?: boolean; enabled?: boolean; hasApiKey?: boolean };
    assert.equal(configBody.configured, true);
    assert.equal(configBody.enabled, true);
    assert.equal(configBody.hasApiKey, true);

    const savePermissions = await requestJson(
      "PUT",
      "/api/me/ai-config/permissions",
      {
        permissions: {
          readScene: true,
          createGeometry: false
        }
      },
      authHeaders
    );
    assert.equal(savePermissions.status, 200);
    const permissionsBody = savePermissions.body as { permissions?: Record<string, boolean> };
    assert.equal(permissionsBody.permissions?.readScene, true);
    assert.equal(permissionsBody.permissions?.createGeometry, false);

    const validPolicyEvent = await requestJson(
      "POST",
      "/api/me/ai-config/policy-events",
      {
        event: "blocked_tool",
        tool: "create_primitive",
        reason: "createGeometry disabled",
        source: "editor"
      },
      authHeaders
    );
    assert.equal(validPolicyEvent.status, 200);

    const invalidPolicyEvent = await requestJson(
      "POST",
      "/api/me/ai-config/policy-events",
      {
        event: "blocked_tool",
        tool: "x",
        reason: "x",
        source: "invalid"
      },
      authHeaders
    );
    assert.equal(invalidPolicyEvent.status, 400);

    const toolPlanBlocked = await requestJson(
      "POST",
      "/api/me/ai-config/tool-plan",
      {
        prompt: "crea una caja simple",
        permissions: {
          readScene: false
        }
      },
      authHeaders
    );
    assert.equal(toolPlanBlocked.status, 409);
    const planBlockedBody = toolPlanBlocked.body as { error?: string };
    assert.ok((planBlockedBody.error ?? "").toLowerCase().includes("no ai tools allowed"));
  } finally {
    server.kill("SIGTERM");
    await sleep(250);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
