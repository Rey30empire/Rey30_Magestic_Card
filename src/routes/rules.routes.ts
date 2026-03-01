import { randomUUID } from "node:crypto";
import { Router } from "express";
import { globalRuleSchema, projectRuleSchema } from "../schemas/acs.schemas";
import { all, auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { requirePermission } from "../middleware/authorization";

type GlobalRuleRow = {
  id: string;
  title: string;
  content: string;
  enforcement: "soft" | "hard";
  priority: number;
  active: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type ProjectRuleRow = {
  id: string;
  project_id: string;
  title: string;
  content: string;
  enforcement: "soft" | "hard";
  priority: number;
  active: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type ProjectAccess =
  | { ok: true; projectId: string; ownerUserId: string; created: boolean }
  | { ok: false; reason: "forbidden" | "missing" };

async function ensureProjectAccess(
  projectId: string,
  userId: string,
  isAdmin: boolean,
  options?: { createIfMissing?: boolean }
): Promise<ProjectAccess> {
  const existing = await get<{ id: string; owner_user_id: string }>("SELECT id, owner_user_id FROM projects WHERE id = ?", [projectId]);
  if (existing) {
    if (isAdmin || existing.owner_user_id === userId) {
      return {
        ok: true,
        projectId: existing.id,
        ownerUserId: existing.owner_user_id,
        created: false
      };
    }

    return { ok: false, reason: "forbidden" };
  }

  if (!options?.createIfMissing) {
    return { ok: false, reason: "missing" };
  }

  const now = new Date().toISOString();
  await run(
    `
      INSERT INTO projects (id, owner_user_id, name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'active', ?, ?)
    `,
    [projectId, userId, `Project ${projectId.slice(0, 8)}`, now, now]
  );

  return {
    ok: true,
    projectId,
    ownerUserId: userId,
    created: true
  };
}

export const rulesRouter = Router();

rulesRouter.get("/global", authRequired, requirePermission("rules.manage.global"), async (_req, res) => {
  const rows = await all<GlobalRuleRow>(
    `
      SELECT id, title, content, enforcement, priority, active, created_by, created_at, updated_at
      FROM global_rules
      ORDER BY priority DESC, updated_at DESC
    `
  );

  res.json({
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      enforcement: row.enforcement,
      priority: row.priority,
      active: row.active === 1,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  });
});

rulesRouter.post("/global", authRequired, requirePermission("rules.manage.global"), async (req, res) => {
  const parsed = globalRuleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  await run(
    `
      INSERT INTO global_rules (id, title, content, enforcement, priority, active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      parsed.data.title,
      parsed.data.content,
      parsed.data.enforcement,
      parsed.data.priority,
      parsed.data.active ? 1 : 0,
      req.user!.id,
      now,
      now
    ]
  );

  await auditLog(req.user!.id, "rules.global.create", {
    ruleId: id,
    enforcement: parsed.data.enforcement,
    priority: parsed.data.priority,
    active: parsed.data.active
  });

  res.status(201).json({ id });
});

rulesRouter.get("/project", authRequired, async (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  if (!projectId) {
    res.status(400).json({ error: "projectId query is required" });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const access = await ensureProjectAccess(projectId, req.user!.id, isAdmin);
  if (!access.ok) {
    res.status(access.reason === "forbidden" ? 403 : 404).json({ error: "Project not found" });
    return;
  }

  const rows = await all<ProjectRuleRow>(
    `
      SELECT id, project_id, title, content, enforcement, priority, active, created_by, created_at, updated_at
      FROM project_rules
      WHERE project_id = ?
      ORDER BY priority DESC, updated_at DESC
    `,
    [projectId]
  );

  res.json({
    items: rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      content: row.content,
      enforcement: row.enforcement,
      priority: row.priority,
      active: row.active === 1,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  });
});

rulesRouter.post("/project", authRequired, requirePermission("rules.manage.project"), async (req, res) => {
  const parsed = projectRuleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const access = await ensureProjectAccess(parsed.data.projectId, req.user!.id, isAdmin, { createIfMissing: true });
  if (!access.ok) {
    res.status(access.reason === "forbidden" ? 403 : 404).json({ error: "Project not found" });
    return;
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  await run(
    `
      INSERT INTO project_rules (id, project_id, title, content, enforcement, priority, active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      parsed.data.projectId,
      parsed.data.title,
      parsed.data.content,
      parsed.data.enforcement,
      parsed.data.priority,
      parsed.data.active ? 1 : 0,
      req.user!.id,
      now,
      now
    ]
  );

  await auditLog(req.user!.id, "rules.project.create", {
    projectId: parsed.data.projectId,
    ruleId: id,
    enforcement: parsed.data.enforcement,
    priority: parsed.data.priority
  });

  res.status(201).json({ id, projectId: parsed.data.projectId });
});
