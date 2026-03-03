import assert from "node:assert/strict";
import test from "node:test";
import type { HybridToggles } from "../../src/services/mcp-hybrid-router";
import {
  buildStopCommands,
  normalizeProcessNames,
  shouldStopLocalRuntimes
} from "../../src/services/hybrid-runtime-control";

function toggles(localEngineEnabled: boolean): HybridToggles {
  return {
    localEngineEnabled,
    apiEngineEnabled: true,
    preferLocalOverApi: true,
    providers: {
      "local.ollama": true
    },
    updatedAt: new Date().toISOString()
  };
}

test("shouldStopLocalRuntimes only when local toggle transitions from true to false", () => {
  assert.equal(shouldStopLocalRuntimes(toggles(true), toggles(false)), true);
  assert.equal(shouldStopLocalRuntimes(toggles(false), toggles(false)), false);
  assert.equal(shouldStopLocalRuntimes(toggles(false), toggles(true)), false);
  assert.equal(shouldStopLocalRuntimes(toggles(true), toggles(true)), false);
});

test("normalizeProcessNames trims and de-duplicates process targets", () => {
  const normalized = normalizeProcessNames([" ollama ", "python_worker", "OLLAMA", "", "python_worker"]);
  assert.deepEqual(normalized, ["ollama", "python_worker"]);
});

test("buildStopCommands uses taskkill on win32 and appends .exe", () => {
  const commands = buildStopCommands("win32", ["ollama", "python_worker.exe"]);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], {
    target: "ollama",
    command: "taskkill",
    args: ["/F", "/T", "/IM", "ollama.exe"]
  });
  assert.deepEqual(commands[1], {
    target: "python_worker.exe",
    command: "taskkill",
    args: ["/F", "/T", "/IM", "python_worker.exe"]
  });
});

test("buildStopCommands uses pkill on unix-like platforms", () => {
  const commands = buildStopCommands("linux", ["ollama", "python_worker"]);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], {
    target: "ollama",
    command: "pkill",
    args: ["-f", "ollama"]
  });
  assert.deepEqual(commands[1], {
    target: "python_worker",
    command: "pkill",
    args: ["-f", "python_worker"]
  });
});
