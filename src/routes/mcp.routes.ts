import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { auditLog } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { requireRole } from "../middleware/authorization";
import { sensitiveRateLimit } from "../middleware/rate-limit";
import { reymeshyCleanupRequestSchema, reymeshyMeshSchema } from "../schemas/reymeshy.schemas";
import { publishHybridResultEvent, getHybridResultBusSnapshot } from "../services/hybrid-result-bus";
import {
  getInferenceProvidersConfig,
  getInferenceProvidersMeta,
  InferenceProvider,
  listInferenceProvidersByCategory
} from "../services/inference-providers";
import { applyHybridToggleRuntimeEffects } from "../services/hybrid-runtime-control";
import {
  canSpendHybridBudget,
  getHybridBudgetSnapshot,
  getHybridToggles,
  hybridTaskSchema,
  hybridToggleUpdateSchema,
  registerHybridSpend,
  resetHybridBudget,
  resolveHybridProvider,
  updateHybridToggles
} from "../services/mcp-hybrid-router";
import { createReyMeshyCleanupJob } from "../services/reymeshy-jobs";
import { runReyMeshyCleanup } from "../services/reymeshy-sidecar";
import { assertReyMeshyVramBudget, ensureVramSentinelSnapshotFresh } from "../services/vram-sentinel";

const mcpExecuteSchema = z.object({
  tool: z.enum(["reymeshy.cleanup", "instantmesh.generate", "ollama.generate", "hybrid.dispatch"]),
  input: z.record(z.string(), z.unknown()).optional().default({}),
  async: z.boolean().optional().default(true)
});

const reymeshyToolInputSchema = z.union([
  reymeshyCleanupRequestSchema,
  reymeshyMeshSchema.transform((mesh) => ({ mesh }))
]);

const ollamaToolInputSchema = z.object({
  model: z.string().trim().min(1).max(120).default("llama3.1:8b"),
  prompt: z.string().trim().min(1).max(12000),
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().default({})
});

const instantMeshToolInputSchema = z.object({
  prompt: z.string().trim().min(1).max(12000),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  quality: z.enum(["low", "medium", "high"]).optional().default("medium")
});

const hybridBudgetResetSchema = z.object({
  day: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().trim().min(2).max(240).optional()
});

type CommandRunOutput = {
  stdout: string;
  stderr: string;
  code: number;
};

type HybridDispatchExecutionOutput = {
  routeMode: "local" | "api";
  providerId: string;
  providerName: string;
  category: string;
  latencyMs: number;
  budget: Awaited<ReturnType<typeof getHybridBudgetSnapshot>>;
  bus: Awaited<ReturnType<typeof publishHybridResultEvent>>;
  result: unknown;
};

type HybridDispatchJobStatus = "queued" | "running" | "succeeded" | "failed";

type HybridDispatchJobRecord = {
  id: string;
  userId: string;
  requestId: string;
  task: z.infer<typeof hybridTaskSchema>;
  status: HybridDispatchJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  output: HybridDispatchExecutionOutput | null;
  error: {
    code: string;
    message: string;
  } | null;
};

type HybridDispatchJobView = {
  id: string;
  status: HybridDispatchJobStatus;
  requestId: string;
  task: {
    category: string;
    providerId: string | null;
    prompt: string | null;
  };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  output: HybridDispatchExecutionOutput | null;
  error: {
    code: string;
    message: string;
  } | null;
};

const HYBRID_DISPATCH_JOB_MAX_STORED = 500;
const hybridDispatchJobs = new Map<string, HybridDispatchJobRecord>();
const hybridDispatchQueue: string[] = [];
let hybridDispatchWorkerRunning = false;

function mapMcpToolDisabledMessage(tool: string): string {
  if (tool === "reymeshy.cleanup") {
    return "MCP tool disabled: reymeshy.cleanup";
  }
  if (tool === "ollama.generate") {
    return "MCP tool disabled: ollama.generate";
  }
  if (tool === "instantmesh.generate") {
    return "MCP tool disabled: instantmesh.generate";
  }
  return "MCP tool disabled: hybrid.dispatch";
}

function ensureToolEnabled(tool: z.infer<typeof mcpExecuteSchema>["tool"]): true | string {
  if (tool === "reymeshy.cleanup" && !env.MCP_TOOL_REYMESHY_ENABLED) {
    return mapMcpToolDisabledMessage(tool);
  }
  if (tool === "ollama.generate" && !env.MCP_TOOL_OLLAMA_ENABLED) {
    return mapMcpToolDisabledMessage(tool);
  }
  if (tool === "instantmesh.generate" && !env.MCP_TOOL_INSTANTMESH_ENABLED) {
    return mapMcpToolDisabledMessage(tool);
  }
  return true;
}

function runCommandWithJsonInput(input: {
  command: string;
  args: string[];
  payload: unknown;
  timeoutMs: number;
}): Promise<CommandRunOutput> {
  return new Promise<CommandRunOutput>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finishError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishError(new Error(`InstantMesh worker timeout after ${input.timeoutMs}ms`));
    }, Math.max(100, input.timeoutMs));

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
      finishError(new Error(`Failed to start InstantMesh worker: ${error.message}`));
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        stdout,
        stderr,
        code: typeof code === "number" ? code : -1
      });
    });

    child.stdin.write(JSON.stringify(input.payload));
    child.stdin.end();
  });
}

