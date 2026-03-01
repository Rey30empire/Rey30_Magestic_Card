import { randomUUID } from "node:crypto";
import { all, get, run } from "../db/sqlite";
import { isPostgresDualWriteEnabled, mirrorTrainingJob } from "../db/postgres";
import { ClientPlatform } from "../types/platform";
import { env } from "../config/env";

type TrainingJobRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  agent_id: string | null;
  idempotency_key: string | null;
  mode: string;
  status: "queued" | "running" | "succeeded" | "failed";
  config: string;
  platform: ClientPlatform;
  logs: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type RunnerConfig = {
  maxRetries: number;
  simulateFailAttempts: number;
  stepDelayMs: number;
  maxRuntimeMs: number;
};

const queuedJobIds: string[] = [];
const queuedSet = new Set<string>();
let workerRunning = false;
let localRunnerEnabled = false;
let queueBootstrapped = false;
let workerPollTimer: NodeJS.Timeout | null = null;
const activeJobAbortControllers = new Map<string, AbortController>();

function parseJsonValue(raw: string, fallback: unknown): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fallback;
  }
}

async function mirrorTrainingJobRow(row: TrainingJobRow | undefined): Promise<void> {
  if (!row) {
    return;
  }

  try {
    await mirrorTrainingJob({
      id: row.id,
      userId: row.user_id,
      projectId: row.project_id,
      agentId: row.agent_id,
      idempotencyKey: row.idempotency_key,
      mode: row.mode,
      status: row.status,
      config: parseJsonValue(row.config, {}),
      platform: row.platform,
      logs: parseJsonValue(row.logs, []),
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    });
  } catch (error) {
    console.error("[postgres-mirror] training job mirror failed", { jobId: row.id, error });
  }
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<"done" | "aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("done");
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve("aborted");
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseLogs(existingLogs: string): string[] {
  try {
    const parsed = JSON.parse(existingLogs) as unknown;
    return Array.isArray(parsed) ? parsed.filter((line): line is string => typeof line === "string") : [];
  } catch {
    return [];
  }
}

function appendLog(existingLogs: string, line: string): string {
  const logs = parseLogs(existingLogs);
  logs.push(`${new Date().toISOString()} ${line}`);
  return JSON.stringify(logs);
}

function countAttempts(existingLogs: string): number {
  return parseLogs(existingLogs).filter((line) => line.includes("attempt ") && line.includes("started")).length;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.trunc(value);
  return Math.min(max, Math.max(min, rounded));
}

function parseRunnerConfig(configRaw: string): RunnerConfig {
  let config: Record<string, unknown> = {};

  try {
    const parsed = JSON.parse(configRaw) as unknown;
    if (parsed && typeof parsed === "object") {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    config = {};
  }

  return {
    maxRetries: clampInteger(config.maxRetries, 1, 0, 5),
    simulateFailAttempts: clampInteger(config.simulateFailAttempts, 0, 0, 10),
    stepDelayMs: clampInteger(config.simulateStepDelayMs, 350, 120, 5000),
    maxRuntimeMs: clampInteger(config.maxRuntimeMs, env.TRAINING_JOB_MAX_RUNTIME_MS, 0, 120_000)
  };
}

function enqueueJob(jobId: string): void {
  if (queuedSet.has(jobId)) {
    return;
  }

  queuedSet.add(jobId);
  queuedJobIds.push(jobId);
  void ensureWorkerRunning();
}

export function enqueueTrainingJobForRunner(jobId: string): void {
  if (!localRunnerEnabled) {
    return;
  }

  enqueueJob(jobId);
}

export async function enqueueTrainingJobFromQueue(jobId: string): Promise<void> {
  const row = await get<Pick<TrainingJobRow, "id" | "status">>("SELECT id, status FROM training_jobs WHERE id = ?", [jobId]);
  if (!row) {
    throw new Error(`Training job not found: ${jobId}`);
  }

  if (row.status === "failed" || row.status === "succeeded") {
    return;
  }

  if (!localRunnerEnabled) {
    throw new Error("Training local runner is not enabled");
  }

  enqueueJob(jobId);
}

function dequeueJob(jobId: string): void {
  if (!queuedSet.has(jobId)) {
    return;
  }

  queuedSet.delete(jobId);

  for (let index = queuedJobIds.length - 1; index >= 0; index -= 1) {
    if (queuedJobIds[index] === jobId) {
      queuedJobIds.splice(index, 1);
    }
  }
}

async function appendJobLog(job: TrainingJobRow, line: string): Promise<void> {
  const current = await refreshJob(job.id);
  if (!current || current.status === "failed" || current.status === "succeeded") {
    return;
  }

  const updated = await run(
    `
      UPDATE training_jobs
      SET logs = ?, updated_at = ?
      WHERE id = ?
        AND status IN ('queued', 'running')
    `,
    [appendLog(current.logs, line), new Date().toISOString(), current.id]
  );

  if (updated.changes > 0) {
    await mirrorTrainingJobById(current.id);
  }
}

async function refreshJob(jobId: string): Promise<TrainingJobRow | undefined> {
  return get<TrainingJobRow>("SELECT * FROM training_jobs WHERE id = ?", [jobId]);
}

async function mirrorTrainingJobById(jobId: string): Promise<void> {
  if (!isPostgresDualWriteEnabled()) {
    return;
  }

  await mirrorTrainingJobRow(await refreshJob(jobId));
}

function createJobAbortController(jobId: string): AbortController {
  const controller = new AbortController();
  activeJobAbortControllers.set(jobId, controller);
  return controller;
}

function clearJobAbortController(jobId: string): void {
  activeJobAbortControllers.delete(jobId);
}

function abortActiveJob(jobId: string): void {
  const controller = activeJobAbortControllers.get(jobId);
  if (!controller) {
    return;
  }
  controller.abort();
}

async function markJobTimedOut(job: TrainingJobRow, attempt: number, timeoutMs: number): Promise<void> {
  const current = await refreshJob(job.id);
  if (!current || current.status !== "running") {
    return;
  }

  const now = new Date().toISOString();
  const timedOut = await run(
    `
      UPDATE training_jobs
      SET status = 'failed',
          logs = ?,
          error_message = ?,
          finished_at = ?,
          updated_at = ?
      WHERE id = ?
        AND status = 'running'
    `,
    [appendLog(current.logs, `attempt ${attempt} timed out after ${timeoutMs}ms`), "job timeout", now, now, current.id]
  );

  if (timedOut.changes > 0) {
    await mirrorTrainingJobById(current.id);
  }
}

async function processJob(jobId: string): Promise<void> {
  const initial = await refreshJob(jobId);
  if (!initial) {
    return;
  }

  if (initial.status === "failed" || initial.status === "succeeded") {
    return;
  }

  const cfg = parseRunnerConfig(initial.config);
  const attempt = countAttempts(initial.logs) + 1;
  const startedAt = new Date().toISOString();
  const toRunning = await run(
    `
      UPDATE training_jobs
      SET status = 'running',
          logs = ?,
          error_message = NULL,
          started_at = COALESCE(started_at, ?),
          finished_at = NULL,
          updated_at = ?
      WHERE id = ?
        AND status IN ('queued', 'running')
    `,
    [appendLog(initial.logs, `attempt ${attempt} started (simulated runner)`), startedAt, startedAt, jobId]
  );

  if (toRunning.changes === 0) {
    return;
  }

  const abortController = createJobAbortController(jobId);
  const startedAtMs = Date.now();
  const deadlineMs = cfg.maxRuntimeMs > 0 ? startedAtMs + cfg.maxRuntimeMs : null;

  await mirrorTrainingJobById(jobId);

  try {
    const steps = ["prepare inputs", "run training step", "evaluate outputs"];
    for (const step of steps) {
      const remainingMs = deadlineMs === null ? null : deadlineMs - Date.now();
      if (remainingMs !== null && remainingMs <= 0) {
        await markJobTimedOut(initial, attempt, cfg.maxRuntimeMs);
        return;
      }

      const waitMs = remainingMs === null ? cfg.stepDelayMs : Math.max(1, Math.min(cfg.stepDelayMs, remainingMs));
      const sleepResult = await sleepWithSignal(waitMs, abortController.signal);
      if (sleepResult === "aborted") {
        return;
      }

      const row = await refreshJob(jobId);
      if (!row || row.status === "failed" || row.status === "succeeded") {
        return;
      }

      if (deadlineMs !== null && Date.now() >= deadlineMs) {
        await markJobTimedOut(row, attempt, cfg.maxRuntimeMs);
        return;
      }

      await appendJobLog(row, `attempt ${attempt}: ${step}`);
    }

    const current = await refreshJob(jobId);
    if (!current || current.status === "failed" || current.status === "succeeded") {
      return;
    }

    if (deadlineMs !== null && Date.now() >= deadlineMs) {
      await markJobTimedOut(current, attempt, cfg.maxRuntimeMs);
      return;
    }

    const failedBySimulation = attempt <= cfg.simulateFailAttempts;
    const now = new Date().toISOString();

    if (failedBySimulation) {
      const canRetry = attempt <= cfg.maxRetries;
      if (canRetry) {
        const requeue = await run(
          `
            UPDATE training_jobs
            SET status = 'queued',
                logs = ?,
                error_message = ?,
                finished_at = NULL,
                updated_at = ?
            WHERE id = ?
              AND status = 'running'
          `,
          [appendLog(current.logs, `attempt ${attempt} failed; retry queued`), `attempt ${attempt} failed (retry scheduled)`, now, jobId]
        );

        if (requeue.changes > 0) {
          await mirrorTrainingJobById(jobId);
          enqueueTrainingJobForRunner(jobId);
        }

        return;
      }

      const toFailed = await run(
        `
          UPDATE training_jobs
          SET status = 'failed',
              logs = ?,
              error_message = ?,
              finished_at = ?,
              updated_at = ?
          WHERE id = ?
            AND status = 'running'
        `,
        [appendLog(current.logs, `attempt ${attempt} failed permanently`), "simulated failure", now, now, jobId]
      );

      if (toFailed.changes > 0) {
        await mirrorTrainingJobById(jobId);
      }

      return;
    }

    const toSucceeded = await run(
      `
        UPDATE training_jobs
        SET status = 'succeeded',
            logs = ?,
            error_message = NULL,
            finished_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'running'
      `,
      [appendLog(current.logs, `attempt ${attempt} completed successfully`), now, now, jobId]
    );

    if (toSucceeded.changes > 0) {
      await mirrorTrainingJobById(jobId);
    }
  } finally {
    clearJobAbortController(jobId);
  }
}

async function runWorker(): Promise<void> {
  while (queuedJobIds.length > 0) {
    const next = queuedJobIds.shift();
    if (!next) {
      continue;
    }

    queuedSet.delete(next);
    await processJob(next);
  }
}

async function ensureWorkerRunning(): Promise<void> {
  if (workerRunning) {
    return;
  }

  workerRunning = true;
  try {
    await runWorker();
  } finally {
    workerRunning = false;
    if (queuedJobIds.length > 0) {
      void ensureWorkerRunning();
    }
  }
}

async function bootstrapQueueFromDatabase(): Promise<void> {
  if (queueBootstrapped) {
    return;
  }

  queueBootstrapped = true;
  const recoverable = await all<TrainingJobRow>(
    `
      SELECT * FROM training_jobs
      WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC
    `
  );

  for (const row of recoverable) {
    if (row.status === "running") {
      const now = new Date().toISOString();
      const recovery = await run(
        `
          UPDATE training_jobs
          SET status = 'queued',
              logs = ?,
              error_message = ?,
              updated_at = ?
          WHERE id = ?
        `,
        [appendLog(row.logs, "job recovered after restart and re-queued"), "runner restarted", now, row.id]
      );

      if (recovery.changes > 0) {
        await mirrorTrainingJobById(row.id);
      }
    }

    enqueueJob(row.id);
  }
}

async function scanQueuedJobsIntoLocalQueue(limit = 200): Promise<void> {
  const rows = await all<{ id: string }>(
    `
      SELECT id
      FROM training_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT ?
    `,
    [limit]
  );

  for (const row of rows) {
    enqueueJob(row.id);
  }
}

export async function startTrainingJobRunner(): Promise<void> {
  localRunnerEnabled = true;
  await bootstrapQueueFromDatabase();
  await ensureWorkerRunning();
}

export async function startTrainingJobWorkerPolling(options?: { pollMs?: number }): Promise<void> {
  await startTrainingJobRunner();

  if (workerPollTimer) {
    return;
  }

  const pollMs = Math.max(100, options?.pollMs ?? 500);
  await scanQueuedJobsIntoLocalQueue();

  workerPollTimer = setInterval(() => {
    void scanQueuedJobsIntoLocalQueue();
  }, pollMs);
}

export function stopTrainingJobWorkerPolling(): void {
  if (!workerPollTimer) {
    return;
  }

  clearInterval(workerPollTimer);
  workerPollTimer = null;
}

export async function createTrainingJob(input: {
  userId: string;
  projectId?: string;
  agentId?: string;
  idempotencyKey?: string;
  mode: string;
  config: Record<string, unknown>;
  platform: ClientPlatform;
}): Promise<{ id: string; reused: boolean }> {
  if (input.idempotencyKey) {
    const existing = await get<{ id: string }>(
      `
        SELECT id
        FROM training_jobs
        WHERE user_id = ?
          AND idempotency_key = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [input.userId, input.idempotencyKey]
    );

    if (existing?.id) {
      return { id: existing.id, reused: true };
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  try {
    await run(
      `
        INSERT INTO training_jobs (
          id, user_id, project_id, agent_id, idempotency_key, mode, status, config, platform, logs,
          error_message, created_at, updated_at, started_at, finished_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, NULL, ?, ?, NULL, NULL)
      `,
      [
        id,
        input.userId,
        input.projectId ?? null,
        input.agentId ?? null,
        input.idempotencyKey ?? null,
        input.mode,
        JSON.stringify(input.config),
        input.platform,
        JSON.stringify([`${now} job queued`]),
        now,
        now
      ]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      input.idempotencyKey &&
      (message.includes("UNIQUE constraint failed: training_jobs.user_id, training_jobs.idempotency_key") ||
        message.includes("idx_training_jobs_user_idempotency"))
    ) {
      const existing = await get<{ id: string }>(
        `
          SELECT id
          FROM training_jobs
          WHERE user_id = ?
            AND idempotency_key = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [input.userId, input.idempotencyKey]
      );
      if (existing?.id) {
        return { id: existing.id, reused: true };
      }
    }

    throw error;
  }

  await mirrorTrainingJobById(id);

  enqueueTrainingJobForRunner(id);
  return { id, reused: false };
}

export async function listTrainingJobs(userId: string): Promise<TrainingJobRow[]> {
  return all<TrainingJobRow>("SELECT * FROM training_jobs WHERE user_id = ? ORDER BY created_at DESC", [userId]);
}

export type TrainingOpsSnapshot = {
  timestamp: string;
  windowMinutes: number;
  queueDepth: number;
  active: {
    queued: number;
    running: number;
  };
  window: {
    finishedTotal: number;
    succeeded: number;
    failed: number;
    successRatePercent: number | null;
    failureRatePercent: number | null;
    avgDurationMs: number | null;
  };
};

export async function getTrainingOpsSnapshot(windowMinutes = 15): Promise<TrainingOpsSnapshot> {
  const safeWindowMinutes = Math.max(1, Math.min(180, Math.trunc(windowMinutes)));
  const windowStartIso = new Date(Date.now() - safeWindowMinutes * 60_000).toISOString();

  const activeCounts = await get<{
    queued: number | null;
    running: number | null;
  }>(
    `
      SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
      FROM training_jobs
    `
  );

  const windowStats = await get<{
    finished_total: number | null;
    succeeded_total: number | null;
    failed_total: number | null;
    avg_duration_ms: number | null;
  }>(
    `
      SELECT
        COUNT(*) as finished_total,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as succeeded_total,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_total,
        AVG(
          CASE
            WHEN started_at IS NOT NULL AND finished_at IS NOT NULL THEN
              (julianday(finished_at) - julianday(started_at)) * 86400000.0
            ELSE NULL
          END
        ) as avg_duration_ms
      FROM training_jobs
      WHERE finished_at IS NOT NULL
        AND finished_at >= ?
    `,
    [windowStartIso]
  );

  const queued = Number(activeCounts?.queued ?? 0);
  const running = Number(activeCounts?.running ?? 0);
  const finishedTotal = Number(windowStats?.finished_total ?? 0);
  const succeeded = Number(windowStats?.succeeded_total ?? 0);
  const failed = Number(windowStats?.failed_total ?? 0);
  const successRatePercent = finishedTotal > 0 ? (succeeded / finishedTotal) * 100 : null;
  const failureRatePercent = finishedTotal > 0 ? (failed / finishedTotal) * 100 : null;
  const avgDurationMs =
    windowStats?.avg_duration_ms !== null && windowStats?.avg_duration_ms !== undefined
      ? Number(windowStats.avg_duration_ms)
      : null;

  return {
    timestamp: new Date().toISOString(),
    windowMinutes: safeWindowMinutes,
    queueDepth: queued + running,
    active: {
      queued,
      running
    },
    window: {
      finishedTotal,
      succeeded,
      failed,
      successRatePercent,
      failureRatePercent,
      avgDurationMs
    }
  };
}

export async function cancelTrainingJob(userId: string, jobId: string): Promise<boolean> {
  const row = await get<TrainingJobRow>("SELECT * FROM training_jobs WHERE id = ? AND user_id = ?", [jobId, userId]);
  if (!row) {
    return false;
  }

  if (row.status === "failed" || row.status === "succeeded") {
    return true;
  }

  dequeueJob(jobId);
  abortActiveJob(jobId);

  const cancelledAt = new Date().toISOString();
  const cancellation = await run(
    `
      UPDATE training_jobs
      SET status = 'failed',
          error_message = 'cancelled by user',
          logs = ?,
          finished_at = ?,
          updated_at = ?
      WHERE id = ? AND user_id = ?
        AND status IN ('queued', 'running')
    `,
    [appendLog(row.logs, "job cancelled by user"), cancelledAt, cancelledAt, jobId, userId]
  );

  if (cancellation.changes > 0) {
    await mirrorTrainingJobById(jobId);
  }

  return true;
}

export type TrainingRequeuePrepareResult = {
  jobId: string;
  statusBefore: "queued" | "running" | "succeeded" | "failed";
  statusAfter: "queued" | "running" | "succeeded" | "failed";
  updated: boolean;
};

export async function prepareTrainingJobForRequeue(jobId: string, reason = "job requeued from DLQ"): Promise<TrainingRequeuePrepareResult> {
  const row = await get<TrainingJobRow>("SELECT * FROM training_jobs WHERE id = ?", [jobId]);
  if (!row) {
    throw new Error("Training job not found");
  }

  if (row.status === "succeeded") {
    throw new Error("Training job already succeeded and cannot be requeued");
  }

  if (row.status === "queued") {
    enqueueTrainingJobForRunner(jobId);
    return {
      jobId,
      statusBefore: row.status,
      statusAfter: row.status,
      updated: false
    };
  }

  const now = new Date().toISOString();
  const update = await run(
    `
      UPDATE training_jobs
      SET status = 'queued',
          logs = ?,
          error_message = NULL,
          started_at = NULL,
          finished_at = NULL,
          updated_at = ?
      WHERE id = ?
        AND status IN ('failed', 'running')
    `,
    [appendLog(row.logs, reason), now, jobId]
  );

  if (update.changes > 0) {
    await mirrorTrainingJobById(jobId);
  }

  const latest = await refreshJob(jobId);
  if (!latest) {
    throw new Error("Training job not found");
  }

  if (latest.status !== "queued") {
    throw new Error(`Training job status is ${latest.status} and cannot be requeued`);
  }

  enqueueTrainingJobForRunner(jobId);
  return {
    jobId,
    statusBefore: row.status,
    statusAfter: latest.status,
    updated: update.changes > 0
  };
}

export function mapTrainingJob(row: TrainingJobRow): Record<string, unknown> {
  const logs = (() => {
    try {
      const parsed = JSON.parse(row.logs) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    mode: row.mode,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    platform: row.platform,
    config: (() => {
      try {
        return JSON.parse(row.config) as unknown;
      } catch {
        return {};
      }
    })(),
    logs,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    note: "MVP simulated pipeline with queue/retries. Supports inline or external worker modes."
  };
}
