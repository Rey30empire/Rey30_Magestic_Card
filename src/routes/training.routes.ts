import { Router } from "express";
import { auditLog, get } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { requirePermission } from "../middleware/authorization";
import { createTrainingJobSchema } from "../schemas/acs.schemas";
import { cancelTrainingJob, createTrainingJob, listTrainingJobs, mapTrainingJob } from "../services/training-jobs";
import { env } from "../config/env";
import { dispatchTrainingJobToQueue, removeTrainingJobFromQueue } from "../services/training-queue";
import { sensitiveRateLimit } from "../middleware/rate-limit";

export const trainingRouter = Router();
const desktopOnlyModes = new Set(["fine-tuning", "lora", "adapter"]);
const sensitiveTrainingLimiter = sensitiveRateLimit({
  windowMs: env.SENSITIVE_RATE_LIMIT_WINDOW_MS,
  maxPerUser: env.SENSITIVE_RATE_LIMIT_MAX_PER_USER,
  maxPerToken: env.SENSITIVE_RATE_LIMIT_MAX_PER_TOKEN,
  maxBuckets: env.SENSITIVE_RATE_LIMIT_MAX_BUCKETS
});

type CountRow = {
  count: number;
};

trainingRouter.use(authRequired);

trainingRouter.post("/jobs", sensitiveTrainingLimiter, requirePermission("training.create"), async (req, res) => {
  const parsed = createTrainingJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const currentPlatform = req.clientPlatform ?? "web";
  if (desktopOnlyModes.has(parsed.data.mode) && currentPlatform !== "desktop") {
    res.status(403).json({
      error: "This training mode requires desktop platform",
      mode: parsed.data.mode,
      currentPlatform,
      requiredPlatform: "desktop"
    });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");

  if (parsed.data.agentId) {
    const agent = isAdmin
      ? await get<{ id: string }>("SELECT id FROM agents WHERE id = ?", [parsed.data.agentId])
      : await get<{ id: string }>("SELECT id FROM agents WHERE id = ? AND owner_user_id = ?", [parsed.data.agentId, req.user!.id]);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
  }

  if (parsed.data.projectId) {
    const project = isAdmin
      ? await get<{ id: string }>("SELECT id FROM projects WHERE id = ?", [parsed.data.projectId])
      : await get<{ id: string }>("SELECT id FROM projects WHERE id = ? AND owner_user_id = ?", [parsed.data.projectId, req.user!.id]);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
  }

  if (env.TRAINING_MAX_ACTIVE_PER_USER > 0) {
    const perUserActive = await get<CountRow>(
      `
        SELECT COUNT(*) as count
        FROM training_jobs
        WHERE user_id = ?
          AND status IN ('queued', 'running')
      `,
      [req.user!.id]
    );

    const current = perUserActive?.count ?? 0;
    if (current >= env.TRAINING_MAX_ACTIVE_PER_USER) {
      await auditLog(req.user!.id, "training.jobs.create.rejected.per-user-limit", {
        currentActive: current,
        maxActivePerUser: env.TRAINING_MAX_ACTIVE_PER_USER
      });

      res.status(429).json({
        error: "Training active jobs per-user limit reached",
        limitScope: "per-user",
        currentActive: current,
        maxAllowed: env.TRAINING_MAX_ACTIVE_PER_USER
      });
      return;
    }
  }

  if (env.TRAINING_MAX_ACTIVE_GLOBAL > 0) {
    const globalActive = await get<CountRow>(
      `
        SELECT COUNT(*) as count
        FROM training_jobs
        WHERE status IN ('queued', 'running')
      `
    );

    const current = globalActive?.count ?? 0;
    if (current >= env.TRAINING_MAX_ACTIVE_GLOBAL) {
      await auditLog(req.user!.id, "training.jobs.create.rejected.global-limit", {
        currentActive: current,
        maxActiveGlobal: env.TRAINING_MAX_ACTIVE_GLOBAL
      });

      res.status(429).json({
        error: "Training active jobs global limit reached",
        limitScope: "global",
        currentActive: current,
        maxAllowed: env.TRAINING_MAX_ACTIVE_GLOBAL
      });
      return;
    }
  }

  const idempotencyHeader = req.header("x-idempotency-key");
  const idempotencyKey = typeof idempotencyHeader === "string" ? idempotencyHeader.trim() : "";
  if (idempotencyHeader !== undefined && (idempotencyKey.length < 8 || idempotencyKey.length > 120)) {
    res.status(400).json({
      error: "Invalid x-idempotency-key header",
      details: {
        minLength: 8,
        maxLength: 120
      }
    });
    return;
  }

  const created = await createTrainingJob({
    userId: req.user!.id,
    projectId: parsed.data.projectId,
    agentId: parsed.data.agentId,
    idempotencyKey: idempotencyKey || undefined,
    mode: parsed.data.mode,
    config: parsed.data.config,
    platform: currentPlatform
  });

  if (env.TRAINING_RUNNER_MODE === "external") {
    try {
      await dispatchTrainingJobToQueue(created.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to dispatch training job";
      res.status(503).json({
        error: message,
        jobId: created.id,
        note: "Training job was created but could not be queued for external processing."
      });
      return;
    }
  }

  const jobs = await listTrainingJobs(req.user!.id);
  const row = jobs.find((item) => item.id === created.id);

  await auditLog(req.user!.id, "training.jobs.create", {
    jobId: created.id,
    idempotencyKey: idempotencyKey || null,
    reused: created.reused,
    mode: parsed.data.mode,
    projectId: parsed.data.projectId ?? null,
    agentId: parsed.data.agentId ?? null,
    platform: currentPlatform
  });

  res.status(created.reused ? 200 : 201).json(
    row
      ? mapTrainingJob(row)
      : {
          id: created.id,
          status: "queued",
          note: "MVP simulated pipeline with queue/retries. Supports inline or external worker modes."
        }
  );
});

trainingRouter.get("/jobs", requirePermission("training.view"), async (req, res) => {
  const jobs = await listTrainingJobs(req.user!.id);
  res.json({
    items: jobs.map(mapTrainingJob)
  });
});

trainingRouter.post("/jobs/:id/cancel", sensitiveTrainingLimiter, requirePermission("training.cancel"), async (req, res) => {
  const jobId = String(req.params.id);
  const cancelled = await cancelTrainingJob(req.user!.id, jobId);

  if (!cancelled) {
    res.status(404).json({ error: "Training job not found" });
    return;
  }

  if (cancelled && env.TRAINING_RUNNER_MODE === "external" && env.TRAINING_QUEUE_BACKEND === "redis") {
    try {
      await removeTrainingJobFromQueue(jobId);
    } catch (error) {
      console.error("[training.cancel] failed to remove job from redis queue", { jobId, error });
    }
  }

  await auditLog(req.user!.id, "training.jobs.cancel", { jobId });

  const jobs = await listTrainingJobs(req.user!.id);
  const row = jobs.find((item) => item.id === jobId);

  res.json({
    ok: true,
    jobId,
    job: row ? mapTrainingJob(row) : null
  });
});
