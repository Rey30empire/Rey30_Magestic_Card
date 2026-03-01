import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { adminCreatorReviewSchema, adminCreatorSuspendSchema, adminInviteCreateSchema } from "../schemas/acs.schemas";
import { all, auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { requirePermission, requireRole } from "../middleware/authorization";
import {
  addUserPermissions,
  assignRoleToUser,
  getUserPermissions,
  getUserRoles,
  removeRoleFromUser,
  setUserPermissionOverrides
} from "../services/rbac";
import {
  getTrainingQueueMetrics,
  isRedisTrainingQueueEnabled,
  listTrainingDlqJobs,
  requeueTrainingDlqBatch,
  requeueTrainingDlqJob
} from "../services/training-queue";
import { getOpsMetricsSnapshot, listOpsMetricsHistory, persistOpsMetricsToStorage } from "../services/ops-metrics";
import { exportTraceSpans, listTraceSpans, TraceSpanKind } from "../services/ops-tracing";
import { parseJsonSafe } from "../utils/json";
import { env } from "../config/env";
import { getTrainingOpsSnapshot } from "../services/training-jobs";
import { getVaultSecurityStatus, rotateVaultSecrets } from "../services/vault";
import { getAbuseSecuritySummary, listAbuseIncidents, resolveAbuseIncident } from "../services/abuse-detection";

type CreatorApplicationRow = {
  id: string;
  user_id: string;
  status: "pending" | "approved" | "rejected" | "suspended";
  message: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
  username?: string;
};

type InviteCodeRow = {
  id: string;
  code: string;
  role_key: string;
  permission_grants: string;
  max_uses: number;
  used_count: number;
  status: string;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const permissionUpdateSchema = adminCreatorReviewSchema.pick({ permissionGrants: true });
const dlqQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).max(20_000).default(0)
});
const opsMetricsQuerySchema = z.object({
  windowMinutes: z.coerce.number().int().min(1).max(180).default(15)
});
const opsMetricsHistoryQuerySchema = z.object({
  minutes: z.coerce.number().int().min(1).max(360).default(60),
  limit: z.coerce.number().int().min(1).max(1000).default(120)
});
const opsTracesQuerySchema = z.object({
  minutes: z.coerce.number().int().min(1).max(360).default(60),
  limit: z.coerce.number().int().min(1).max(2000).default(300),
  traceId: z.string().min(8).max(120).optional(),
  kinds: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) {
        return undefined;
      }

      return value
        .split(",")
        .map((item) => item.trim())
        .filter((item): item is TraceSpanKind => ["request", "db", "queue", "service"].includes(item));
    })
});
const opsTracesExportQuerySchema = opsTracesQuerySchema.extend({
  format: z.enum(["json", "ndjson"]).default("ndjson")
});
const vaultSecurityStatusQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(20_000).default(5000)
});
const vaultRotateSchema = z.object({
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(10_000).default(1000)
});
const abuseIncidentsQuerySchema = z.object({
  status: z.enum(["open", "resolved", "all"]).default("open"),
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).max(200_000).default(0)
});
const abuseSummaryQuerySchema = z.object({
  windowMinutes: z.coerce.number().int().min(1).max(360).default(60)
});
const abuseResolveSchema = z.object({
  note: z.string().trim().min(2).max(400).optional(),
  unblockUser: z.boolean().default(true)
});
const auditExportQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10_000).default(1000),
  offset: z.coerce.number().int().min(0).max(200_000).default(0),
  format: z.enum(["json", "ndjson"]).default("ndjson")
});
const auditVerifyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10_000).default(2000),
  offset: z.coerce.number().int().min(0).max(200_000).default(0)
});
const dlqRequeueSchema = z.object({
  removeOriginal: z.boolean().default(true)
});
const dlqBatchRequeueSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).max(20_000).default(0),
  removeOriginal: z.boolean().default(true),
  states: z.array(z.enum(["waiting", "delayed", "failed", "active", "completed"])).max(5).default(["waiting", "delayed", "failed", "active"])
});