async function callOllamaGenerate(input: z.infer<typeof ollamaToolInputSchema>): Promise<{
  model: string;
  output: string;
  raw: Record<string, unknown>;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, Math.max(500, env.MCP_OLLAMA_TIMEOUT_MS));

  try {
    const base = env.MCP_OLLAMA_API_BASE_URL.replace(/\/+$/g, "");
    const response = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        stream: false,
        options: input.options
      }),
      signal: controller.signal
    });

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : `Ollama request failed with HTTP ${response.status}`;
      throw new Error(message);
    }

    return {
      model: typeof payload?.model === "string" ? payload.model : input.model,
      output: typeof payload?.response === "string" ? payload.response : "",
      raw: payload ?? {}
    };
  } finally {
    clearTimeout(timeout);
  }
}

function lowestFreeVramMbFromSnapshot(snapshot: Awaited<ReturnType<typeof ensureVramSentinelSnapshotFresh>>): number | null {
  if (!snapshot.enabled || !snapshot.healthy) {
    return null;
  }
  if (!Number.isFinite(snapshot.summary.lowestFreeMb)) {
    return null;
  }
  return snapshot.summary.lowestFreeMb;
}

function readProviderSecret(envKey: string | undefined): string {
  if (!envKey || envKey.trim().length === 0) {
    return "";
  }

  const key = envKey.trim();
  const value = process.env[key];
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function readProviderEndpoint(provider: InferenceProvider): string {
  const overrideKey = provider.endpointEnvKey?.trim();
  if (overrideKey) {
    const override = process.env[overrideKey];
    if (typeof override === "string" && override.trim().length > 0) {
      return override.trim();
    }
  }

  return provider.endpoint?.trim() ?? "";
}

type ExternalApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type ExternalApiCallOptions = {
  endpointOverride?: string;
  methodOverride?: ExternalApiMethod;
  timeoutMs?: number;
};

type MeshyDispatchControls = {
  waitForCompletion: boolean;
  pollIntervalMs: number;
  waitTimeoutMs: number;
  includeStatusPayload: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildExternalPayload(task: z.infer<typeof hybridTaskSchema>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...task.payload
  };

  if (typeof task.prompt === "string" && task.prompt.trim().length > 0 && typeof payload.prompt !== "string") {
    payload.prompt = task.prompt.trim();
  }

  return payload;
}

function prepareMeshyDispatchPayload(payload: Record<string, unknown>): {
  providerPayload: Record<string, unknown>;
  controls: MeshyDispatchControls;
} {
  const out = {
    ...payload
  };

  const waitForCompletionRaw = parseBooleanLike(out.waitForCompletion);
  const waitForCompletion = waitForCompletionRaw ?? env.MCP_MESHY_WAIT_FOR_COMPLETION;

  const pollIntervalRaw = parseNumberLike(out.pollIntervalMs);
  const pollIntervalMs = clamp(
    Math.round(pollIntervalRaw ?? env.MCP_MESHY_POLL_INTERVAL_MS),
    1000,
    15_000
  );

  const waitTimeoutRaw = parseNumberLike(out.waitTimeoutMs);
  const waitTimeoutMs = clamp(
    Math.round(waitTimeoutRaw ?? env.MCP_MESHY_POLL_TIMEOUT_MS),
    pollIntervalMs,
    600_000
  );

  const includeStatusPayloadRaw = parseBooleanLike(out.includeStatusPayload);
  const includeStatusPayload = includeStatusPayloadRaw ?? false;

  delete out.waitForCompletion;
  delete out.pollIntervalMs;
  delete out.waitTimeoutMs;
  delete out.includeStatusPayload;

  return {
    providerPayload: out,
    controls: {
      waitForCompletion,
      pollIntervalMs,
      waitTimeoutMs,
      includeStatusPayload
    }
  };
}

function normalizeMeshyStatus(value: unknown): string {
  if (typeof value !== "string") {
    return "UNKNOWN";
  }
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : "UNKNOWN";
}

function isMeshySuccessfulStatus(status: string): boolean {
  return status === "SUCCEEDED";
}

function isMeshyTerminalStatus(status: string): boolean {
  return ["SUCCEEDED", "FAILED", "CANCELED", "CANCELLED", "EXPIRED", "REJECTED"].includes(status);
}

function readMeshyTaskIdFromCreateBody(body: unknown): string | null {
  if (!isObjectRecord(body)) {
    return null;
  }

  const result = body.result;
  if (typeof result === "string" && result.trim().length > 0) {
    return result.trim();
  }

  const id = body.id;
  if (typeof id === "string" && id.trim().length > 0) {
    return id.trim();
  }

  return null;
}

function readMeshyTaskError(body: unknown): string | null {
  if (!isObjectRecord(body)) {
    return null;
  }

  const taskError = body.task_error;
  if (typeof taskError === "string" && taskError.trim().length > 0) {
    return taskError.trim();
  }

  if (isObjectRecord(taskError)) {
    const message = taskError.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
    const detail = taskError.detail;
    if (typeof detail === "string" && detail.trim().length > 0) {
      return detail.trim();
    }
  }

  const message = body.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message.trim();
  }

  const error = body.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }

  return null;
}

