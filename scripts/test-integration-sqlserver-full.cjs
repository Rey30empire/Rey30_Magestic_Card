#!/usr/bin/env node
/* eslint-disable no-console */
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tests = [
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
  "tests/integration/training-worker-redis.integration.test.ts",
  "tests/integration/frontend-shell.integration.test.ts",
  "tests/integration/mcp-gateway.integration.test.ts",
  "tests/integration/mcp-hybrid-status.integration.test.ts",
  "tests/integration/reymeshy-vram-guard.integration.test.ts",
  "tests/integration/reymeshy-jobs.integration.test.ts",
  "tests/integration/reymeshy-e2e.integration.test.ts",
  "tests/integration/training-idempotency-cancel.integration.test.ts",
  "tests/integration/training-timeout.integration.test.ts",
  "tests/integration/cards-marketplace-guards.integration.test.ts",
  "tests/integration/cards-creator-editor.integration.test.ts",
  "tests/integration/duels-engine.integration.test.ts"
];

function commandName(base) {
  return base;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    shell: true
  });

  if (result.error) {
    console.error(`[sqlserver-full] command failed to start: ${command} ${args.join(" ")}`);
    console.error(result.error.message);
    return 1;
  }

  if (typeof result.status === "number") {
    return result.status;
  }
  return 1;
}

function ensureSqlServerMode() {
  const dbEngine = (process.env.DB_ENGINE || "").trim().toLowerCase();
  if (dbEngine !== "sqlserver") {
    console.error("[sqlserver-full] DB_ENGINE must be sqlserver.");
    process.exit(1);
  }
}

function main() {
  ensureSqlServerMode();

  const npm = commandName("npm");
  const npx = commandName("npx");
  const node = process.execPath;
  const cleanAllScript = path.join("scripts", "sqlserver-clean-all.cjs");

  const buildStatus = run(npm, ["run", "build"]);
  if (buildStatus !== 0) {
    process.exit(buildStatus);
  }

  for (const file of tests) {
    console.log(`\n[sqlserver-full] cleaning DB before ${file}`);
    const cleanStatus = run(node, [cleanAllScript]);
    if (cleanStatus !== 0) {
      process.exit(cleanStatus);
    }

    console.log(`[sqlserver-full] running ${file}`);
    const testStatus = run(npx, ["tsx", "--test", file]);
    if (testStatus !== 0) {
      process.exit(testStatus);
    }
  }

  console.log("\n[sqlserver-full] all integration tests passed");
}

main();
