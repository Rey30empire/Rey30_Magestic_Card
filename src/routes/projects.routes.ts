import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { all, auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { createProjectSchema, listProjectsQuerySchema, updateProjectSchema } from "../schemas/acs.schemas";

type ProjectRow = {
  id: string;
  owner_user_id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
};

function mapProject(row: ProjectRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getProjectForUser(userId: string, projectId: string, isAdmin: boolean): Promise<ProjectRow | undefined> {
  if (isAdmin) {
    return get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [projectId]);
  }

  return get<ProjectRow>("SELECT * FROM projects WHERE id = ? AND owner_user_id = ?", [projectId, userId]);
}

export const projectsRouter = Router();

projectsRouter.use(authRequired);

projectsRouter.post("/", async (req, res) => {
  const parsed = createProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  await run(
    `
      INSERT INTO projects (id, owner_user_id, name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `,
    [id, req.user!.id, parsed.data.name, parsed.data.description ?? null, now, now]
  );

  await auditLog(req.user!.id, "projects.create", {
    projectId: id
  });

  res.status(201).json({
    id,
    status: "active"
  });
});

projectsRouter.get("/", async (req, res) => {
  const querySchema = listProjectsQuerySchema.extend({
    userId: z.string().uuid().optional()
  });

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (!isAdmin) {
    where.push("owner_user_id = ?");
    params.push(req.user!.id);
  } else if (parsed.data.userId) {
    where.push("owner_user_id = ?");
    params.push(parsed.data.userId);
  }

  if (parsed.data.status) {
    where.push("status = ?");
    params.push(parsed.data.status);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await all<ProjectRow>(
    `
      SELECT id, owner_user_id, name, description, status, created_at, updated_at
      FROM projects
      ${whereSql}
      ORDER BY updated_at DESC
      LIMIT ?
      OFFSET ?
    `,
    [...params, parsed.data.limit, parsed.data.offset]
  );

  res.json({
    items: rows.map(mapProject)
  });
});

projectsRouter.get("/:id", async (req, res) => {
  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const project = await getProjectForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(mapProject(project));
});

projectsRouter.patch("/:id", async (req, res) => {
  const parsed = updateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const project = await getProjectForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const next = {
    name: parsed.data.name ?? project.name,
    description: parsed.data.description !== undefined ? parsed.data.description : project.description,
    status: parsed.data.status ?? project.status
  };

  const now = new Date().toISOString();
  await run(
    `
      UPDATE projects
      SET name = ?, description = ?, status = ?, updated_at = ?
      WHERE id = ?
    `,
    [next.name, next.description, next.status, now, project.id]
  );

  await auditLog(req.user!.id, "projects.update", {
    projectId: project.id,
    fields: Object.keys(parsed.data)
  });

  const updated = await get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [project.id]);
  res.json(updated ? mapProject(updated) : { id: project.id, updated: true });
});

projectsRouter.delete("/:id", async (req, res) => {
  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const project = await getProjectForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const now = new Date().toISOString();
  await run("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ?", [now, project.id]);

  await auditLog(req.user!.id, "projects.archive", {
    projectId: project.id
  });

  res.json({
    id: project.id,
    status: "archived"
  });
});