function readMeshyArtifacts(body: unknown): {
  modelUrls: Record<string, string>;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  textureUrls: string[];
} | null {
  if (!isObjectRecord(body)) {
    return null;
  }

  const modelUrlsRaw = body.model_urls;
  const modelUrls: Record<string, string> = {};
  if (isObjectRecord(modelUrlsRaw)) {
    for (const [format, value] of Object.entries(modelUrlsRaw)) {
      if (typeof value === "string" && value.trim().length > 0) {
        modelUrls[format] = value.trim();
      }
    }
  }

  const thumbnailUrl = typeof body.thumbnail_url === "string" && body.thumbnail_url.trim().length > 0 ? body.thumbnail_url.trim() : null;
  const videoUrl = typeof body.video_url === "string" && body.video_url.trim().length > 0 ? body.video_url.trim() : null;
  const textureUrls = Array.isArray(body.texture_urls)
    ? body.texture_urls
        .filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
        .map((url) => url.trim())
    : [];

  if (Object.keys(modelUrls).length === 0 && !thumbnailUrl && !videoUrl && textureUrls.length === 0) {
    return null;
  }

  return {
    modelUrls,
    thumbnailUrl,
    videoUrl,
    textureUrls
  };
}

function buildMeshyStatusEndpoint(createEndpoint: string, taskId: string): string {
  const normalizedEndpoint = createEndpoint.replace(/\/+$/g, "");
  return `${normalizedEndpoint}/${encodeURIComponent(taskId)}`;
}

async function callExternalInferenceApi(
  provider: InferenceProvider,
  payload: Record<string, unknown>,
  options: ExternalApiCallOptions = {}
): Promise<{
  providerId: string;
  status: number;
  body: unknown;
}> {
  const endpoint = options.endpointOverride?.trim().length ? options.endpointOverride.trim() : readProviderEndpoint(provider);
  if (!endpoint) {
    throw new Error(`Provider ${provider.id} has no endpoint configured`);
  }
  try {
    // Validate URL early to fail fast on malformed env overrides.
    new URL(endpoint);
  } catch {
    throw new Error(`Provider ${provider.id} has invalid endpoint URL`);
  }

  const authKey = readProviderSecret(provider.authEnvKey);
  if (!authKey) {
    throw new Error(`Provider ${provider.id} is missing env secret ${provider.authEnvKey ?? "N/A"}`);
  }

  const method = ((options.methodOverride ?? provider.method ?? "POST").toUpperCase() as ExternalApiMethod);
  const authScheme = provider.authScheme ?? "bearer";
  if (authScheme === "body" && method === "GET") {
    throw new Error(`Provider ${provider.id} cannot use authScheme=body with GET`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  const requestPayload: Record<string, unknown> = { ...payload };
  if (authScheme === "body") {
    const bodyField = provider.authBodyField?.trim().length ? provider.authBodyField.trim() : "key";
    requestPayload[bodyField] = authKey;
  } else {
    const authHeaderName = provider.authHeader?.trim().length ? provider.authHeader.trim() : "Authorization";
    if (authScheme === "bearer") {
      headers[authHeaderName] = `Bearer ${authKey}`;
    } else {
      headers[authHeaderName] = authKey;
    }
  }

  const timeoutMs = Math.max(500, Math.round(options.timeoutMs ?? env.LLM_REQUEST_TIMEOUT_MS));
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(requestPayload),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Provider ${provider.id} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let parsedBody: unknown = text;
  if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }

  if (!response.ok) {
    const details = typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody).slice(0, 700);
    throw new Error(`Provider ${provider.id} failed with HTTP ${response.status}: ${details}`);
  }

  return {
    providerId: provider.id,
    status: response.status,
    body: parsedBody
  };
}

