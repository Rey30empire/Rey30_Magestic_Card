import { spawn } from "node:child_process";
import { env } from "../config/env";
import type { HybridToggles } from "./mcp-hybrid-router";

type RuntimeStopCommand = {
  target: string;
  command: string;
  args: string[];
};

type RuntimeStopResult = {
  target: string;
  command: string;
  args: string[];
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type HybridRuntimeControlReport = {
  enabled: boolean;
  action: "none" | "skipped" | "stop-local-runtimes";
  reason: string | null;
  platform: NodeJS.Platform;
  stoppedTargets: number;
  results: RuntimeStopResult[];
  at: string;
};

function cloneToggles(input: HybridToggles): HybridToggles {
  return {
    ...input,
    providers: { ...input.providers }
  };
}

export function shouldStopLocalRuntimes(previous: HybridToggles, next: HybridToggles): boolean {
  return Boolean(previous.localEngineEnabled) && !Boolean(next.localEngineEnabled);
}

export function normalizeProcessNames(input: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of input) {
    const value = raw.trim();
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

export function buildStopCommands(platform: NodeJS.Platform, processNames: string[]): RuntimeStopCommand[] {
  const targets = normalizeProcessNames(processNames);
  if (platform === "win32") {
    return targets.map((target) => {
      const imageName = target.toLowerCase().endsWith(".exe") ? target : `${target}.exe`;
      return {
        target,
        command: "taskkill",
        args: ["/F", "/T", "/IM", imageName]
      };
    });
  }

  return targets.map((target) => ({
    target,
    command: "pkill",
    args: ["-f", target]
  }));
}

function runStopCommand(input: RuntimeStopCommand, timeoutMs: number): Promise<RuntimeStopResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: RuntimeStopResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        target: input.target,
        command: input.command,
        args: input.args,
        ok: false,
        code: null,
        signal: "SIGKILL",
        stdout,
        stderr: stderr || `timeout after ${timeoutMs}ms`
      });
    }, Math.max(250, timeoutMs));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      finish({
        target: input.target,
        command: input.command,
        args: input.args,
        ok: false,
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`
      });
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const exitCode = typeof code === "number" ? code : null;
      const notFoundLike = /no process|not found|cannot find|not currently running/i.test(`${stdout}\n${stderr}`);
      const ok = exitCode === 0 || (exitCode === 1 && notFoundLike);
      finish({
        target: input.target,
        command: input.command,
        args: input.args,
        ok,
        code: exitCode,
        signal,
        stdout,
        stderr
      });
    });
  });
}

export async function applyHybridToggleRuntimeEffects(input: {
  previous: HybridToggles;
  next: HybridToggles;
}): Promise<HybridRuntimeControlReport> {
  const previous = cloneToggles(input.previous);
  const next = cloneToggles(input.next);

  const base: HybridRuntimeControlReport = {
    enabled: env.MCP_HYBRID_PROCESS_CONTROL_ENABLED,
    action: "none",
    reason: null,
    platform: process.platform,
    stoppedTargets: 0,
    results: [],
    at: new Date().toISOString()
  };

  if (!shouldStopLocalRuntimes(previous, next)) {
    return base;
  }

  if (!env.MCP_HYBRID_PROCESS_CONTROL_ENABLED) {
    return {
      ...base,
      action: "skipped",
      reason: "disabled_by_env"
    };
  }

  const commands = buildStopCommands(process.platform, env.MCP_HYBRID_LOCAL_PROCESS_NAMES);
  if (commands.length === 0) {
    return {
      ...base,
      action: "skipped",
      reason: "no_targets_configured"
    };
  }

  const results: RuntimeStopResult[] = [];
  for (const command of commands) {
    // Sequential execution avoids simultaneous kills fighting for process tree.
    // eslint-disable-next-line no-await-in-loop
    const result = await runStopCommand(command, env.MCP_HYBRID_PROCESS_CONTROL_TIMEOUT_MS);
    results.push(result);
  }

  const stoppedTargets = results.filter((item) => item.ok).length;
  return {
    ...base,
    action: "stop-local-runtimes",
    reason: null,
    stoppedTargets,
    results
  };
}
