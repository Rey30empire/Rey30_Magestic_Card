import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../config/env";

const execFileAsync = promisify(execFile);

type VramGpuSnapshot = {
  index: number;
  uuid: string | null;
  name: string | null;
  memoryTotalMb: number;
  memoryUsedMb: number;
  memoryFreeMb: number;
};

type VramPolicySnapshot = {
  highWatermarkMb: number;
  minFreeMb: number;
  taskReserveMb: number;
};

export type VramSentinelSnapshot = {
  enabled: boolean;
  failOpen: boolean;
  healthy: boolean;
  constrained: boolean;
  reason: string | null;
  source: "nvidia-smi" | "disabled";
  updatedAt: string | null;
  command: {
    executable: string;
    argsCount: number;
  };
  policy: VramPolicySnapshot;
  gpus: VramGpuSnapshot[];
  summary: {
    gpusDetected: number;
    peakUsedMb: number | null;
    lowestFreeMb: number | null;
  };
  error: string | null;
};

export type VramGuardDecision = {
  allowed: boolean;
  reason: string | null;
  snapshot: VramSentinelSnapshot;
};

type EvaluatedVramPolicy = {
  constrained: boolean;
  reason: string | null;
  peakUsedMb: number | null;
  lowestFreeMb: number | null;
};

let pollTimer: NodeJS.Timeout | null = null;
let probeInFlight: Promise<VramSentinelSnapshot> | null = null;
let lastSnapshot: VramSentinelSnapshot = makeDisabledSnapshot();

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.trunc(value);
  return Math.min(max, Math.max(min, rounded));
}

function currentPolicy(): VramPolicySnapshot {
  return {
    highWatermarkMb: sanitizeInteger(env.REYMESHY_VRAM_MAX_USED_MB, 22_000, 512, 2_000_000),
    minFreeMb: sanitizeInteger(env.REYMESHY_VRAM_MIN_FREE_MB, 1_200, 0, 2_000_000),
    taskReserveMb: sanitizeInteger(env.REYMESHY_VRAM_TASK_RESERVE_MB, 1_200, 0, 2_000_000)
  };
}

function currentCommandConfig(): { executable: string; args: string[] } {
  const executable = env.VRAM_SENTINEL_COMMAND && env.VRAM_SENTINEL_COMMAND.trim().length > 0
    ? env.VRAM_SENTINEL_COMMAND.trim()
    : "nvidia-smi";
  const args = env.VRAM_SENTINEL_COMMAND_ARGS && env.VRAM_SENTINEL_COMMAND_ARGS.length > 0
    ? [...env.VRAM_SENTINEL_COMMAND_ARGS]
    : [
        "--query-gpu=index,uuid,name,memory.total,memory.used,memory.free",
        "--format=csv,noheader,nounits"
      ];
  return { executable, args };
}

function makeDisabledSnapshot(): VramSentinelSnapshot {
  const policy = currentPolicy();
  const command = currentCommandConfig();
  return {
    enabled: false,
    failOpen: env.VRAM_SENTINEL_FAIL_OPEN,
    healthy: true,
    constrained: false,
    reason: null,
    source: "disabled",
    updatedAt: nowIso(),
    command: {
      executable: command.executable,
      argsCount: command.args.length
    },
    policy,
    gpus: [],
    summary: {
      gpusDetected: 0,
      peakUsedMb: null,
      lowestFreeMb: null
    },
    error: null
  };
}

function parseCsvInt(value: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const rounded = Math.trunc(parsed);
  if (rounded < 0) {
    return null;
  }
  return rounded;
}

export function parseNvidiaSmiCsvOutput(raw: string): VramGpuSnapshot[] {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const output: VramGpuSnapshot[] = [];
  for (const line of lines) {
    const columns = line.split(",").map((entry) => entry.trim());
    if (columns.length < 6) {
      continue;
    }

    const index = parseCsvInt(columns[0]);
    const total = parseCsvInt(columns[columns.length - 3]);
    const used = parseCsvInt(columns[columns.length - 2]);
    const free = parseCsvInt(columns[columns.length - 1]);
    if (index === null || total === null || used === null || free === null) {
      continue;
    }

    const uuidRaw = columns[1];
    const nameRaw = columns.slice(2, columns.length - 3).join(",");

    output.push({
      index,
      uuid: uuidRaw.length > 0 ? uuidRaw : null,
      name: nameRaw.length > 0 ? nameRaw : null,
      memoryTotalMb: total,
      memoryUsedMb: used,
      memoryFreeMb: free
    });
  }

  return output;
}

export function evaluateVramPolicy(gpus: VramGpuSnapshot[], policy: VramPolicySnapshot): EvaluatedVramPolicy {
  if (gpus.length === 0) {
    return {
      constrained: false,
      reason: null,
      peakUsedMb: null,
      lowestFreeMb: null
    };
  }

  let peakUsedMb = 0;
  let lowestFreeMb = Number.POSITIVE_INFINITY;
  for (const gpu of gpus) {
    peakUsedMb = Math.max(peakUsedMb, gpu.memoryUsedMb);
    lowestFreeMb = Math.min(lowestFreeMb, gpu.memoryFreeMb);
  }

  if (peakUsedMb >= policy.highWatermarkMb) {
    return {
      constrained: true,
      reason: `max_used_mb ${peakUsedMb} >= ${policy.highWatermarkMb}`,
      peakUsedMb,
      lowestFreeMb
    };
  }

  if (lowestFreeMb <= policy.minFreeMb) {
    return {
      constrained: true,
      reason: `min_free_mb ${lowestFreeMb} <= ${policy.minFreeMb}`,
      peakUsedMb,
      lowestFreeMb
    };
  }

  if (lowestFreeMb < policy.taskReserveMb) {
    return {
      constrained: true,
      reason: `reserve_mb ${policy.taskReserveMb} exceeds free_mb ${lowestFreeMb}`,
      peakUsedMb,
      lowestFreeMb
    };
  }

  return {
    constrained: false,
    reason: null,
    peakUsedMb,
    lowestFreeMb
  };
}