async function resolveMeshyFullFlow(input: {
  provider: InferenceProvider;
  createResponse: Awaited<ReturnType<typeof callExternalInferenceApi>>;
  controls: MeshyDispatchControls;
}): Promise<unknown> {
  const taskId = readMeshyTaskIdFromCreateBody(input.createResponse.body);
  if (!taskId) {
    return input.createResponse;
  }

  const createEndpoint = readProviderEndpoint(input.provider);
  const statusEndpoint = buildMeshyStatusEndpoint(createEndpoint, taskId);

  if (!input.controls.waitForCompletion) {
    return {
      ...input.createResponse,
      meshy: {
        taskId,
        statusEndpoint,
        polled: false,
        completed: false,
        succeeded: false,
        timedOut: false,
        status: "QUEUED",
        attempts: 0,
        durationMs: 0,
        error: null,
        artifacts: null,
        statusPayload: null
      }
    };
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + input.controls.waitTimeoutMs;
  let attempts = 0;
  let latestStatus = "QUEUED";
  let latestBody: unknown = null;

  while (Date.now() <= deadlineAt) {
    attempts += 1;
    const poll = await callExternalInferenceApi(
      input.provider,
      {},
      {
        endpointOverride: statusEndpoint,
        methodOverride: "GET"
      }
    );
    latestBody = poll.body;
    latestStatus = normalizeMeshyStatus(isObjectRecord(poll.body) ? poll.body.status : null);

    if (isMeshySuccessfulStatus(latestStatus)) {
      return {
        ...input.createResponse,
        meshy: {
          taskId,
          statusEndpoint,
          polled: true,
          completed: true,
          succeeded: true,
          timedOut: false,
          status: latestStatus,
          attempts,
          durationMs: Date.now() - startedAt,
          error: null,
          artifacts: readMeshyArtifacts(latestBody),
          statusPayload: input.controls.includeStatusPayload ? latestBody : null
        }
      };
    }

    if (isMeshyTerminalStatus(latestStatus)) {
      const taskError = readMeshyTaskError(latestBody);
      throw new Error(
        taskError
          ? `Meshy task ${taskId} ended with ${latestStatus}: ${taskError}`
          : `Meshy task ${taskId} ended with ${latestStatus}`
      );
    }

    await sleep(input.controls.pollIntervalMs);
  }

  return {
    ...input.createResponse,
    meshy: {
      taskId,
      statusEndpoint,
      polled: true,
      completed: false,
      succeeded: false,
      timedOut: true,
      status: latestStatus,
      attempts,
      durationMs: Date.now() - startedAt,
      error: `Meshy polling timeout after ${input.controls.waitTimeoutMs}ms`,
      artifacts: readMeshyArtifacts(latestBody),
      statusPayload: input.controls.includeStatusPayload ? latestBody : null
    }
  };
}

function compactPrompt(prompt: string | undefined): string | null {
  if (typeof prompt !== "string") {
    return null;
  }
  const normalized = prompt.trim();
  if (!normalized) {
    return null;
  }
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217)}...`;
}

function toHybridDispatchJobView(job: HybridDispatchJobRecord, includeResult: boolean): HybridDispatchJobView {
  return {
    id: job.id,
    status: job.status,
    requestId: job.requestId,
    task: {
      category: job.task.category,
      providerId: typeof job.task.providerId === "string" && job.task.providerId.trim().length > 0 ? job.task.providerId : null,
      prompt: compactPrompt(job.task.prompt)
    },
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt,
    output: includeResult ? job.output : null,
    error: job.error
  };
}

function pruneHybridDispatchJobs(): void {
  if (hybridDispatchJobs.size <= HYBRID_DISPATCH_JOB_MAX_STORED) {
    return;
  }

  const removable = [...hybridDispatchJobs.values()]
    .filter((job) => job.status === "succeeded" || job.status === "failed")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  while (hybridDispatchJobs.size > HYBRID_DISPATCH_JOB_MAX_STORED && removable.length > 0) {
    const target = removable.shift();
    if (!target) {
      break;
    }
    hybridDispatchJobs.delete(target.id);
  }
}

function createHybridDispatchJob(input: {
  userId: string;
  requestId: string;
  task: z.infer<typeof hybridTaskSchema>;
}): HybridDispatchJobView {
  const nowIso = new Date().toISOString();
  const job: HybridDispatchJobRecord = {
    id: randomUUID(),
    userId: input.userId,
    requestId: input.requestId,
    task: {
      category: input.task.category,
      providerId: input.task.providerId,
      prompt: input.task.prompt,
      payload: { ...input.task.payload }
    },
    status: "queued",
    createdAt: nowIso,
    startedAt: null,
    finishedAt: null,
    updatedAt: nowIso,
    output: null,
    error: null
  };

  hybridDispatchJobs.set(job.id, job);
  hybridDispatchQueue.push(job.id);
  pruneHybridDispatchJobs();
  void pumpHybridDispatchJobs();

  return toHybridDispatchJobView(job, false);
}

function getHybridDispatchJobForUser(input: {
  userId: string;
  jobId: string;
  includeResult: boolean;
}): HybridDispatchJobView | null {
  const normalizedJobId = input.jobId.trim();
  if (!normalizedJobId) {
    return null;
  }

  const job = hybridDispatchJobs.get(normalizedJobId);
  if (!job || job.userId !== input.userId) {
    return null;
  }

  return toHybridDispatchJobView(job, input.includeResult);
}

async function pumpHybridDispatchJobs(): Promise<void> {
  if (hybridDispatchWorkerRunning) {
    return;
  }
  hybridDispatchWorkerRunning = true;

  while (hybridDispatchQueue.length > 0) {
    const nextJobId = hybridDispatchQueue.shift();
    if (!nextJobId) {
      continue;
    }

    const job = hybridDispatchJobs.get(nextJobId);
    if (!job) {
      continue;
    }

    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    job.error = null;

    try {
      const output = await executeHybridDispatch({
        userId: job.userId,
        task: job.task,
        requestId: job.requestId
      });
      job.output = output;
      job.status = "succeeded";
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;

      await auditLog(job.userId, "mcp.hybrid.dispatch.job.succeeded", {
        jobId: job.id,
        requestId: job.requestId,
        category: output.category,
        routeMode: output.routeMode,
        providerId: output.providerId,
        latencyMs: output.latencyMs
      }).catch(() => {
        // Non-blocking audit failure.
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.output = null;
      job.status = "failed";
      job.error = {
        code: "dispatch_failed",
        message
      };
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;

      await auditLog(job.userId, "mcp.hybrid.dispatch.job.failed", {
        jobId: job.id,
        requestId: job.requestId,
        category: job.task.category,
        error: message
      }).catch(() => {
        // Non-blocking audit failure.
      });
    } finally {
      pruneHybridDispatchJobs();
    }
  }

  hybridDispatchWorkerRunning = false;
}

async function executeHybridDispatch(input: {
  userId: string;
  task: z.infer<typeof hybridTaskSchema>;
  requestId: string;
}): Promise<HybridDispatchExecutionOutput> {
  const startedAt = Date.now();
  const vramSnapshot = await ensureVramSentinelSnapshotFresh();
  const lowestFreeVramMb = lowestFreeVramMbFromSnapshot(vramSnapshot);

  const toggles = await getHybridToggles(input.userId);
  const resolved = resolveHybridProvider({
    category: input.task.category,
    requestedProviderId: input.task.providerId,
    toggles,
    lowestFreeVramMb
  });
  if (!resolved.provider) {
    throw new Error(`Hybrid router could not resolve provider (${resolved.reason ?? "unknown"})`);
  }

  let provider = resolved.provider;
  let result: unknown;
  let routeMode: "local" | "api" = provider.mode;
  let budgetSnapshot = await getHybridBudgetSnapshot();

  if (provider.mode === "local") {
    if (provider.id === "local.instantmesh") {
      if (!env.MCP_INSTANTMESH_COMMAND) {
        throw new Error("InstantMesh local worker is not configured. Set MCP_INSTANTMESH_COMMAND.");
      }
      const worker = await runCommandWithJsonInput({
        command: env.MCP_INSTANTMESH_COMMAND,
        args: env.MCP_INSTANTMESH_ARGS,
        payload: input.task.payload,
        timeoutMs: env.MCP_INSTANTMESH_TIMEOUT_MS
      });
      if (worker.code !== 0) {
        throw new Error(`InstantMesh local worker failed: ${worker.stderr.trim() || `exit code ${worker.code}`}`);
      }

      try {
        result = JSON.parse(worker.stdout.trim());
      } catch {
        result = worker.stdout.trim();
      }
    } else if (provider.id === "local.ollama") {
      const modelRaw = input.task.payload.model;
      const promptRaw = input.task.payload.prompt ?? input.task.prompt;
      const model = typeof modelRaw === "string" && modelRaw.trim().length > 0 ? modelRaw : "llama3.1:8b";
      const prompt = typeof promptRaw === "string" ? promptRaw.trim() : "";
      if (!prompt) {
        throw new Error("Hybrid LOGIC_GEN local route requires prompt");
      }
      result = await callOllamaGenerate({
        model,
        prompt,
        options: {}
      });
    } else {
      throw new Error(`Unsupported local provider route: ${provider.id}`);
    }
  } else {
    const costEstimate = Number.isFinite(provider.estimatedCostUsd) ? Number(provider.estimatedCostUsd) : 0;
    const budgetCheck = await canSpendHybridBudget(costEstimate);
    if (!budgetCheck.allowed) {
      const localFallback = resolveHybridProvider({
        category: input.task.category,
        toggles: {
          ...toggles,
          apiEngineEnabled: false
        },
        lowestFreeVramMb
      });
      if (localFallback.provider?.mode === "local") {
        if (localFallback.provider.id === "local.ollama") {
          const promptRaw = input.task.payload.prompt ?? input.task.prompt;
          const prompt = typeof promptRaw === "string" ? promptRaw.trim() : "";
          if (!prompt) {
            throw new Error("Hybrid fallback local route requires prompt");
          }
          result = await callOllamaGenerate({
            model: typeof input.task.payload.model === "string" ? input.task.payload.model : "llama3.1:8b",
            prompt,
            options: {}
          });
          routeMode = "local";
          budgetSnapshot = await getHybridBudgetSnapshot();
        } else if (localFallback.provider.id === "local.instantmesh") {
          if (!env.MCP_INSTANTMESH_COMMAND) {
            throw new Error("Hybrid budget fallback needs local InstantMesh runtime configured");
          }
          const worker = await runCommandWithJsonInput({
            command: env.MCP_INSTANTMESH_COMMAND,
            args: env.MCP_INSTANTMESH_ARGS,
            payload: input.task.payload,
            timeoutMs: env.MCP_INSTANTMESH_TIMEOUT_MS
          });
          if (worker.code !== 0) {
            throw new Error(`InstantMesh local worker failed: ${worker.stderr.trim() || `exit code ${worker.code}`}`);
          }
          try {
            result = JSON.parse(worker.stdout.trim());
          } catch {
            result = worker.stdout.trim();
          }
          routeMode = "local";
          budgetSnapshot = await getHybridBudgetSnapshot();
        } else {
          throw new Error(`Hybrid budget fallback provider not supported: ${localFallback.provider.id}`);
        }
      } else {
        throw new Error(
          `Daily API budget exceeded (${budgetCheck.budget.spentUsd}/${budgetCheck.budget.dailyBudgetUsd} USD) and no local fallback available`
        );
      }
    } else {
      const externalPayload = buildExternalPayload(input.task);
      const executeApiProvider = async (candidate: InferenceProvider): Promise<unknown> => {
        if (candidate.id === "api.meshy" && input.task.category === "GEOMETRY_3D") {
          const prepared = prepareMeshyDispatchPayload(externalPayload);
          const createResponse = await callExternalInferenceApi(candidate, prepared.providerPayload);
          return resolveMeshyFullFlow({
            provider: candidate,
            createResponse,
            controls: prepared.controls
          });
        }

        return callExternalInferenceApi(candidate, externalPayload);
      };

      try {
        result = await executeApiProvider(provider);
        budgetSnapshot = await registerHybridSpend(costEstimate);
        routeMode = "api";
      } catch (primaryError) {
        const fallbackCandidates = listInferenceProvidersByCategory(input.task.category).filter(
          (candidate) =>
            candidate.mode === "api" &&
            candidate.id !== provider.id &&
            toggles.providers[candidate.id] !== false &&
            toggles.apiEngineEnabled
        );

        let recovered = false;
        for (const candidate of fallbackCandidates) {
          const candidateCost = Number.isFinite(candidate.estimatedCostUsd) ? Number(candidate.estimatedCostUsd) : 0;
          const candidateBudget = await canSpendHybridBudget(candidateCost);
          if (!candidateBudget.allowed) {
            continue;
          }

          try {
            result = await executeApiProvider(candidate);
            budgetSnapshot = await registerHybridSpend(candidateCost);
            provider = candidate;
            routeMode = "api";
            recovered = true;
            break;
          } catch {
            // continue fallback chain
          }
        }

        if (!recovered) {
          throw primaryError;
        }
      }
    }
  }

  const latencyMs = Date.now() - startedAt;
  const bus = await publishHybridResultEvent({
    userId: input.userId,
    requestId: input.requestId,
    tool: "hybrid.dispatch",
    category: input.task.category,
    routeMode,
    providerId: provider.id,
    estimatedCostUsd: routeMode === "api" ? Number(provider.estimatedCostUsd ?? 0) : 0,
    latencyMs,
    createdAt: new Date().toISOString(),
    payload: result
  });

  return {
    routeMode,
    providerId: provider.id,
    providerName: provider.name,
    category: input.task.category,
    latencyMs,
    budget: budgetSnapshot,
    bus,
    result
  };
}

export const mcpRouter = Router();

const sensitiveMcpLimiter = sensitiveRateLimit({
  windowMs: env.SENSITIVE_RATE_LIMIT_WINDOW_MS,
  maxPerUser: env.SENSITIVE_RATE_LIMIT_MAX_PER_USER,
  maxPerToken: env.SENSITIVE_RATE_LIMIT_MAX_PER_TOKEN,
  maxBuckets: env.SENSITIVE_RATE_LIMIT_MAX_BUCKETS
});

mcpRouter.use(authRequired);

mcpRouter.get("/hybrid/status", async (req, res) => {
  const providersConfig = getInferenceProvidersConfig();
  const providersMeta = getInferenceProvidersMeta();
  const toggles = await getHybridToggles(req.user!.id);
  const vram = await ensureVramSentinelSnapshotFresh();
  const budget = await getHybridBudgetSnapshot();
  const resultBus = await getHybridResultBusSnapshot();

  res.json({
    enabledByServer: env.MCP_GATEWAY_ENABLED,
    hybrid: {
      localMllEnabledByEnv: env.LOCAL_MLL_ENABLED,
      localVramLimitMb: env.LOCAL_VRAM_LIMIT_MB,
      preferLocalOverApiByEnv: env.PREFER_LOCAL_OVER_API,
      processControl: {
        enabledByEnv: env.MCP_HYBRID_PROCESS_CONTROL_ENABLED,
        timeoutMs: env.MCP_HYBRID_PROCESS_CONTROL_TIMEOUT_MS,
        processNames: env.MCP_HYBRID_LOCAL_PROCESS_NAMES
      },
      toggles
    },
    budget,
    providersMeta,
    providers: providersConfig.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      category: provider.category,
      mode: provider.mode,
      endpoint: provider.endpoint ?? null,
      enabledByDefault: provider.enabledByDefault,
      activeByToggle: toggles.providers[provider.id] !== false,
      minFreeVramMb: provider.minFreeVramMb ?? null,
      estimatedCostUsd: provider.estimatedCostUsd
    })),
    vram,
    resultBus
  });
});

mcpRouter.put("/hybrid/toggles", async (req, res) => {
  const parsed = hybridToggleUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const current = await getHybridToggles(req.user!.id);
  const previous = {
    ...current,
    providers: { ...current.providers }
  };
  const next = await updateHybridToggles(req.user!.id, parsed.data);
  const runtimeControl = await applyHybridToggleRuntimeEffects({
    previous,
    next
  });
  await auditLog(req.user!.id, "mcp.hybrid.toggles.update", {
    toggles: next,
    runtimeControl: {
      enabled: runtimeControl.enabled,
      action: runtimeControl.action,
      reason: runtimeControl.reason,
      stoppedTargets: runtimeControl.stoppedTargets
    }
  }).catch(() => {
    // Non-blocking audit failure.
  });

  res.json({
    ok: true,
    toggles: next,
    runtimeControl
  });
});

mcpRouter.get("/status", async (_req, res) => {
  const vram = await ensureVramSentinelSnapshotFresh();
  const providersMeta = getInferenceProvidersMeta();
  const budget = await getHybridBudgetSnapshot();
  const resultBus = await getHybridResultBusSnapshot();
  res.json({
    enabledByServer: env.MCP_GATEWAY_ENABLED,
    tools: {
      reymeshyCleanup: env.MCP_TOOL_REYMESHY_ENABLED,
      ollamaGenerate: env.MCP_TOOL_OLLAMA_ENABLED,
      instantmeshGenerate: env.MCP_TOOL_INSTANTMESH_ENABLED,
      hybridDispatch: true
    },
    runtimes: {
      ollamaBaseUrl: env.MCP_OLLAMA_API_BASE_URL,
      instantmeshConfigured: env.MCP_INSTANTMESH_COMMAND.length > 0,
      localMllEnabled: env.LOCAL_MLL_ENABLED,
      localVramLimitMb: env.LOCAL_VRAM_LIMIT_MB
    },
    budget,
    providersMeta,
    resultBus,
    vram
  });
});

mcpRouter.get("/hybrid/jobs/:id", async (req, res) => {
  const includeResult = parseBooleanLike(req.query.includeResult) === true;
  const job = getHybridDispatchJobForUser({
    userId: req.user!.id,
    jobId: String(req.params.id || ""),
    includeResult
  });
  if (!job) {
    res.status(404).json({ error: "Hybrid dispatch job not found" });
    return;
  }

  res.json({
    ok: true,
    job
  });
});

mcpRouter.post("/hybrid/budget/reset", requireRole("admin"), async (req, res) => {
  const parsed = hybridBudgetResetSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const reset = await resetHybridBudget({
    day: parsed.data.day
  });

  await auditLog(req.user!.id, "mcp.hybrid.budget.reset", {
    day: reset.day,
    previousSpentUsd: reset.previousSpentUsd,
    reason: parsed.data.reason ?? null
  }).catch(() => {
    // Non-blocking audit failure.
  });

  res.json({
    ok: true,
    day: reset.day,
    previousSpentUsd: reset.previousSpentUsd,
    budget: reset.budget
  });
});

mcpRouter.post("/execute", sensitiveMcpLimiter, async (req, res) => {
  if (!env.MCP_GATEWAY_ENABLED) {
    res.status(503).json({
      error: "MCP Gateway disabled by server policy"
    });
    return;
  }

  const parsed = mcpExecuteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const toolEnabled = ensureToolEnabled(parsed.data.tool);
  if (toolEnabled !== true) {
    res.status(503).json({
      error: toolEnabled
    });
    return;
  }

  try {
    if (parsed.data.tool === "hybrid.dispatch") {
      const taskParsed = hybridTaskSchema.safeParse(parsed.data.input ?? {});
      if (!taskParsed.success) {
        res.status(400).json({ error: "Invalid hybrid.dispatch input", details: taskParsed.error.flatten() });
        return;
      }

      const requestId = typeof req.requestId === "string" && req.requestId.trim().length > 0 ? req.requestId : randomUUID();

      if (parsed.data.async) {
        const job = createHybridDispatchJob({
          userId: req.user!.id,
          requestId,
          task: taskParsed.data
        });

        await auditLog(req.user!.id, "mcp.execute", {
          tool: parsed.data.tool,
          mode: "async",
          category: taskParsed.data.category,
          providerId: taskParsed.data.providerId ?? null,
          jobId: job.id
        }).catch(() => {
          // Non-blocking audit failure.
        });

        res.status(202).json({
          ok: true,
          tool: parsed.data.tool,
          mode: "async",
          category: taskParsed.data.category,
          job: {
            id: job.id,
            status: job.status,
            createdAt: job.createdAt,
            statusEndpoint: `/api/mcp/hybrid/jobs/${job.id}`
          },
          poll: {
            intervalMs: 1500
          }
        });
        return;
      }

      const output = await executeHybridDispatch({
        userId: req.user!.id,
        task: taskParsed.data,
        requestId
      });

      await auditLog(req.user!.id, "mcp.execute", {
        tool: parsed.data.tool,
        mode: output.routeMode,
        category: output.category,
        providerId: output.providerId,
        latencyMs: output.latencyMs,
        budget: output.budget
      }).catch(() => {
        // Non-blocking audit failure.
      });

      res.json({
        ok: true,
        tool: parsed.data.tool,
        mode: output.routeMode,
        category: output.category,
        provider: {
          id: output.providerId,
          name: output.providerName
        },
        latencyMs: output.latencyMs,
        budget: output.budget,
        bus: output.bus,
        result: output.result
      });
      return;
    }

    const vram = await assertReyMeshyVramBudget();
    if (!vram.allowed) {
      res.status(503).json({
        error: "Feature disabled by VRAM constraints",
        details: `vram_constraint: ${vram.reason ?? "vram_constrained"}`,
        vram: vram.snapshot
      });
      return;
    }

    if (parsed.data.tool === "reymeshy.cleanup") {
      const toolInputParsed = reymeshyToolInputSchema.safeParse(parsed.data.input);
      if (!toolInputParsed.success) {
        res.status(400).json({ error: "Invalid reymeshy.cleanup input", details: toolInputParsed.error.flatten() });
        return;
      }

      if (parsed.data.async) {
        const job = createReyMeshyCleanupJob({
          userId: req.user!.id,
          mesh: toolInputParsed.data.mesh
        });

        await auditLog(req.user!.id, "mcp.execute", {
          tool: parsed.data.tool,
          mode: "async",
          jobId: job.id
        }).catch(() => {
          // Non-blocking audit failure.
        });

        res.status(202).json({
          ok: true,
          tool: parsed.data.tool,
          mode: "async",
          job: {
            id: job.id,
            statusEndpoint: `/api/reymeshy/jobs/${job.id}`
          }
        });
        return;
      }

      const result = await runReyMeshyCleanup(toolInputParsed.data.mesh);
      const summary = {
        inputVertices: toolInputParsed.data.mesh.vertices.length / 3,
        inputTriangles: toolInputParsed.data.mesh.indices.length / 3,
        remeshedTriangles: result.remeshed.indices.length / 3,
        outputTriangles: result.lod_optimized.indices.length / 3
      };

      await auditLog(req.user!.id, "mcp.execute", {
        tool: parsed.data.tool,
        mode: "sync",
        summary
      }).catch(() => {
        // Non-blocking audit failure.
      });

      res.json({
        ok: true,
        tool: parsed.data.tool,
        mode: "sync",
        summary,
        result
      });
      return;
    }

    if (parsed.data.tool === "ollama.generate") {
      const toolInputParsed = ollamaToolInputSchema.safeParse(parsed.data.input);
      if (!toolInputParsed.success) {
        res.status(400).json({ error: "Invalid ollama.generate input", details: toolInputParsed.error.flatten() });
        return;
      }

      const startedAtMs = Date.now();
      const output = await callOllamaGenerate(toolInputParsed.data);
      const latencyMs = Date.now() - startedAtMs;

      await auditLog(req.user!.id, "mcp.execute", {
        tool: parsed.data.tool,
        mode: "sync",
        latencyMs,
        model: output.model
      }).catch(() => {
        // Non-blocking audit failure.
      });

      res.json({
        ok: true,
        tool: parsed.data.tool,
        mode: "sync",
        latencyMs,
        result: output
      });
      return;
    }

    const toolInputParsed = instantMeshToolInputSchema.safeParse(parsed.data.input);
    if (!toolInputParsed.success) {
      res.status(400).json({ error: "Invalid instantmesh.generate input", details: toolInputParsed.error.flatten() });
      return;
    }

    if (!env.MCP_INSTANTMESH_COMMAND) {
      res.status(503).json({
        error: "InstantMesh runtime not configured. Set MCP_INSTANTMESH_COMMAND."
      });
      return;
    }

    const startedAtMs = Date.now();
    const worker = await runCommandWithJsonInput({
      command: env.MCP_INSTANTMESH_COMMAND,
      args: env.MCP_INSTANTMESH_ARGS,
      payload: toolInputParsed.data,
      timeoutMs: env.MCP_INSTANTMESH_TIMEOUT_MS
    });

    if (worker.code !== 0) {
      res.status(502).json({
        error: "InstantMesh worker failed",
        details: worker.stderr.trim() || `exit code ${worker.code}`
      });
      return;
    }

    let parsedStdout: unknown = worker.stdout.trim();
    try {
      parsedStdout = JSON.parse(worker.stdout.trim());
    } catch {
      // Keep plain stdout text when output is not JSON.
    }

    const latencyMs = Date.now() - startedAtMs;
    await auditLog(req.user!.id, "mcp.execute", {
      tool: parsed.data.tool,
      mode: "sync",
      latencyMs
    }).catch(() => {
      // Non-blocking audit failure.
    });

    res.json({
      ok: true,
      tool: parsed.data.tool,
      mode: "sync",
      latencyMs,
      result: parsedStdout
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({
      error: "MCP execution failed",
      details: message
    });
  }
});
