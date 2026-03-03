import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { env } from "../config/env";

const meshDataSchema = z.object({
  vertices: z.array(z.number()),
  indices: z.array(z.number().int().min(0)),
  uvs: z.array(z.number()).default([])
});

const pipelineOutputSchema = z.object({
  remeshed: meshDataSchema,
  uv_unwrapped: meshDataSchema,
  lod_optimized: meshDataSchema
});

export type ReyMeshyMeshData = z.infer<typeof meshDataSchema>;
export type ReyMeshyPipelineOutput = z.infer<typeof pipelineOutputSchema>;

type SidecarCommand = {
  executable: string;
  args: string[];
  cwd?: string;
};

type RunCleanupOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
};

function resolveRepoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function toWslPath(inputPath: string): string {
  const normalized = path.resolve(inputPath).replaceAll("\\", "/");
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!driveMatch) {
    return normalized;
  }

  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2];
  return `/mnt/${drive}/${rest}`;
}

function resolveDefaultCommand(): SidecarCommand {
  if (env.REYMESHY_SIDECAR_EXECUTABLE) {
    return {
      executable: env.REYMESHY_SIDECAR_EXECUTABLE,
      args: [...env.REYMESHY_SIDECAR_ARGS, "cleanup"],
      cwd: env.REYMESHY_SIDECAR_CWD || undefined
    };
  }

  const repoRoot = resolveRepoRoot();
  const manifestPath = path.join(repoRoot, "reymeshy", "Cargo.toml");

  if (process.platform === "win32") {
    const wslManifestPath = toWslPath(manifestPath);
    return {
      executable: "wsl",
      args: [
        "bash",
        "-lc",
        `source ~/.cargo/env && cargo run --quiet --manifest-path ${JSON.stringify(wslManifestPath)} --bin reymeshy -- cleanup`
      ],
      cwd: repoRoot
    };
  }

  // Dev fallback: run local cargo binary from repo checkout.
  return {
    executable: "cargo",
    args: ["run", "--quiet", "--manifest-path", manifestPath, "--bin", "reymeshy", "--", "cleanup"],
    cwd: repoRoot
  };
}

export function getReyMeshySidecarCommandPreview(): SidecarCommand {
  return resolveDefaultCommand();
}

export async function runReyMeshyCleanup(meshInput: ReyMeshyMeshData, options: RunCleanupOptions = {}): Promise<ReyMeshyPipelineOutput> {
  const input = meshDataSchema.parse(meshInput);
  const timeoutMs = options.timeoutMs ?? env.REYMESHY_SIDECAR_TIMEOUT_MS;

  let command: SidecarCommand;
  if (options.command) {
    command = {
      executable: options.command,
      args: [...(options.args ?? []), "cleanup"],
      cwd: options.cwd
    };
  } else {
    if (!env.REYMESHY_SIDECAR_ENABLED) {
      throw new Error("ReyMeshy sidecar is disabled. Set REYMESHY_SIDECAR_ENABLED=true or provide command override.");
    }
    command = resolveDefaultCommand();
  }

  return new Promise<ReyMeshyPipelineOutput>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finishWithError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishWithError(new Error(`ReyMeshy sidecar timeout after ${timeoutMs}ms`));
    }, Math.max(100, timeoutMs));

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
      finishWithError(new Error(`Failed to start ReyMeshy sidecar: ${error.message}`));
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }

      if (code !== 0) {
        settled = true;
        const stderrMessage = stderr.trim();
        reject(new Error(`ReyMeshy sidecar exited with code ${code}. ${stderrMessage || "No stderr output."}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim()) as unknown;
        settled = true;
        resolve(pipelineOutputSchema.parse(parsed));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        settled = true;
        reject(new Error(`Invalid ReyMeshy sidecar JSON output: ${message}`));
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
