import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { all, auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { requirePermission } from "../middleware/authorization";
import { createMemorySchema, memoryQuerySchema, paginationQuerySchema } from "../schemas/acs.schemas";
import { parseJsonSafe } from "../utils/json";

type MemoryRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  agent_id: string | null;
  scope: string;
  content: string;
  metadata: string;
  created_at: string;
  updated_at: string;
};

const querySchema = memoryQuerySchema.merge(paginationQuerySchema);

type ProjectAccess =
  | { ok: true; projectId: string; created: boolean }
  | { ok: false; reason: "forbidden" };

async function ensureProjectExistsForUser(projectId: string, userId: string, isAdmin: boolean): Promise<ProjectAccess> {
  const existing = await get<{ id: string; owner_user_id: string }>("SELECT id, owner_user_id FROM projects WHERE id = ?", [projectId]);
  if (existing) {
    if (isAdmin || existing.owner_user_id === userId) {
      return { ok: true, projectId: existing.id, created: false };
    }

    return { ok: false, reason: "forbidden" };
  }

  const now = new Date().toISOString();
  await run(
    `
      INSERT INTO projects (id, owner_user_id, name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'active', ?, ?)
    `,
    [projectId, userId, `Project ${projectId.slice(0, 8)}`, now, now]
  );

  return { ok: true, projectId, created: true };
}

export const memoryRouter = Router();

memoryRouter.post("/", authRequired, requirePermission("memory.manage"), async (req, res) => {
  const parsed = createMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  if (parsed.data.scope === "project" && !parsed.data.projectId) {
    res.status(400).json({ error: "projectId is required when scope=project" });
    return;
  }

  if (parsed.data.scope === "agent" && !parsed.data.agentId) {
    res.status(400).json({ error: "agentId is required when scope=agent" });
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
    const projectAccess = await ensureProjectExistsForUser(parsed.data.projectId, req.user!.id, isAdmin);
    if (!projectAccess.ok) {
      res.status(403).json({ error: "Project is not owned by user" });
      return;
    }
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  await run(
    `
      INSERT INTO rag_memories (id, user_id, project_id, agent_id, scope, content, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      req.user!.id,
      parsed.data.projectId ?? null,
      parsed.data.agentId ?? null,
      parsed.data.scope,
      parsed.data.text,
      JSON.stringify(parsed.data.metadata),
      now,
      now
    ]
  );

  await auditLog(req.user!.id, "memory.create", {
    memoryId: id,
    scope: parsed.data.scope,
    projectId: parsed.data.projectId ?? null,
    agentId: parsed.data.agentId ?? null
  });

  res.status(201).json({
    id,
    scope: parsed.data.scope,
    createdAt: now
  });
});

memoryRouter.get("/", authRequired, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (!isAdmin) {
    where.push("user_id = ?");
    params.push(req.user!.id);
  } else if (typeof req.query.userId === "string") {
    where.push("user_id = ?");
    params.push(req.query.userId);
  }

  if (parsed.data.scope) {
    where.push("scope = ?");
    params.push(parsed.data.scope);
  }

  if (parsed.data.projectId) {
    where.push("project_id = ?");
    params.push(parsed.data.projectId);
  }

  if (parsed.data.agentId) {
    where.push("agent_id = ?");
    params.push(parsed.data.agentId);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await all<MemoryRow>(
    `
      SELECT id, user_id, project_id, agent_id, scope, content, metadata, created_at, updated_at
      FROM rag_memories
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ?
      OFFSET ?
    `,
    [...params, parsed.data.limit, parsed.data.offset]
  );

  res.json({
    items: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      projectId: row.project_id,
      agentId: row.agent_id,
      scope: row.scope,
      text: row.content,
      metadata: parseJsonSafe<Record<string, unknown>>(row.metadata, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  });
});

memoryRouter.delete("/:id", authRequired, requirePermission("memory.manage"), async (req, res) => {
  const memoryId = String(req.params.id);
  const isAdmin = (req.user!.roles ?? []).includes("admin");

  const row = isAdmin
    ? await get<MemoryRow>("SELECT * FROM rag_memories WHERE id = ?", [memoryId])
    : await get<MemoryRow>("SELECT * FROM rag_memories WHERE id = ? AND user_id = ?", [memoryId, req.user!.id]);

  if (!row) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }

  await run("DELETE FROM rag_memories WHERE id = ?", [memoryId]);
  await auditLog(req.user!.id, "memory.delete", { memoryId });

  res.json({ id: memoryId, deleted: true });
});
