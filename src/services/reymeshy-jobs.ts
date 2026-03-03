import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { auditLog } from "../db/sqlite";
import { recordReyMeshyCleanupMetric } from "./reymeshy-metrics";
import { ReyMeshyMeshData, ReyMeshyPipelineOutput, runReyMeshyCleanup } from "./reymeshy-sidecar";
import { assertReyMeshyVramBudget } from "./vram-sentinel";

export type ReyMeshyCleanupJobStatus = "queued" | "running" | "succeeded" | "failed";

type ReyMeshyCleanupJobRecord = {
  id: string;
  userId: string;
  mesh?: ReyMeshyMeshData;
  status: ReyMeshyCleanupJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  inputBytes: number;
  inputVertices: number;
  inputTriangles: number;
  outputTriangles: number | null;
  remeshedTriangles: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  result: ReyMeshyPipelineOutput | null;
};

export type ReyMeshyCleanupJobView = {
  id: string;
  status: ReyMeshyCleanupJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  input: {
    bytes: number;
    vertices: number;
    triangles: number;
  };
  output: {
    remeshedTriangles: number | null;
    outputTriangles: number | null;
  };
  error: {
    code: string | null;
    message: string | null;
  };
  result: ReyMeshyPipelineOutput | null;
};

export type ReyMeshyCleanupQueueSnapshot = {
  pending: number;
  running: number;
  totalJobs: number;
  concurrency: number;
  maxStoredJobs: number;
};

const jobs = new Map<string, ReyMeshyCleanupJobRecord>();
const pendingJobIds: string[] = [];
const pendingJobSet = new Set<string>();
let activeWorkers = 0;

function clampInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.trunc(value);
  return Math.min(max, Math.max(min, rounded));
}

function resolveConcurrency(): number {
  return clampInteger(env.REYMESHY_JOB_CONCURRENCY, 1, 1, 8);
}

function resolveMaxStoredJobs(): number {
  return clampInteger(env.REYMESHY_JOB_MAX_STORED, 500, 100, 20_000);
}

function pruneJobsIfNeeded(): void {
  const maxStoredJobs = resolveMaxStoredJobs();
  if (jobs.size <= maxStoredJobs) {
    return;
  }

  for (const [jobId, job] of jobs) {
    if (jobs.size <= maxStoredJobs) {
      break;
    }
    if (job.status === "succeeded" || job.status === "failed") {
      jobs.delete(jobId);
    }
  }
}

function queueJob(jobId: string): void {
  if (pendingJobSet.has(jobId)) {
    return;
  }
  pendingJobSet.add(jobId);
  pendingJobIds.push(jobId);
}

function normalizeErrorCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout")) {
    return "sidecar_timeout";
  }
  return "sidecar_error";
}

function toJobView(job: ReyMeshyCleanupJobRecord, includeResult: boolean): ReyMeshyCleanupJobView {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    input: {
      bytes: job.inputBytes,
      vertices: job.inputVertices,
      triangles: job.inputTriangles
    },
    output: {
      remeshedTriangles: job.remeshedTriangles,
      outputTriangles: job.outputTriangles
    },
    error: {
      code: job.errorCode,
      message: job.errorMessage
    },
    result: includeResult ? job.result : null
  };
}

