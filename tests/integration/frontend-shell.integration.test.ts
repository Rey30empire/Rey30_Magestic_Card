import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const port = 4690 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `rey30-front-int-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

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

test("frontend shell routes and assets are served", async () => {
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

    const rootResponse = await fetch(`${baseUrl}/`, { redirect: "manual" });
    assert.equal(rootResponse.status, 302);
    assert.equal(rootResponse.headers.get("location"), "/app");

    const appResponse = await fetch(`${baseUrl}/app`);
    assert.equal(appResponse.status, 200);
    const appHtml = await appResponse.text();
    const requiredAppMarkers = [
      'id="app-nav"',
      'id="app-auth-modal"',
      'id="home-jobs-list"',
      'data-panel="reystorage"',
      'data-panel="inventario"',
      'data-panel="duelos"',
      'data-panel="editor"',
      'data-panel="agents"',
      'data-panel="creators"',
      'data-panel="settings"'
    ];

    for (const marker of requiredAppMarkers) {
      assert.ok(appHtml.includes(marker), `Missing /app marker: ${marker}`);
    }

    const consoleResponse = await fetch(`${baseUrl}/console`);
    assert.equal(consoleResponse.status, 200);
    const consoleHtml = await consoleResponse.text();
    const requiredConsoleMarkers = [
      'id="console-platform-select"',
      'id="console-login-form"',
      'id="console-register-form"',
      'id="console-acs-summary"',
      'id="console-acs-modules"',
      'id="console-module-switcher"',
      'id="console-module-tab-training"',
      'id="console-module-tab-training-ops"',
      'id="console-agent-create-form"',
      'id="console-agent-connect-form"',
      'id="console-project-rule-form"',
      'id="console-skill-tests-form"',
      'id="console-agent-tool-form"',
      'id="console-memory-create-form"',
      'id="console-training-ops-metrics"',
      'id="console-training-ops-dlq-list"',
      'id="console-sandbox-form"',
      'id="console-template-import-form"',
      'id="console-project-form"',
      'id="console-training-form"',
      'id="console-job-list"'
    ];

    for (const marker of requiredConsoleMarkers) {
      assert.ok(consoleHtml.includes(marker), `Missing /console marker: ${marker}`);
    }

    const reycadResponse = await fetch(`${baseUrl}/reycad`);
    assert.equal(reycadResponse.status, 200);
    const reycadHtml = await reycadResponse.text();
    assert.ok(reycadHtml.includes('<div id="root"></div>'), "Missing /reycad root container");

    const reycadScriptMatch = reycadHtml.match(/<script[^>]+src="([^"]+)"/i);
    const reycadCssMatch = reycadHtml.match(/<link[^>]+href="([^"]+\.css)"/i);
    assert.ok(reycadScriptMatch?.[1], "Missing ReyCAD script asset in /reycad html");
    assert.ok(reycadCssMatch?.[1], "Missing ReyCAD css asset in /reycad html");

    const reycadScriptResponse = await fetch(`${baseUrl}${reycadScriptMatch![1]}`);
    assert.equal(reycadScriptResponse.status, 200, "ReyCAD script asset is not served");
    const reycadScriptText = await reycadScriptResponse.text();
    assert.ok(reycadScriptText.length > 0, "ReyCAD script asset is empty");

    const reycadCssResponse = await fetch(`${baseUrl}${reycadCssMatch![1]}`);
    assert.equal(reycadCssResponse.status, 200, "ReyCAD css asset is not served");
    const reycadCssText = await reycadCssResponse.text();
    assert.ok(reycadCssText.length > 0, "ReyCAD css asset is empty");

    const faviconRedirect = await fetch(`${baseUrl}/favicon.ico`, { redirect: "manual" });
    assert.equal(faviconRedirect.status, 302);
    assert.equal(faviconRedirect.headers.get("location"), "/shared/favicon.svg");

    const assets = [
      "/shared/tokens.css",
      "/shared/ui.css",
      "/shared/ui.js",
      "/shared/favicon.svg",
      "/app/app.css",
      "/app/app.js",
      "/console/console.css",
      "/console/console.js"
    ];

    for (const assetPath of assets) {
      const response = await fetch(`${baseUrl}${assetPath}`);
      assert.equal(response.status, 200, `Asset failed: ${assetPath}`);
      const content = await response.text();
      assert.ok(content.length > 0, `Asset empty: ${assetPath}`);
    }
  } finally {
    server.kill("SIGTERM");
    await sleep(250);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  }
});
