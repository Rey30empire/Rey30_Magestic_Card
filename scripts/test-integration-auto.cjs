#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require("node:child_process");

const REDIS_INTEGRATION_TEST = "tests/integration/training-worker-redis.integration.test.ts";

const sqliteTests = [
  "tests/integration/auth-me.integration.test.ts",
  "tests/integration/agents-config-versioning.integration.test.ts",
  "tests/integration/agent-tool-runs-history.integration.test.ts",
  "tests/integration/skills-promotion-template-governance.integration.test.ts",
  "tests/integration/me-ai-config.integration.test.ts",
  "tests/integration/memory-project-ownership.integration.test.ts",
  "tests/integration/asset-vault.integration.test.ts",
  "tests/integration/training-jobs-runner.integration.test.ts",
  "tests/integration/training-worker-external.integration.test.ts",
  "tests/integration/admin-training-dlq.integration.test.ts",
  "tests/integration/admin-ops-metrics.integration.test.ts",
  "tests/integration/admin-ops-traces.integration.test.ts",
  "tests/integration/admin-vault-security.integration.test.ts",
  "tests/integration/admin-abuse-security.integration.test.ts",
  "tests/integration/sensitive-rate-limit.integration.test.ts",
  "tests/integration/training-limits.integration.test.ts",
  REDIS_INTEGRATION_TEST,
  "tests/integration/frontend-shell.integration.test.ts",
  "tests/integration/mcp-gateway.integration.test.ts",
  "tests/integration/mcp-hybrid-dispatch-jobs.integration.test.ts",
  "tests/integration/mcp-hybrid-status.integration.test.ts",
  "tests/integration/reymeshy-vram-guard.integration.test.ts",
  "tests/integration/reymeshy-jobs.integration.test.ts",
  "tests/integration/reymeshy-e2e.integration.test.ts",
  "tests/integration/training-idempotency-cancel.integration.test.ts",
  "tests/integration/training-timeout.integration.test.ts",
  "tests/integration/training-stage-timeout.integration.test.ts",
  "tests/integration/cards-marketplace-guards.integration.test.ts",
  "tests/integration/cards-creator-editor.integration.test.ts",
  "tests/integration/duels-engine.integration.test.ts"
];

function run(command, args, env) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: true,
    env: env || process.env
  });

  if (result.error) {
    console.error(`[test-integration-auto] failed to start: ${command} ${args.join(" ")}`);
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

function runWithStatus(command, args, env) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: true,
    env: env || process.env
  });

  if (result.error) {
    console.error(`[test-integration-auto] failed to start: ${command} ${args.join(" ")}`);
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

function isRedisReachable(redisUrl) {
  const trimmed = (redisUrl || "").trim();
  if (!trimmed) {
    return false;
  }

  const probeScript = `
const net = require("node:net");
let parsed;
try {
  parsed = new URL(process.argv[1]);
} catch {
  process.exit(2);
}
const host = parsed.hostname || "127.0.0.1";
const port = Number(parsed.port || "6379");
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  process.exit(2);
}
const socket = net.createConnection({ host, port });
let done = false;
const finish = (ok) => {
  if (done) return;
  done = true;
  socket.destroy();
  process.exit(ok ? 0 : 1);
};
socket.setTimeout(800);
socket.on("connect", () => finish(true));
socket.on("timeout", () => finish(false));
socket.on("error", () => finish(false));
`;

  const status = runWithStatus(process.execPath, ["-e", probeScript, trimmed], process.env);
  return status === 0;
}

function main() {
  const dbEngine = (process.env.DB_ENGINE || "sqlite").trim().toLowerCase();

  if (dbEngine === "sqlserver") {
    console.log("[test-integration-auto] DB_ENGINE=sqlserver -> running full SQL Server integration suite");
    run("node", ["scripts/test-integration-sqlserver-full.cjs"]);
    return;
  }

  if (dbEngine === "sqlite") {
    console.log("[test-integration-auto] DB_ENGINE=sqlite -> running SQLite integration suite (sequential)");
    const redisUrl = (process.env.REDIS_URL || "").trim();
    const shouldRunRedisIntegration = isRedisReachable(redisUrl);
    if (!shouldRunRedisIntegration) {
      console.log("[test-integration-auto] Redis integration test skipped (REDIS_URL unset or Redis unreachable)");
    }
    const buildStatus = runWithStatus("npm", ["run", "build"]);
    if (buildStatus !== 0) {
      process.exit(buildStatus);
    }

    for (const file of sqliteTests) {
      if (file === REDIS_INTEGRATION_TEST && !shouldRunRedisIntegration) {
        continue;
      }
      console.log(`\n[test-integration-auto] running ${file}`);
      const status = runWithStatus("npx", ["tsx", "--test", file]);
      if (status !== 0) {
        process.exit(status);
      }
    }

    console.log("\n[test-integration-auto] sqlite integration suite passed");
    process.exit(0);
    return;
  }

  console.error(`[test-integration-auto] Unsupported DB_ENGINE: ${dbEngine}`);
  process.exit(1);
}

main();