async function processCleanupJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job || job.status !== "queued" || !job.mesh) {
    return;
  }

  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  job.status = "running";
  job.startedAt = startedAtIso;
  job.updatedAt = startedAtIso;

  const vram = await assertReyMeshyVramBudget();
  if (!vram.allowed) {
    const finishedAtMs = Date.now();
    const finishedAtIso = new Date(finishedAtMs).toISOString();
    const latencyMs = finishedAtMs - startedAtMs;
    const details = `Feature disabled by VRAM constraints: ${vram.reason ?? "vram_constrained"}`;

    job.status = "failed";
    job.finishedAt = finishedAtIso;
    job.updatedAt = finishedAtIso;
    job.outputTriangles = null;
    job.remeshedTriangles = null;
    job.errorCode = "vram_guard";
    job.errorMessage = details;
    job.result = null;
    job.mesh = undefined;

    recordReyMeshyCleanupMetric({
      outcome: "error",
      latencyMs,
      inputBytes: job.inputBytes,
      inputVertices: job.inputVertices,
      inputTriangles: job.inputTriangles,
      outputTriangles: null,
      errorCode: "vram_guard"
    });

    await auditLog(job.userId, "reymeshy.job.failed", {
      jobId: job.id,
      input: {
        vertices: job.inputVertices,
        triangles: job.inputTriangles,
        bytes: job.inputBytes
      },
      error: details,
      latencyMs
    }).catch(() => {
      // Non-blocking audit failure.
    });

    pruneJobsIfNeeded();
    return;
  }

  try {
    const result = await runReyMeshyCleanup(job.mesh);
    const finishedAtMs = Date.now();
    const finishedAtIso = new Date(finishedAtMs).toISOString();
    const latencyMs = finishedAtMs - startedAtMs;
    const outputTriangles = result.lod_optimized.indices.length / 3;
    const remeshedTriangles = result.remeshed.indices.length / 3;

    job.status = "succeeded";
    job.finishedAt = finishedAtIso;
    job.updatedAt = finishedAtIso;
    job.outputTriangles = outputTriangles;
    job.remeshedTriangles = remeshedTriangles;
    job.errorCode = null;
    job.errorMessage = null;
    job.result = result;
    job.mesh = undefined;

    recordReyMeshyCleanupMetric({
      outcome: "ok",
      latencyMs,
      inputBytes: job.inputBytes,
      inputVertices: job.inputVertices,
      inputTriangles: job.inputTriangles,
      outputTriangles
    });

    await auditLog(job.userId, "reymeshy.job.complete", {
      jobId: job.id,
      input: {
        vertices: job.inputVertices,
        triangles: job.inputTriangles,
        bytes: job.inputBytes
      },
      output: {
        remeshedTriangles,
        lodTriangles: outputTriangles
      },
      latencyMs
    }).catch(() => {
      // Non-blocking audit failure.
    });
  } catch (error) {
    const finishedAtMs = Date.now();
    const finishedAtIso = new Date(finishedAtMs).toISOString();
    const latencyMs = finishedAtMs - startedAtMs;
    const details = error instanceof Error ? error.message : String(error);
    const errorCode = normalizeErrorCode(details);

    job.status = "failed";
    job.finishedAt = finishedAtIso;
    job.updatedAt = finishedAtIso;
    job.outputTriangles = null;
    job.remeshedTriangles = null;
    job.errorCode = errorCode;
    job.errorMessage = details;
    job.result = null;
    job.mesh = undefined;

    recordReyMeshyCleanupMetric({
      outcome: "error",
      latencyMs,
      inputBytes: job.inputBytes,
      inputVertices: job.inputVertices,
      inputTriangles: job.inputTriangles,
      outputTriangles: null,
      errorCode
    });

    await auditLog(job.userId, "reymeshy.job.failed", {
      jobId: job.id,
      input: {
        vertices: job.inputVertices,
        triangles: job.inputTriangles,
        bytes: job.inputBytes
      },
      error: details,
      latencyMs
    }).catch(() => {
      // Non-blocking audit failure.
    });
  } finally {
    pruneJobsIfNeeded();
  }
}

function pumpQueue(): void {
  const concurrency = resolveConcurrency();
  while (activeWorkers < concurrency && pendingJobIds.length > 0) {
    const nextJobId = pendingJobIds.shift();
    if (!nextJobId) {
      break;
    }

    pendingJobSet.delete(nextJobId);
    activeWorkers += 1;
    void processCleanupJob(nextJobId).finally(() => {
      activeWorkers = Math.max(0, activeWorkers - 1);
      if (pendingJobIds.length > 0) {
        pumpQueue();
      }
    });
  }
}

export function createReyMeshyCleanupJob(input: { userId: string; mesh: ReyMeshyMeshData }): ReyMeshyCleanupJobView {
  const id = randomUUID();
  const now = new Date().toISOString();
  const inputVertices = input.mesh.vertices.length / 3;
  const inputTriangles = input.mesh.indices.length / 3;
  const inputBytes = Buffer.byteLength(JSON.stringify(input.mesh), "utf8");

  const record: ReyMeshyCleanupJobRecord = {
    id,
    userId: input.userId,
    mesh: input.mesh,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    inputBytes,
    inputVertices,
    inputTriangles,
    outputTriangles: null,
    remeshedTriangles: null,
    errorCode: null,
    errorMessage: null,
    result: null
  };

  jobs.set(id, record);
  pruneJobsIfNeeded();
  queueJob(id);
  pumpQueue();
  return toJobView(record, false);
}

export function getReyMeshyCleanupJobForUser(
  input: { userId: string; jobId: string; includeResult?: boolean }
): ReyMeshyCleanupJobView | null {
  const job = jobs.get(input.jobId);
  if (!job || job.userId !== input.userId) {
    return null;
  }
  return toJobView(job, input.includeResult === true);
}

export function getReyMeshyCleanupQueueSnapshot(): ReyMeshyCleanupQueueSnapshot {
  let running = 0;
  for (const job of jobs.values()) {
    if (job.status === "running") {
      running += 1;
    }
  }

  return {
    pending: pendingJobIds.length,
    running,
    totalJobs: jobs.size,
    concurrency: resolveConcurrency(),
    maxStoredJobs: resolveMaxStoredJobs()
  };
}

export function resetReyMeshyCleanupJobsForTests(): void {
  jobs.clear();
  pendingJobIds.splice(0, pendingJobIds.length);
  pendingJobSet.clear();
  activeWorkers = 0;
}