async function probeVramSnapshotOnce(): Promise<VramSentinelSnapshot> {
  const policy = currentPolicy();
  const command = currentCommandConfig();
  const base: VramSentinelSnapshot = {
    enabled: env.VRAM_SENTINEL_ENABLED,
    failOpen: env.VRAM_SENTINEL_FAIL_OPEN,
    healthy: false,
    constrained: false,
    reason: null,
    source: "nvidia-smi",
    updatedAt: nowIso(),
    command: {
      executable: command.executable,
      argsCount: command.args.length
    },
    policy,
    gpus: [],
    summary: {
      gpusDetected: 0,
      peakUsedMb: null,
      lowestFreeMb: null
    },
    error: null
  };

  try {
    const timeoutMs = sanitizeInteger(env.VRAM_SENTINEL_COMMAND_TIMEOUT_MS, 2_000, 100, 30_000);
    const { stdout } = await execFileAsync(command.executable, command.args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });

    const gpus = parseNvidiaSmiCsvOutput(stdout);
    const evaluated = evaluateVramPolicy(gpus, policy);
    return {
      ...base,
      healthy: true,
      constrained: evaluated.constrained,
      reason: evaluated.reason,
      gpus,
      summary: {
        gpusDetected: gpus.length,
        peakUsedMb: evaluated.peakUsedMb,
        lowestFreeMb: evaluated.lowestFreeMb
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      healthy: false,
      constrained: false,
      reason: "probe_failed",
      error: message
    };
  }
}

export async function refreshVramSentinelSnapshot(): Promise<VramSentinelSnapshot> {
  if (!env.VRAM_SENTINEL_ENABLED) {
    lastSnapshot = makeDisabledSnapshot();
    return lastSnapshot;
  }

  if (probeInFlight) {
    return probeInFlight;
  }

  probeInFlight = (async () => {
    const snapshot = await probeVramSnapshotOnce();
    lastSnapshot = snapshot;
    return snapshot;
  })().finally(() => {
    probeInFlight = null;
  });

  return probeInFlight;
}

function snapshotAgeMs(snapshot: VramSentinelSnapshot): number {
  if (!snapshot.updatedAt) {
    return Number.POSITIVE_INFINITY;
  }
  const atMs = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(atMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Date.now() - atMs);
}

export async function ensureVramSentinelSnapshotFresh(): Promise<VramSentinelSnapshot> {
  if (!env.VRAM_SENTINEL_ENABLED) {
    if (lastSnapshot.enabled) {
      lastSnapshot = makeDisabledSnapshot();
    }
    return lastSnapshot;
  }

  const maxAgeMs = Math.max(300, sanitizeInteger(env.VRAM_SENTINEL_POLL_MS, 3_000, 200, 120_000) * 2);
  if (snapshotAgeMs(lastSnapshot) > maxAgeMs) {
    return refreshVramSentinelSnapshot();
  }

  return lastSnapshot;
}

export function getVramSentinelSnapshot(): VramSentinelSnapshot {
  return lastSnapshot;
}

export async function assertReyMeshyVramBudget(): Promise<VramGuardDecision> {
  const snapshot = await ensureVramSentinelSnapshotFresh();
  if (!env.VRAM_SENTINEL_ENABLED) {
    return {
      allowed: true,
      reason: null,
      snapshot
    };
  }

  if (!snapshot.healthy) {
    if (env.VRAM_SENTINEL_FAIL_OPEN) {
      return {
        allowed: true,
        reason: "probe_failed_fail_open",
        snapshot
      };
    }

    return {
      allowed: false,
      reason: "vram_probe_failed",
      snapshot
    };
  }

  if (snapshot.constrained) {
    return {
      allowed: false,
      reason: snapshot.reason ?? "vram_constrained",
      snapshot
    };
  }

  return {
    allowed: true,
    reason: null,
    snapshot
  };
}

export function startVramSentinel(): void {
  if (!env.VRAM_SENTINEL_ENABLED) {
    lastSnapshot = makeDisabledSnapshot();
    return;
  }

  if (pollTimer) {
    return;
  }

  void refreshVramSentinelSnapshot();
  const pollMs = Math.max(200, sanitizeInteger(env.VRAM_SENTINEL_POLL_MS, 3_000, 200, 120_000));
  pollTimer = setInterval(() => {
    void refreshVramSentinelSnapshot();
  }, pollMs);
  pollTimer.unref?.();
}

export async function stopVramSentinel(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (probeInFlight) {
    await probeInFlight.catch(() => {
      // ignore shutdown probe errors
    });
  }
}
