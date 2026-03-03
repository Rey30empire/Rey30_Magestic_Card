import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { auditLog } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { sensitiveRateLimit } from "../middleware/rate-limit";
import { reymeshyCleanupRequestSchema } from "../schemas/reymeshy.schemas";
import {
  createReyMeshyCleanupJob,
  getReyMeshyCleanupJobForUser,
  getReyMeshyCleanupQueueSnapshot
} from "../services/reymeshy-jobs";
import { getReyMeshyCleanupMetricsSnapshot, recordReyMeshyCleanupMetric } from "../services/reymeshy-metrics";
import { getReyMeshySidecarCommandPreview, runReyMeshyCleanup } from "../services/reymeshy-sidecar";
import { assertReyMeshyVramBudget, ensureVramSentinelSnapshotFresh } from "../services/vram-sentinel";

const statusQuerySchema = z.object({
  windowMinutes: z.coerce.number().int().min(1).max(180).optional().default(15)
});

const jobParamSchema = z.object({
  id: z.string().uuid()
});

const jobQuerySchema = z.object({
  includeResult: z.preprocess((value) => {
    if (value === undefined) {
      return false;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
      }
      if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
      }
    }
    return value;
  }, z.boolean().default(false))
});

export const reymeshyRouter = Router();

const sensitiveReyMeshyLimiter = sensitiveRateLimit({
  windowMs: env.SENSITIVE_RATE_LIMIT_WINDOW_MS,
  maxPerUser: env.SENSITIVE_RATE_LIMIT_MAX_PER_USER,
  maxPerToken: env.SENSITIVE_RATE_LIMIT_MAX_PER_TOKEN,
  maxBuckets: env.SENSITIVE_RATE_LIMIT_MAX_BUCKETS
});

reymeshyRouter.get("/status", authRequired, async (req, res) => {
  const parsed = statusQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const preview = getReyMeshySidecarCommandPreview();
  const vram = await ensureVramSentinelSnapshotFresh();
  res.json({
    enabledByServer: env.REYMESHY_SIDECAR_ENABLED,
    timeoutMs: env.REYMESHY_SIDECAR_TIMEOUT_MS,
    metrics: getReyMeshyCleanupMetricsSnapshot(parsed.data.windowMinutes),
    queue: getReyMeshyCleanupQueueSnapshot(),
    vram,
    sidecar: {
      executable: preview.executable,
      argsCount: preview.args.length,
      cwd: preview.cwd ?? null
    }
  });
});

reymeshyRouter.post("/jobs", authRequired, sensitiveReyMeshyLimiter, async (req, res) => {
  if (!env.REYMESHY_SIDECAR_ENABLED) {
    res.status(503).json({
      error: "ReyMeshy sidecar disabled by server policy"
    });
    return;
  }

  const parsed = reymeshyCleanupRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    recordReyMeshyCleanupMetric({
      outcome: "error",
      latencyMs: 0,
      inputBytes: Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8"),
      inputVertices: 0,
      inputTriangles: 0,
      outputTriangles: null,
      errorCode: "invalid_payload"
    });
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
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

  const job = createReyMeshyCleanupJob({
    userId: req.user!.id,
    mesh: parsed.data.mesh
  });

  await auditLog(req.user!.id, "reymeshy.job.create", {
    jobId: job.id,
    input: {
      vertices: job.input.vertices,
      triangles: job.input.triangles,
      bytes: job.input.bytes
    }
  }).catch(() => {
    // Non-blocking audit failure.
  });

  res.status(202).json({
    ok: true,
    job,
    poll: {
      statusEndpoint: `/api/reymeshy/jobs/${job.id}`
    }
  });
});

reymeshyRouter.get("/jobs/:id", authRequired, async (req, res) => {
  const parsedParams = jobParamSchema.safeParse(req.params ?? {});
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid job id", details: parsedParams.error.flatten() });
    return;
  }

  const parsedQuery = jobQuerySchema.safeParse(req.query ?? {});
  if (!parsedQuery.success) {
    res.status(400).json({ error: "Invalid query", details: parsedQuery.error.flatten() });
    return;
  }

  const job = getReyMeshyCleanupJobForUser({
    userId: req.user!.id,
    jobId: parsedParams.data.id,
    includeResult: parsedQuery.data.includeResult
  });

  if (!job) {
    res.status(404).json({ error: "ReyMeshy job not found" });
    return;
  }

  res.json({
    ok: true,
    job
  });
});

reymeshyRouter.post("/cleanup", authRequired, sensitiveReyMeshyLimiter, async (req, res) => {
  if (!env.REYMESHY_SIDECAR_ENABLED) {
    res.status(503).json({
      error: "ReyMeshy sidecar disabled by server policy"
    });
    return;
  }

  const parsed = reymeshyCleanupRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    recordReyMeshyCleanupMetric({
      outcome: "error",
      latencyMs: 0,
      inputBytes: Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8"),
      inputVertices: 0,
      inputTriangles: 0,
      outputTriangles: null,
      errorCode: "invalid_payload"
    });

    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
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

  const startedAt = Date.now();
  const inputVertices = parsed.data.mesh.vertices.length / 3;
  const inputTriangles = parsed.data.mesh.indices.length / 3;
  const inputBytes = Buffer.byteLength(JSON.stringify(parsed.data.mesh), "utf8");

  try {
    const result = await runReyMeshyCleanup(parsed.data.mesh);
    const outputTriangles = result.lod_optimized.indices.length / 3;
    const latencyMs = Date.now() - startedAt;

    recordReyMeshyCleanupMetric({
      outcome: "ok",
      latencyMs,
      inputBytes,
      inputVertices,
      inputTriangles,
      outputTriangles
    });

    await auditLog(req.user!.id, "reymeshy.cleanup", {
      input: {
        vertices: inputVertices,
        triangles: inputTriangles,
        bytes: inputBytes
      },
      output: {
        remeshedTriangles: result.remeshed.indices.length / 3,
        lodTriangles: result.lod_optimized.indices.length / 3
      },
      latencyMs
    });

    res.json({
      ok: true,
      summary: {
        inputVertices,
        inputTriangles,
        remeshedVertices: result.remeshed.vertices.length / 3,
        remeshedTriangles: result.remeshed.indices.length / 3,
        outputVertices: result.lod_optimized.vertices.length / 3,
        outputTriangles: result.lod_optimized.indices.length / 3
      },
      result
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    const latencyMs = Date.now() - startedAt;
    const normalizedErrorCode = details.toLowerCase().includes("timeout") ? "sidecar_timeout" : "sidecar_error";

    recordReyMeshyCleanupMetric({
      outcome: "error",
      latencyMs,
      inputBytes,
      inputVertices,
      inputTriangles,
      outputTriangles: null,
      errorCode: normalizedErrorCode
    });

    await auditLog(req.user!.id, "reymeshy.cleanup.failed", {
      input: {
        vertices: inputVertices,
        triangles: inputTriangles,
        bytes: inputBytes
      },
      error: details,
      latencyMs
    }).catch(() => {
      // Non-blocking audit failure.
    });

    res.status(502).json({
      error: "ReyMeshy sidecar failed",
      details
    });
  }
});