function generateInviteCode(): string {
  return `INV-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function scaleThreshold(baseThreshold: number, windowMinutes: number): number {
  const safeBase = Math.max(1, baseThreshold);
  return Math.max(1, Math.ceil((safeBase * windowMinutes) / 15));
}

export const adminRouter = Router();

adminRouter.get("/creators/applications", authRequired, requirePermission("admin.creators.review"), async (req, res) => {
  const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;

  const params: (string | number)[] = [];
  const where = statusFilter ? "WHERE c.status = ?" : "";
  if (statusFilter) {
    params.push(statusFilter);
  }

  const rows = await all<CreatorApplicationRow>(
    `
      SELECT
        c.id,
        c.user_id,
        c.status,
        c.message,
        c.reviewed_by,
        c.review_note,
        c.created_at,
        c.updated_at,
        u.username AS username
      FROM creator_applications c
      INNER JOIN users u ON u.id = c.user_id
      ${where}
      ORDER BY c.updated_at DESC
      LIMIT 400
    `,
    params
  );

  await auditLog(req.user!.id, "admin.creators.applications.list", { status: statusFilter ?? "all" });

  res.json({
    items: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      username: row.username,
      status: row.status,
      message: row.message,
      reviewedBy: row.reviewed_by,
      reviewNote: row.review_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  });
});

adminRouter.post("/creators/:applicationId/approve", authRequired, requirePermission("admin.creators.review"), async (req, res) => {
  const applicationId = String(req.params.applicationId);
  const parsed = adminCreatorReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const application = await get<CreatorApplicationRow>("SELECT * FROM creator_applications WHERE id = ?", [applicationId]);
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  const now = new Date().toISOString();
  await run(
    `
      UPDATE creator_applications
      SET status = 'approved', reviewed_by = ?, review_note = ?, updated_at = ?
      WHERE id = ?
    `,
    [req.user!.id, parsed.data.note ?? null, now, applicationId]
  );

  await assignRoleToUser(application.user_id, "creator", req.user!.id);
  await assignRoleToUser(application.user_id, "approvedCreator", req.user!.id);

  if (parsed.data.permissionGrants.length > 0) {
    await addUserPermissions(application.user_id, parsed.data.permissionGrants, req.user!.id);
  }

  await auditLog(req.user!.id, "admin.creators.approve", {
    applicationId,
    targetUserId: application.user_id,
    roleGrants: ["creator", "approvedCreator"],
    permissionGrants: parsed.data.permissionGrants
  });

  const roles = await getUserRoles(application.user_id, "user");
  const permissions = await getUserPermissions(application.user_id, "user");

  res.json({
    applicationId,
    status: "approved",
    roles,
    permissions
  });
});

adminRouter.post("/creators/:applicationId/reject", authRequired, requirePermission("admin.creators.review"), async (req, res) => {
  const applicationId = String(req.params.applicationId);
  const parsed = adminCreatorReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const application = await get<CreatorApplicationRow>("SELECT * FROM creator_applications WHERE id = ?", [applicationId]);
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  await run(
    `
      UPDATE creator_applications
      SET status = 'rejected', reviewed_by = ?, review_note = ?, updated_at = ?
      WHERE id = ?
    `,
    [req.user!.id, parsed.data.note ?? null, new Date().toISOString(), applicationId]
  );

  await removeRoleFromUser(application.user_id, "approvedCreator");

  await auditLog(req.user!.id, "admin.creators.reject", {
    applicationId,
    targetUserId: application.user_id,
    note: parsed.data.note ?? null
  });

  const roles = await getUserRoles(application.user_id, "user");
  res.json({
    applicationId,
    status: "rejected",
    roles
  });
});

adminRouter.post("/creators/:creatorId/suspend", authRequired, requirePermission("admin.creators.review"), async (req, res) => {
  const creatorId = String(req.params.creatorId);
  const parsed = adminCreatorSuspendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const now = new Date().toISOString();
  await run(
    `
      UPDATE creator_applications
      SET status = 'suspended', reviewed_by = ?, review_note = ?, updated_at = ?
      WHERE user_id = ?
    `,
    [req.user!.id, parsed.data.note ?? "Suspended by admin", now, creatorId]
  );

  await removeRoleFromUser(creatorId, "approvedCreator");

  await auditLog(req.user!.id, "admin.creators.suspend", {
    targetUserId: creatorId,
    note: parsed.data.note ?? null
  });

  const roles = await getUserRoles(creatorId, "user");
  res.json({
    userId: creatorId,
    status: "suspended",
    roles
  });
});

adminRouter.post("/creators/:creatorId/permissions", authRequired, requirePermission("permissions.assign"), async (req, res) => {
  const creatorId = String(req.params.creatorId);
  const parsed = permissionUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  await setUserPermissionOverrides(creatorId, parsed.data.permissionGrants, req.user!.id);

  await auditLog(req.user!.id, "admin.creators.permissions.set", {
    targetUserId: creatorId,
    permissionGrants: parsed.data.permissionGrants
  });

  const permissions = await getUserPermissions(creatorId, "user");
  res.json({ userId: creatorId, permissions });
});

adminRouter.post("/invites", authRequired, requirePermission("admin.invites.manage"), async (req, res) => {
  const parsed = adminInviteCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const id = randomUUID();
  const code = generateInviteCode();
  const now = new Date().toISOString();

  await run(
    `
      INSERT INTO invite_codes (
        id, code, role_key, permission_grants, max_uses, used_count, status, expires_at, created_by, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?)
    `,
    [
      id,
      code,
      parsed.data.role,
      JSON.stringify(parsed.data.permissionGrants),
      parsed.data.maxUses,
      parsed.data.expiresAt ?? null,
      req.user!.id,
      now,
      now
    ]
  );

  await auditLog(req.user!.id, "admin.invites.create", {
    inviteId: id,
    role: parsed.data.role,
    maxUses: parsed.data.maxUses,
    permissionGrants: parsed.data.permissionGrants
  });

  res.status(201).json({
    id,
    code,
    role: parsed.data.role,
    maxUses: parsed.data.maxUses,
    expiresAt: parsed.data.expiresAt ?? null
  });
});

adminRouter.get("/invites", authRequired, requirePermission("admin.invites.manage"), async (req, res) => {
  const rows = await all<InviteCodeRow>(
    `
      SELECT id, code, role_key, permission_grants, max_uses, used_count, status, expires_at, created_by, created_at, updated_at
      FROM invite_codes
      ORDER BY created_at DESC
      LIMIT 400
    `
  );

  res.json({
    items: rows.map((row) => ({
      id: row.id,
      code: row.code,
      role: row.role_key,
      permissionGrants: parseJsonSafe<string[]>(row.permission_grants, []),
      maxUses: row.max_uses,
      usedCount: row.used_count,
      status: row.status,
      expiresAt: row.expires_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  });
});

adminRouter.get("/audit-logs", authRequired, requirePermission("admin.audit.read"), async (req, res) => {
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 200;
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 200;

  const rows = await all<{
    id: number;
    user_id: string | null;
    action: string;
    payload: string;
    created_at: string;
    prev_hash: string | null;
    entry_hash: string | null;
  }>(
    `
      SELECT id, user_id, action, payload, created_at, prev_hash, entry_hash
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT ?
    `,
    [limit]
  );

  res.json({
    items: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      action: row.action,
      payload: parseJsonSafe<Record<string, unknown>>(row.payload, {}),
      createdAt: row.created_at,
      prevHash: row.prev_hash,
      entryHash: row.entry_hash
    }))
  });
});

adminRouter.get("/audit-logs/export", authRequired, requirePermission("admin.audit.read"), async (req, res) => {
  const parsed = auditExportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const rows = await all<{
    id: number;
    user_id: string | null;
    action: string;
    payload: string;
    created_at: string;
    prev_hash: string | null;
    entry_hash: string | null;
  }>(
    `
      SELECT id, user_id, action, payload, created_at, prev_hash, entry_hash
      FROM audit_logs
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `,
    [parsed.data.limit, parsed.data.offset]
  );

  await auditLog(req.user!.id, "admin.audit-logs.export", {
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    format: parsed.data.format,
    count: rows.length
  });

  if (parsed.data.format === "ndjson") {
    const ndjson = rows
      .map((row) =>
        JSON.stringify({
          id: row.id,
          userId: row.user_id,
          action: row.action,
          payloadRaw: row.payload,
          payload: parseJsonSafe<Record<string, unknown>>(row.payload, {}),
          createdAt: row.created_at,
          prevHash: row.prev_hash,
          entryHash: row.entry_hash
        })
      )
      .join("\n");

    res.type("application/x-ndjson").send(ndjson);
    return;
  }

  res.json({
    items: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      action: row.action,
      payloadRaw: row.payload,
      payload: parseJsonSafe<Record<string, unknown>>(row.payload, {}),
      createdAt: row.created_at,
      prevHash: row.prev_hash,
      entryHash: row.entry_hash
    })),
    pagination: {
      limit: parsed.data.limit,
      offset: parsed.data.offset
    }
  });
});

adminRouter.get("/audit-logs/verify", authRequired, requirePermission("admin.audit.read"), async (req, res) => {
  const parsed = auditVerifyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const rows = await all<{
    id: number;
    user_id: string | null;
    action: string;
    payload: string;
    created_at: string;
    prev_hash: string | null;
    entry_hash: string | null;
  }>(
    `
      SELECT id, user_id, action, payload, created_at, prev_hash, entry_hash
      FROM audit_logs
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `,
    [parsed.data.limit, parsed.data.offset]
  );

  let previousHash = "GENESIS";
  let mismatch: {
    id: number;
    reason: string;
    expectedPrevHash: string;
    foundPrevHash: string | null;
    expectedEntryHash: string;
    foundEntryHash: string | null;
  } | null = null;

  for (const row of rows) {
    const expectedEntryHash = createHash("sha256")
      .update(`${row.created_at}|${row.user_id ?? ""}|${row.action}|${row.payload}|${previousHash}`, "utf8")
      .digest("hex");

    const foundPrevHash = row.prev_hash;
    const foundEntryHash = row.entry_hash;
    const prevOk = foundPrevHash === previousHash;
    const entryOk = foundEntryHash === expectedEntryHash;

    if (!prevOk || !entryOk) {
      mismatch = {
        id: row.id,
        reason: !prevOk ? "prev_hash_mismatch" : "entry_hash_mismatch",
        expectedPrevHash: previousHash,
        foundPrevHash,
        expectedEntryHash,
        foundEntryHash
      };
      break;
    }

    previousHash = expectedEntryHash;
  }

  await auditLog(req.user!.id, "admin.audit-logs.verify", {
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    verifiedRows: rows.length,
    ok: mismatch === null
  });

  res.json({
    ok: mismatch === null,
    verifiedRows: rows.length,
    mismatch
  });
});

adminRouter.get("/security/vault/status", authRequired, requireRole("admin"), async (req, res) => {
  const parsed = vaultSecurityStatusQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const status = await getVaultSecurityStatus({
    userId: parsed.data.userId,
    limit: parsed.data.limit
  });

  await auditLog(req.user!.id, "admin.security.vault.status", {
    userId: parsed.data.userId ?? null,
    limit: parsed.data.limit,
    totals: status.totals
  });

  res.json(status);
});

adminRouter.post("/security/vault/rotate", authRequired, requireRole("admin"), async (req, res) => {
  const parsed = vaultRotateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const result = await rotateVaultSecrets({
    userId: parsed.data.userId,
    limit: parsed.data.limit
  });

  await auditLog(req.user!.id, "admin.security.vault.rotate", {
    userId: parsed.data.userId ?? null,
    limit: parsed.data.limit,
    scanned: result.scanned,
    rotated: result.rotated,
    unchanged: result.unchanged,
    failed: result.failed,
    activeKeyId: result.activeKeyId
  });

  res.json({
    ok: true,
    ...result
  });
});

adminRouter.get("/security/abuse/incidents", authRequired, requireRole("admin"), async (req, res) => {
  const parsed = abuseIncidentsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const items = await listAbuseIncidents({
    status: parsed.data.status,
    userId: parsed.data.userId,
    limit: parsed.data.limit,
    offset: parsed.data.offset
  });

  await auditLog(req.user!.id, "admin.security.abuse.incidents.read", {
    status: parsed.data.status,
    userId: parsed.data.userId ?? null,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    count: items.length
  });

  res.json({
    items,
    pagination: {
      status: parsed.data.status,
      userId: parsed.data.userId ?? null,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    }
  });
});

adminRouter.get("/security/abuse/summary", authRequired, requireRole("admin"), async (req, res) => {
  const parsed = abuseSummaryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const summary = await getAbuseSecuritySummary(parsed.data.windowMinutes);

  await auditLog(req.user!.id, "admin.security.abuse.summary.read", {
    windowMinutes: parsed.data.windowMinutes,
    openIncidents: summary.openIncidents,
    activeBlocks: summary.activeBlocks,
    recentEvents: summary.recentEvents
  });

  res.json(summary);
});

adminRouter.post("/security/abuse/incidents/:incidentId/resolve", authRequired, requireRole("admin"), async (req, res) => {
  const parsed = abuseResolveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const incidentId = String(req.params.incidentId);
  const resolved = await resolveAbuseIncident({
    incidentId,
    resolvedBy: req.user!.id,
    note: parsed.data.note,
    unblockUser: parsed.data.unblockUser
  });

  if (!resolved) {
    res.status(404).json({ error: "Incident not found", incidentId });
    return;
  }

  await auditLog(req.user!.id, "admin.security.abuse.incident.resolve", {
    incidentId,
    unblockUser: parsed.data.unblockUser,
    status: resolved.status
  });

  res.json({
    ok: true,
    incident: resolved
  });
});

adminRouter.get("/ops/metrics", authRequired, requirePermission("admin.audit.read"), async (req, res) => {
  const parsed = opsMetricsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  await persistOpsMetricsToStorage();

  const metrics = getOpsMetricsSnapshot(parsed.data.windowMinutes);
  const training = await getTrainingOpsSnapshot(parsed.data.windowMinutes);
  const windowMinutes = metrics.window.minutes;
  const windowCounts = metrics.window.counts;

  const thresholds = {
    cardsConflict409: scaleThreshold(env.OPS_ALERT_CARDS_409_15M, windowMinutes),
    marketplaceConflict409: scaleThreshold(env.OPS_ALERT_MARKETPLACE_409_15M, windowMinutes),
    rateLimited429: scaleThreshold(env.OPS_ALERT_RATE_LIMIT_429_15M, windowMinutes),
    serverErrors5xx: scaleThreshold(env.OPS_ALERT_HTTP_5XX_15M, windowMinutes),
    trainingQueueDepth: Math.max(1, env.OPS_ALERT_TRAINING_QUEUE_DEPTH),
    trainingFailureRatePercent: Math.max(0, env.OPS_ALERT_TRAINING_FAILURE_RATE_15M)
  };

  const alerts: string[] = [];

  if (windowCounts.cardsConflict409 >= thresholds.cardsConflict409) {
    alerts.push(
      `cards 409 conflicts above threshold: ${windowCounts.cardsConflict409} >= ${thresholds.cardsConflict409} (${windowMinutes}m)`
    );
  }

  if (windowCounts.marketplaceConflict409 >= thresholds.marketplaceConflict409) {
    alerts.push(
      `marketplace 409 conflicts above threshold: ${windowCounts.marketplaceConflict409} >= ${thresholds.marketplaceConflict409} (${windowMinutes}m)`
    );
  }

  if (windowCounts.rateLimited429 >= thresholds.rateLimited429) {
    alerts.push(`rate-limit 429 above threshold: ${windowCounts.rateLimited429} >= ${thresholds.rateLimited429} (${windowMinutes}m)`);
  }

  if (windowCounts.serverErrors5xx >= thresholds.serverErrors5xx) {
    alerts.push(`http 5xx above threshold: ${windowCounts.serverErrors5xx} >= ${thresholds.serverErrors5xx} (${windowMinutes}m)`);
  }

  if (training.queueDepth >= thresholds.trainingQueueDepth) {
    alerts.push(`training queue depth above threshold: ${training.queueDepth} >= ${thresholds.trainingQueueDepth}`);
  }

  if (
    training.window.failureRatePercent !== null &&
    training.window.failureRatePercent >= thresholds.trainingFailureRatePercent &&
    training.window.finishedTotal > 0
  ) {
    alerts.push(
      `training failure rate above threshold: ${training.window.failureRatePercent.toFixed(2)}% >= ${thresholds.trainingFailureRatePercent}% (${windowMinutes}m)`
    );
  }

  let redisQueue: Awaited<ReturnType<typeof getTrainingQueueMetrics>> | null = null;
  if (isRedisTrainingQueueEnabled()) {
    try {
      redisQueue = await getTrainingQueueMetrics();
    } catch (error) {
      console.error("[admin.ops.metrics] failed to load redis queue metrics", error);
    }
  }

  await auditLog(req.user!.id, "admin.ops.metrics.read", {
    windowMinutes,
    windowCounts,
    training,
    thresholds,
    alertsCount: alerts.length
  });

  res.json({
    ...metrics,
    training,
    queue: redisQueue,
    thresholds,
    alerts
  });
});

adminRouter.get("/ops/metrics/history", authRequired, requirePermission("admin.audit.read"), async (req, res) => {
  const parsed = opsMetricsHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  await persistOpsMetricsToStorage();
  const items = await listOpsMetricsHistory({
    minutes: parsed.data.minutes,
    limit: parsed.data.limit
  });

  await auditLog(req.user!.id, "admin.ops.metrics.history.read", {
    minutes: parsed.data.minutes,
    limit: parsed.data.limit,
    count: items.length
  });

  res.json({
    items,
    windowMinutes: parsed.data.minutes,
    limit: parsed.data.limit
  });
});

adminRouter.get("/ops/traces", authRequired, requirePermission("admin.audit.read"), async (req, res) => {
  const parsed = opsTracesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const items = listTraceSpans({
    minutes: parsed.data.minutes,
    limit: parsed.data.limit,
    traceId: parsed.data.traceId,
    kinds: parsed.data.kinds
  });

  await auditLog(req.user!.id, "admin.ops.traces.read", {
    minutes: parsed.data.minutes,
    limit: parsed.data.limit,
    traceId: parsed.data.traceId ?? null,
    kinds: parsed.data.kinds ?? [],
    count: items.length
  });

  res.json({
    items,
    windowMinutes: parsed.data.minutes,
    limit: parsed.data.limit,
    traceId: parsed.data.traceId ?? null,
    kinds: parsed.data.kinds ?? []
  });
});

adminRouter.get("/ops/traces/export", authRequired, requirePermission("admin.audit.read"), async (req, res) => {
  const parsed = opsTracesExportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const exported = exportTraceSpans({
    minutes: parsed.data.minutes,
    limit: parsed.data.limit,
    traceId: parsed.data.traceId,
    kinds: parsed.data.kinds
  });

  await auditLog(req.user!.id, "admin.ops.traces.export", {
    minutes: parsed.data.minutes,
    limit: parsed.data.limit,
    traceId: parsed.data.traceId ?? null,
    kinds: parsed.data.kinds ?? [],
    format: parsed.data.format,
    count: exported.items.length
  });

  if (parsed.data.format === "ndjson") {
    res.type("application/x-ndjson").send(exported.ndjson);
    return;
  }

  res.json({
    items: exported.items,
    windowMinutes: parsed.data.minutes,
    limit: parsed.data.limit,
    traceId: parsed.data.traceId ?? null,
    kinds: parsed.data.kinds ?? []
  });
});

adminRouter.get("/training/dlq", authRequired, requirePermission("admin.training.manage"), async (req, res) => {
  if (!isRedisTrainingQueueEnabled()) {
    res.status(409).json({
      error: "Training DLQ is only available when TRAINING_QUEUE_BACKEND=redis"
    });
    return;
  }

  const parsed = dlqQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const items = await listTrainingDlqJobs({
    limit: parsed.data.limit,
    offset: parsed.data.offset
  });

  await auditLog(req.user!.id, "admin.training.dlq.list", {
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    count: items.length
  });

  res.json({
    items,
    pagination: {
      limit: parsed.data.limit,
      offset: parsed.data.offset
    }
  });
});

adminRouter.post("/training/dlq/:id/requeue", authRequired, requirePermission("admin.training.manage"), async (req, res) => {
  if (!isRedisTrainingQueueEnabled()) {
    res.status(409).json({
      error: "Training DLQ is only available when TRAINING_QUEUE_BACKEND=redis"
    });
    return;
  }

  const parsed = dlqRequeueSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const dlqJobId = String(req.params.id);
  try {
    const requeued = await requeueTrainingDlqJob(dlqJobId, {
      removeOriginal: parsed.data.removeOriginal
    });

    await auditLog(req.user!.id, "admin.training.dlq.requeue", {
      dlqJobId,
      trainingJobId: requeued.trainingJobId,
      removeOriginal: parsed.data.removeOriginal
    });

    res.json({
      ok: true,
      dlqJobId,
      trainingJobId: requeued.trainingJobId,
      statusBefore: requeued.statusBefore,
      statusAfter: requeued.statusAfter,
      removeOriginal: parsed.data.removeOriginal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to requeue DLQ job";
    if (message === "DLQ job not found") {
      res.status(404).json({ error: message, dlqJobId });
      return;
    }

    res.status(400).json({ error: message, dlqJobId });
  }
});

adminRouter.post("/training/dlq/requeue-batch", authRequired, requirePermission("admin.training.manage"), async (req, res) => {
  if (!isRedisTrainingQueueEnabled()) {
    res.status(409).json({
      error: "Training DLQ is only available when TRAINING_QUEUE_BACKEND=redis"
    });
    return;
  }

  const parsed = dlqBatchRequeueSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const result = await requeueTrainingDlqBatch({
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    removeOriginal: parsed.data.removeOriginal,
    states: parsed.data.states
  });

  await auditLog(req.user!.id, "admin.training.dlq.requeue-batch", {
    ...result,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    removeOriginal: parsed.data.removeOriginal,
    states: parsed.data.states
  });

  res.json({
    ok: true,
    ...result,
    pagination: {
      limit: parsed.data.limit,
      offset: parsed.data.offset
    },
    removeOriginal: parsed.data.removeOriginal,
    states: parsed.data.states
  });
});

adminRouter.get("/training/queue-metrics", authRequired, requirePermission("admin.training.manage"), async (req, res) => {
  if (!isRedisTrainingQueueEnabled()) {
    res.status(409).json({
      error: "Training queue metrics are only available when TRAINING_QUEUE_BACKEND=redis"
    });
    return;
  }

  const metrics = await getTrainingQueueMetrics();
  const alerts: string[] = [];

  const dlqBacklog = metrics.dlq.waiting + metrics.dlq.active + metrics.dlq.delayed;
  if (dlqBacklog >= env.TRAINING_DLQ_ALERT_THRESHOLD) {
    alerts.push(
      `DLQ backlog above threshold: ${dlqBacklog} >= ${env.TRAINING_DLQ_ALERT_THRESHOLD} (queue=${metrics.dlqName})`
    );
  }

  if (metrics.queue.failed > 0) {
    alerts.push(`Main queue has failed jobs retained: ${metrics.queue.failed}`);
  }

  await auditLog(req.user!.id, "admin.training.queue-metrics.read", {
    queueName: metrics.queueName,
    dlqName: metrics.dlqName,
    queue: metrics.queue,
    dlq: metrics.dlq,
    alertsCount: alerts.length
  });

  res.json({
    ...metrics,
    alerts
  });
});
