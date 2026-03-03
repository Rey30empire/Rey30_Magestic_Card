import { randomUUID } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { all, get, run } from "../db/sqlite";
import { isPostgresDualWriteEnabled, mirrorTrainingJob } from "../db/postgres";
import { isSqlServerDualWriteEnabled, mirrorTrainingJobToSqlServer } from "../db/sqlserver";
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
  cancel_requested: number | null;
  cancel_requested_at: string | null;
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
  stageTimeoutMs: number;
};

type TrainingProcessMode = "local" | "queue";
type TrainingProcessResultKind = "skipped" | "succeeded" | "cancelled" | "retryable_failed" | "terminal_failed";
type TrainingProcessResult = {
  kind: TrainingProcessResultKind;
  reason?: string;
};

export type TrainingQueueAttemptInput = {
  jobId: string;
  attempt: number;
  maxAttempts: number;
  queueJobId?: string;
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

  try {
    await mirrorTrainingJobToSqlServer({
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
    console.error("[sqlserver-mirror] training job mirror failed", { jobId: row.id, error });
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
    maxRuntimeMs: clampInteger(config.maxRuntimeMs, env.TRAINING_JOB_MAX_RUNTIME_MS, 0, 120_000),
    stageTimeoutMs: clampInteger(config.stageTimeoutMs, env.TRAINING_STAGE_TIMEOUT_MS, 0, 120_000)
  };
}

function isTerminalStatus(status: TrainingJobRow["status"]): boolean {
  return status === "failed" || status === "succeeded";
}

function isCancellationRequested(row: Pick<TrainingJobRow, "cancel_requested">): boolean {
  return Number(row.cancel_requested ?? 0) > 0;
}

function sanitizeQueueAttemptNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
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
  const row = await get<Pick<TrainingJobRow, "id" | "status" | "cancel_requested">>(
    "SELECT id, status, cancel_requested FROM training_jobs WHERE id = ?",
    [jobId]
  );
  if (!row) {
    throw new Error(`Training job not found: ${jobId}`);
  }

  if (isTerminalStatus(row.status)) {
    return;
  }

  if (isCancellationRequested(row)) {
    await markQueuedOrRunningCancelled(jobId, "job cancelled before local enqueue from queue");
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
  if (!isPostgresDualWriteEnabled() && !isSqlServerDualWriteEnabled()) {
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

async function markRunningJobFailed(jobId: string, logLine: string, errorMessage: string): Promise<boolean> {
  const current = await refreshJob(jobId);
  if (!current || current.status !== "running") {
    return false;
  }

  const now = new Date().toISOString();
  const failed = await run(
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
    [appendLog(current.logs, logLine), errorMessage, now, now, current.id]
  );

  if (failed.changes > 0) {
    await mirrorTrainingJobById(current.id);
  }

  return failed.changes > 0;
}

async function markQueuedOrRunningCancelled(jobId: string, logLine: string): Promise<boolean> {
  const current = await refreshJob(jobId);
  if (!current || isTerminalStatus(current.status)) {
    return false;
  }
  const normalizedLogLine = logLine.includes("job cancelled by user") ? logLine : `${logLine} (job cancelled by user)`;

  const now = new Date().toISOString();
  const failed = await run(
    `
      UPDATE training_jobs
      SET status = 'failed',
          logs = ?,
          error_message = 'cancelled by user',
          cancel_requested = 1,
          cancel_requested_at = COALESCE(cancel_requested_at, ?),
          finished_at = ?,
          updated_at = ?
      WHERE id = ?
        AND status IN ('queued', 'running')
    `,
    [appendLog(current.logs, normalizedLogLine), now, now, now, current.id]
  );

  if (failed.changes > 0) {
    await mirrorTrainingJobById(current.id);
  }

  return failed.changes > 0;
}

async function markRunningJobForRetry(jobId: string, attempt: number): Promise<boolean> {
  const current = await refreshJob(jobId);
  if (!current || current.status !== "running") {
    return false;
  }

  const now = new Date().toISOString();
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
    [appendLog(current.logs, `attempt ${attempt} failed; retry queued`), `attempt ${attempt} failed (retry scheduled)`, now, current.id]
  );

  if (requeue.changes > 0) {
    await mirrorTrainingJobById(current.id);
  }

  return requeue.changes > 0;
}

async function markRunningJobSucceeded(jobId: string, attempt: number): Promise<boolean> {
  const current = await refreshJob(jobId);
  if (!current || current.status !== "running") {
    return false;
  }

  const now = new Date().toISOString();
  const succeeded = await run(
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
    [appendLog(current.logs, `attempt ${attempt} completed successfully`), now, now, current.id]
  );

  if (succeeded.changes > 0) {
    await mirrorTrainingJobById(current.id);
  }

  return succeeded.changes > 0;
}

async function markRunningJobTimedOut(jobId: string, attempt: number, timeoutMs: number): Promise<boolean> {
  return markRunningJobFailed(jobId, `attempt ${attempt} timed out after ${timeoutMs}ms`, "job timeout");
}

async function markRunningJobStageTimedOut(jobId: string, attempt: number, stage: string, timeoutMs: number): Promise<boolean> {
  return markRunningJobFailed(jobId, `attempt ${attempt} stage '${stage}' timed out after ${timeoutMs}ms`, "stage timeout");
}

function computeStepWaitBudget(stepDelayMs: number, runtimeRemainingMs: number | null, stageTimeoutMs: number): {
  waitMs: number;
  timeoutKind: "runtime" | "stage" | null;
} {
  let waitMs = stepDelayMs;
  let timeoutKind: "runtime" | "stage" | null = null;

  if (runtimeRemainingMs !== null && runtimeRemainingMs < waitMs) {
    waitMs = runtimeRemainingMs;
    timeoutKind = "runtime";
  }

  if (stageTimeoutMs > 0 && stageTimeoutMs < waitMs) {
    waitMs = stageTimeoutMs;
    timeoutKind = "stage";
  }

  return {
    waitMs: Math.max(1, Math.trunc(waitMs)),
    timeoutKind
  };
}

async function processJobInternal(input: {
  jobId: string;
  mode: TrainingProcessMode;
  queueAttempt?: number;
  queueMaxAttempts?: number;
  queueJobId?: string;
}): Promise<TrainingProcessResult> {
  const initial = await refreshJob(input.jobId);
  if (!initial) {
    if (input.mode === "queue") {
      return {
        kind: "terminal_failed",
        reason: `Training job not found: ${input.jobId}`
      };
    }
    return { kind: "skipped" };
  }

  if (isTerminalStatus(initial.status)) {
    return { kind: "skipped" };
  }

  const cfg = parseRunnerConfig(initial.config);
  const attempt =
    input.mode === "queue" ? sanitizeQueueAttemptNumber(input.queueAttempt ?? 1, 1) : countAttempts(initial.logs) + 1;
  const queueMaxAttempts =
    input.mode === "queue" ? sanitizeQueueAttemptNumber(input.queueMaxAttempts ?? 1, 1) : sanitizeQueueAttemptNumber(cfg.maxRetries + 1, 1);

  if (isCancellationRequested(initial)) {
    const cancelled = await markQueuedOrRunningCancelled(input.jobId, `attempt ${attempt} cancellation acknowledged before start`);
    return cancelled
      ? { kind: "cancelled", reason: "cancelled by user" }
      : { kind: "skipped", reason: "job is already terminal" };
  }

  const startedAt = new Date().toISOString();
  const startMessage =
    input.mode === "queue"
      ? `attempt ${attempt} started (redis queue worker${input.queueJobId ? ` queueJobId=${input.queueJobId}` : ""})`
      : `attempt ${attempt} started (simulated runner)`;

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
    [appendLog(initial.logs, startMessage), startedAt, startedAt, input.jobId]
  );

  if (toRunning.changes === 0) {
    return { kind: "skipped" };
  }

  const abortController = createJobAbortController(input.jobId);
  const startedAtMs = Date.now();
  const runtimeDeadlineMs = cfg.maxRuntimeMs > 0 ? startedAtMs + cfg.maxRuntimeMs : null;

  await mirrorTrainingJobById(input.jobId);

  try {
    const steps = ["prepare inputs", "run training step", "evaluate outputs"];
    for (const step of steps) {
      const runtimeRemainingMs = runtimeDeadlineMs === null ? null : runtimeDeadlineMs - Date.now();
      if (runtimeRemainingMs !== null && runtimeRemainingMs <= 0) {
        await markRunningJobTimedOut(input.jobId, attempt, cfg.maxRuntimeMs);
        return { kind: "terminal_failed", reason: "job timeout" };
      }

      const budget = computeStepWaitBudget(cfg.stepDelayMs, runtimeRemainingMs, cfg.stageTimeoutMs);
      const sleepResult = await sleepWithSignal(budget.waitMs, abortController.signal);
      if (sleepResult === "aborted") {
        const current = await refreshJob(input.jobId);
        if (!current || isTerminalStatus(current.status)) {
          return { kind: "skipped" };
        }

        if (isCancellationRequested(current)) {
          await markQueuedOrRunningCancelled(input.jobId, `attempt ${attempt} cancellation acknowledged`);
          return { kind: "cancelled", reason: "cancelled by user" };
        }

        return { kind: "skipped", reason: "job aborted" };
      }

      const row = await refreshJob(input.jobId);
      if (!row || isTerminalStatus(row.status)) {
        return { kind: "skipped" };
      }

      if (isCancellationRequested(row)) {
        await markQueuedOrRunningCancelled(input.jobId, `attempt ${attempt} cancellation acknowledged`);
        return { kind: "cancelled", reason: "cancelled by user" };
      }

      if (budget.timeoutKind === "runtime") {
        await markRunningJobTimedOut(input.jobId, attempt, cfg.maxRuntimeMs);
        return { kind: "terminal_failed", reason: "job timeout" };
      }

      if (budget.timeoutKind === "stage") {
        await markRunningJobStageTimedOut(input.jobId, attempt, step, cfg.stageTimeoutMs);
        return { kind: "terminal_failed", reason: "stage timeout" };
      }

      await appendJobLog(row, `attempt ${attempt}: ${step}`);
    }

    const current = await refreshJob(input.jobId);
    if (!current || isTerminalStatus(current.status)) {
      return { kind: "skipped" };
    }

    if (isCancellationRequested(current)) {
      await markQueuedOrRunningCancelled(input.jobId, `attempt ${attempt} cancellation acknowledged`);
      return { kind: "cancelled", reason: "cancelled by user" };
    }

    if (runtimeDeadlineMs !== null && Date.now() >= runtimeDeadlineMs) {
      await markRunningJobTimedOut(input.jobId, attempt, cfg.maxRuntimeMs);
      return { kind: "terminal_failed", reason: "job timeout" };
    }

    const failedBySimulation = attempt <= cfg.simulateFailAttempts;
    if (failedBySimulation) {
      const canRetryByConfig = attempt <= cfg.maxRetries;
      const canRetryByQueueBudget = input.mode === "queue" ? attempt < queueMaxAttempts : true;
      const canRetry = canRetryByConfig && canRetryByQueueBudget;

      if (canRetry) {
        const requeued = await markRunningJobForRetry(input.jobId, attempt);
        if (requeued && input.mode === "local") {
          enqueueTrainingJobForRunner(input.jobId);
        }
        return {
          kind: "retryable_failed",
          reason: `attempt ${attempt} failed (retry scheduled)`
        };
      }

      await markRunningJobFailed(input.jobId, `attempt ${attempt} failed permanently`, "simulated failure");
      return { kind: "terminal_failed", reason: "simulated failure" };
    }

    await markRunningJobSucceeded(input.jobId, attempt);
    return { kind: "succeeded" };
  } finally {
    clearJobAbortController(input.jobId);
  }
}

async function processJob(jobId: string): Promise<void> {
  await processJobInternal({
    jobId,
    mode: "local"
  });
}

export async function processTrainingJobQueueAttempt(input: TrainingQueueAttemptInput): Promise<void> {
  const result = await processJobInternal({
    jobId: input.jobId,
    mode: "queue",
    queueAttempt: input.attempt,
    queueMaxAttempts: input.maxAttempts,
    queueJobId: input.queueJobId
  });

  if (result.kind === "retryable_failed") {
    throw new Error(result.reason ?? `Training queue attempt should retry: ${input.jobId}`);
  }

  if (result.kind === "terminal_failed") {
    throw new UnrecoverableError(result.reason ?? `Training queue attempt failed: ${input.jobId}`);
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
    if (isCancellationRequested(row)) {
      const cancelled = await markQueuedOrRunningCancelled(row.id, "job recovered after restart and marked cancelled");
      if (cancelled) {
        continue;
      }
    }

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
          error_message, cancel_requested, cancel_requested_at, created_at, updated_at, started_at, finished_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, NULL, 0, NULL, ?, ?, NULL, NULL)
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

  if (isTerminalStatus(row.status)) {
    return true;
  }

  dequeueJob(jobId);
  const cancelledAt = new Date().toISOString();
  let cancellationChanges = 0;

  if (row.status === "queued") {
    const queuedCurrent = await refreshJob(jobId);
    const queuedLogs = queuedCurrent ? queuedCurrent.logs : row.logs;
    const queuedCancellation = await run(
      `
        UPDATE training_jobs
        SET status = 'failed',
            error_message = 'cancelled by user',
            logs = ?,
            cancel_requested = 1,
            cancel_requested_at = COALESCE(cancel_requested_at, ?),
            finished_at = ?,
            updated_at = ?
        WHERE id = ? AND user_id = ?
          AND status = 'queued'
      `,
      [appendLog(queuedLogs, "job cancelled by user"), cancelledAt, cancelledAt, cancelledAt, jobId, userId]
    );
    cancellationChanges = queuedCancellation.changes;
  }

  if (cancellationChanges === 0) {
    const runningCurrent = await refreshJob(jobId);
    const runningLogs = runningCurrent ? runningCurrent.logs : row.logs;
    const runningCancellation = await run(
      `
        UPDATE training_jobs
        SET cancel_requested = 1,
            cancel_requested_at = COALESCE(cancel_requested_at, ?),
            logs = ?,
            updated_at = ?
        WHERE id = ? AND user_id = ?
          AND status = 'running'
      `,
      [cancelledAt, appendLog(runningLogs, "cancellation requested by user"), cancelledAt, jobId, userId]
    );
    cancellationChanges = runningCancellation.changes;
  }

  if (cancellationChanges > 0) {
    await mirrorTrainingJobById(jobId);
  }

  abortActiveJob(jobId);
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
    let updated = false;
    if (isCancellationRequested(row)) {
      const now = new Date().toISOString();
      const cleared = await run(
        `
          UPDATE training_jobs
          SET logs = ?,
              error_message = NULL,
              cancel_requested = 0,
              cancel_requested_at = NULL,
              updated_at = ?
          WHERE id = ?
            AND status = 'queued'
        `,
        [appendLog(row.logs, reason), now, jobId]
      );

      if (cleared.changes > 0) {
        updated = true;
        await mirrorTrainingJobById(jobId);
      }
    }

    enqueueTrainingJobForRunner(jobId);
    return {
      jobId,
      statusBefore: row.status,
      statusAfter: row.status,
      updated
    };
  }

  const now = new Date().toISOString();
  const update = await run(
    `
      UPDATE training_jobs
      SET status = 'queued',
          logs = ?,
          error_message = NULL,
          cancel_requested = 0,
          cancel_requested_at = NULL,
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
    cancelRequested: isCancellationRequested(row),
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    note: "MVP simulated pipeline with queue/retries. Supports inline or external worker modes."
  };
}
