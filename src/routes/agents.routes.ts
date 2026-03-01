import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  agentRuleSchema,
  assignAgentSkillsSchema,
  assignAgentToolsSchema,
  connectAgentSchema,
  createAgentSchema,
  sandboxTestSchema,
  updateAgentSchema
} from "../schemas/acs.schemas";
import { all, auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { requirePermission } from "../middleware/authorization";
import { getUserPermissions } from "../services/rbac";
import { resolveEffectiveRules } from "../services/rules-resolver";
import { getToolDefinition, listSupportedTools } from "../services/tools-registry";
import { getVaultMetadata, storeVaultSecret } from "../services/vault";
import { buildZodSchema, SchemaDefinition } from "../schemas/schema-definition";
import { parseJsonSafe } from "../utils/json";
import { listAgentConfigVersions, recordAgentConfigVersion, rollbackAgentConfigVersion } from "../services/agent-config-versions";
import { listAgentToolRuns } from "../services/agent-tool-runs";

type AgentRow = {
  id: string;
  owner_user_id: string;
  project_id: string | null;
  name: string;
  role: string;
  detail: string | null;
  personality: string | null;
  lore: string | null;
  memory_scope: string;
  status: "disconnected" | "connected" | "suspended";
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
};

type AgentConnectionRow = {
  id: string;
  provider: string;
  model: string;
  keys_ref: string | null;
  status: string;
  config: string;
  connected_at: string | null;
  disconnected_at: string | null;
};

type AgentToolRow = {
  id: string;
  tool_key: string;
  allowed: number;
  config: string;
  updated_at: string;
};

type AgentSkillRow = {
  id: string;
  skill_id: string;
  skill_version: string;
  enabled: number;
  config: string;
};

type SkillCatalogRow = {
  id: string;
  name: string;
  version: string;
  status?: string;
  input_schema: string;
  output_schema: string;
};

type SkillTestRow = {
  id: string;
  name: string;
  input_payload: string;
  expected_output: string;
};

async function getAgentForUser(userId: string, agentId: string, isAdmin: boolean): Promise<AgentRow | undefined> {
  if (isAdmin) {
    return get<AgentRow>("SELECT * FROM agents WHERE id = ?", [agentId]);
  }

  return get<AgentRow>("SELECT * FROM agents WHERE id = ? AND owner_user_id = ?", [agentId, userId]);
}

function mapAgent(agent: AgentRow): Record<string, unknown> {
  return {
    id: agent.id,
    ownerUserId: agent.owner_user_id,
    projectId: agent.project_id,
    name: agent.name,
    role: agent.role,
    detail: agent.detail,
    personality: agent.personality,
    lore: agent.lore,
    memoryScope: agent.memory_scope,
    status: agent.status,
    provider: agent.provider,
    model: agent.model,
    createdAt: agent.created_at,
    updatedAt: agent.updated_at
  };
}

function parseRuleForbiddenTools(rules: { enforcement: "soft" | "hard"; content: string }[]): Set<string> {
  const forbidden = new Set<string>();

  for (const rule of rules) {
    if (rule.enforcement !== "hard") {
      continue;
    }

    const matches = rule.content.matchAll(/forbid_tool:([a-zA-Z0-9._-]+)/g);
    for (const match of matches) {
      if (match[1]) {
        forbidden.add(match[1]);
      }
    }
  }

  return forbidden;
}

const agentVersionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(200_000).default(0)
});

const agentRollbackSchema = z.object({
  version: z.number().int().min(1),
  note: z.string().trim().min(2).max(400).optional()
});

const agentToolRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(200_000).default(0),
  status: z.enum(["all", "success", "failed", "blocked", "denied"]).default("all"),
  toolKey: z.string().min(3).max(120).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

async function safeRecordAgentConfigVersion(input: {
  agentId: string;
  createdBy: string | null;
  reason: string;
}): Promise<void> {
  try {
    await recordAgentConfigVersion(input);
  } catch (error) {
    console.error("[agents.versioning] failed to record config version", {
      agentId: input.agentId,
      reason: input.reason,
      error
    });
  }
}

export const agentsRouter = Router();

agentsRouter.post("/", authRequired, requirePermission("agents.manage"), async (req, res) => {
  const parsed = createAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  await run(
    `
      INSERT INTO agents (
        id, owner_user_id, project_id, name, role, detail, personality, lore, memory_scope,
        status, provider, model, created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'disconnected', NULL, NULL, ?, ?)
    `,
    [
      id,
      req.user!.id,
      parsed.data.name,
      parsed.data.role,
      parsed.data.detail ?? null,
      parsed.data.personality ?? null,
      parsed.data.lore ?? null,
      parsed.data.memoryScope,
      now,
      now
    ]
  );
  await safeRecordAgentConfigVersion({
    agentId: id,
    createdBy: req.user!.id,
    reason: "create"
  });

  await auditLog(req.user!.id, "agents.create", { agentId: id, status: "disconnected" });

  res.status(201).json({
    id,
    status: "disconnected"
  });
});

agentsRouter.get("/", authRequired, async (req, res) => {
  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

  const params: (string | number)[] = [];
  const where: string[] = [];

  if (!isAdmin) {
    where.push("owner_user_id = ?");
    params.push(req.user!.id);
  }

  if (projectId) {
    where.push("project_id = ?");
    params.push(projectId);
  }

  const sqlWhere = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await all<AgentRow>(`SELECT * FROM agents ${sqlWhere} ORDER BY updated_at DESC LIMIT 300`, params);
  res.json({ items: rows.map(mapAgent) });
});

agentsRouter.get("/:id", authRequired, async (req, res) => {
  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const connection = await get<AgentConnectionRow>("SELECT * FROM agent_connections WHERE agent_id = ?", [agent.id]);
  const tools = await all<AgentToolRow>("SELECT * FROM agent_tools WHERE agent_id = ? ORDER BY updated_at DESC", [agent.id]);
  const skills = await all<AgentSkillRow>("SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY created_at DESC", [agent.id]);
  const rules = await resolveEffectiveRules({ agentId: agent.id, projectId: agent.project_id ?? undefined });

  const latestSandbox = await get<{ id: string; status: string; result: string; created_at: string }>(
    `
      SELECT id, status, result, created_at
      FROM agent_sandbox_tests
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [agent.id]
  );

  res.json({
    ...mapAgent(agent),
    connection: connection
      ? {
          provider: connection.provider,
          model: connection.model,
          keysRef: connection.keys_ref,
          status: connection.status,
          params: parseJsonSafe<Record<string, unknown>>(connection.config, {}),
          connectedAt: connection.connected_at,
          disconnectedAt: connection.disconnected_at
        }
      : null,
    tools: tools.map((tool) => ({
      toolKey: tool.tool_key,
      allowed: tool.allowed === 1,
      config: parseJsonSafe<Record<string, unknown>>(tool.config, {}),
      updatedAt: tool.updated_at
    })),
    skills: skills.map((skill) => ({
      id: skill.id,
      skillId: skill.skill_id,
      skillVersion: skill.skill_version,
      enabled: skill.enabled === 1,
      config: parseJsonSafe<Record<string, unknown>>(skill.config, {})
    })),
    effectiveRules: rules.effectiveRules,
    latestSandboxTest: latestSandbox
      ? {
          id: latestSandbox.id,
          status: latestSandbox.status,
          result: parseJsonSafe<Record<string, unknown>>(latestSandbox.result, {}),
          createdAt: latestSandbox.created_at
        }
      : null
  });
});

agentsRouter.get("/:id/versions", authRequired, async (req, res) => {
  const parsed = agentVersionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  let versions = await listAgentConfigVersions(agent.id, parsed.data.limit, parsed.data.offset);
  if (versions.latestVersion === 0) {
    await safeRecordAgentConfigVersion({
      agentId: agent.id,
      createdBy: req.user!.id,
      reason: "bootstrap"
    });
    versions = await listAgentConfigVersions(agent.id, parsed.data.limit, parsed.data.offset);
  }

  res.json({
    agentId: agent.id,
    latestVersion: versions.latestVersion,
    items: versions.items,
    pagination: {
      limit: parsed.data.limit,
      offset: parsed.data.offset
    }
  });
});

agentsRouter.get("/:id/tool-runs", authRequired, async (req, res) => {
  const parsed = agentToolRunsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const items = await listAgentToolRuns({
    agentId: agent.id,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    status: parsed.data.status,
    toolKey: parsed.data.toolKey,
    from: parsed.data.from,
    to: parsed.data.to
  });

  res.json({
    agentId: agent.id,
    items,
    pagination: {
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      status: parsed.data.status,
      toolKey: parsed.data.toolKey ?? null,
      from: parsed.data.from ?? null,
      to: parsed.data.to ?? null
    }
  });
});

agentsRouter.patch("/:id", authRequired, requirePermission("agents.manage"), async (req, res) => {
  const parsed = updateAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const next = {
    name: parsed.data.name ?? agent.name,
    role: parsed.data.role ?? agent.role,
    detail: parsed.data.detail ?? agent.detail,
    personality: parsed.data.personality ?? agent.personality,
    lore: parsed.data.lore ?? agent.lore,
    memoryScope: parsed.data.memoryScope ?? agent.memory_scope
  };

  await run(
    `
      UPDATE agents
      SET name = ?, role = ?, detail = ?, personality = ?, lore = ?, memory_scope = ?, updated_at = ?
      WHERE id = ?
    `,
    [next.name, next.role, next.detail, next.personality, next.lore, next.memoryScope, new Date().toISOString(), agent.id]
  );
  await safeRecordAgentConfigVersion({
    agentId: agent.id,
    createdBy: req.user!.id,
    reason: `update:${Object.keys(parsed.data).join(",")}`
  });

  await auditLog(req.user!.id, "agents.update", { agentId: agent.id, fields: Object.keys(parsed.data) });

  res.json({ id: agent.id, updated: true });
});

agentsRouter.post("/:id/rollback", authRequired, requirePermission("agents.manage"), async (req, res) => {
  const parsed = agentRollbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  let rollbackResult: { rolledBackToVersion: number; newVersion: number } | null;
  try {
    rollbackResult = await rollbackAgentConfigVersion({
      agentId: agent.id,
      version: parsed.data.version,
      actorUserId: req.user!.id,
      note: parsed.data.note
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to rollback agent config";
    res.status(500).json({ error: message });
    return;
  }

  if (!rollbackResult) {
    res.status(404).json({
      error: "Version not found for agent",
      version: parsed.data.version
    });
    return;
  }

  await auditLog(req.user!.id, "agents.rollback", {
    agentId: agent.id,
    rolledBackToVersion: rollbackResult.rolledBackToVersion,
    newVersion: rollbackResult.newVersion
  });

  const updatedAgent = await getAgentForUser(req.user!.id, agent.id, true);
  res.json({
    agentId: agent.id,
    rolledBackToVersion: rollbackResult.rolledBackToVersion,
    newVersion: rollbackResult.newVersion,
    status: updatedAgent?.status ?? "unknown"
  });
});

agentsRouter.post("/:id/connect", authRequired, requirePermission("agents.connect"), async (req, res) => {
  const parsed = connectAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  let keysRef = parsed.data.keysRef ?? null;

  if (!keysRef && parsed.data.apiKey) {
    const stored = await storeVaultSecret(req.user!.id, `${parsed.data.provider}:${parsed.data.model}`, parsed.data.apiKey);
    keysRef = stored.keysRef;
  }

  if (keysRef) {
    const metadata = await getVaultMetadata(req.user!.id, keysRef);
    if (!metadata) {
      res.status(404).json({ error: "keysRef not found in vault" });
      return;
    }
  }

  const now = new Date().toISOString();
  const config = JSON.stringify({ params: parsed.data.params });

  const existing = await get<{ id: string }>("SELECT id FROM agent_connections WHERE agent_id = ?", [agent.id]);

  if (existing) {
    await run(
      `
        UPDATE agent_connections
        SET provider = ?, model = ?, keys_ref = ?, config = ?, status = 'connected', connected_at = ?, disconnected_at = NULL, updated_at = ?
        WHERE agent_id = ?
      `,
      [parsed.data.provider, parsed.data.model, keysRef, config, now, now, agent.id]
    );
  } else {
    await run(
      `
        INSERT INTO agent_connections (
          id, agent_id, provider, model, keys_ref, config, status, connected_at, disconnected_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, NULL, ?, ?)
      `,
      [randomUUID(), agent.id, parsed.data.provider, parsed.data.model, keysRef, config, now, now, now]
    );
  }

  await run(
    `
      UPDATE agents
      SET status = 'connected', provider = ?, model = ?, updated_at = ?
      WHERE id = ?
    `,
    [parsed.data.provider, parsed.data.model, now, agent.id]
  );
  await safeRecordAgentConfigVersion({
    agentId: agent.id,
    createdBy: req.user!.id,
    reason: "connect"
  });

  await auditLog(req.user!.id, "agents.connect", {
    agentId: agent.id,
    provider: parsed.data.provider,
    model: parsed.data.model,
    keysRef
  });

  res.json({
    agentId: agent.id,
    status: "connected",
    provider: parsed.data.provider,
    model: parsed.data.model,
    keysRef
  });
});

agentsRouter.post("/:id/disconnect", authRequired, requirePermission("agents.connect"), async (req, res) => {
  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const now = new Date().toISOString();

  await run("UPDATE agents SET status = 'disconnected', provider = NULL, model = NULL, updated_at = ? WHERE id = ?", [now, agent.id]);
  await run(
    `
      UPDATE agent_connections
      SET status = 'disconnected', disconnected_at = ?, updated_at = ?
      WHERE agent_id = ?
    `,
    [now, now, agent.id]
  );
  await safeRecordAgentConfigVersion({
    agentId: agent.id,
    createdBy: req.user!.id,
    reason: "disconnect"
  });

  await auditLog(req.user!.id, "agents.disconnect", { agentId: agent.id });

  res.json({ agentId: agent.id, status: "disconnected" });
});

agentsRouter.post("/:id/suspend", authRequired, requirePermission("agents.manage"), async (req, res) => {
  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  await run("UPDATE agents SET status = 'suspended', updated_at = ? WHERE id = ?", [new Date().toISOString(), agent.id]);
  await safeRecordAgentConfigVersion({
    agentId: agent.id,
    createdBy: req.user!.id,
    reason: "suspend"
  });
  await auditLog(req.user!.id, "agents.suspend", { agentId: agent.id });

  res.json({ agentId: agent.id, status: "suspended" });
});

agentsRouter.post("/:id/duplicate", authRequired, requirePermission("agents.manage"), async (req, res) => {
  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const newId = randomUUID();
  const now = new Date().toISOString();

  await run(
    `
      INSERT INTO agents (
        id, owner_user_id, project_id, name, role, detail, personality, lore, memory_scope,
        status, provider, model, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'disconnected', NULL, NULL, ?, ?)
    `,
    [
      newId,
      req.user!.id,
      agent.project_id,
      `${agent.name} (copy)`,
      agent.role,
      agent.detail,
      agent.personality,
      agent.lore,
      agent.memory_scope,
      now,
      now
    ]
  );

  const rules = await all<{
    project_id: string | null;
    session_id: string | null;
    level: string;
    title: string;
    content: string;
    enforcement: string;
    priority: number;
    active: number;
  }>(
    `
      SELECT project_id, session_id, level, title, content, enforcement, priority, active
      FROM agent_rules
      WHERE agent_id = ?
    `,
    [agent.id]
  );

  for (const rule of rules) {
    await run(
      `
        INSERT INTO agent_rules (
          id, agent_id, project_id, session_id, level, title, content, enforcement, priority, active, created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        newId,
        rule.project_id,
        rule.session_id,
        rule.level,
        rule.title,
        rule.content,
        rule.enforcement,
        rule.priority,
        rule.active,
        req.user!.id,
        now,
        now
      ]
    );
  }

  const skills = await all<AgentSkillRow>("SELECT * FROM agent_skills WHERE agent_id = ?", [agent.id]);
  for (const skill of skills) {
    await run(
      `
        INSERT INTO agent_skills (id, agent_id, skill_id, skill_version, config, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [randomUUID(), newId, skill.skill_id, skill.skill_version, skill.config, skill.enabled, now]
    );
  }

  const tools = await all<AgentToolRow>("SELECT * FROM agent_tools WHERE agent_id = ?", [agent.id]);
  for (const tool of tools) {
    await run(
      `
        INSERT INTO agent_tools (id, agent_id, tool_key, allowed, config, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [randomUUID(), newId, tool.tool_key, tool.allowed, tool.config, now, now]
    );
  }
  await safeRecordAgentConfigVersion({
    agentId: newId,
    createdBy: req.user!.id,
    reason: `duplicate-from:${agent.id}`
  });

  await auditLog(req.user!.id, "agents.duplicate", {
    sourceAgentId: agent.id,
    duplicatedAgentId: newId,
    duplicatedRules: rules.length,
    duplicatedSkills: skills.length,
    duplicatedTools: tools.length
  });

  res.status(201).json({ sourceAgentId: agent.id, duplicatedAgentId: newId, status: "disconnected" });
});

agentsRouter.delete("/:id", authRequired, requirePermission("agents.manage"), async (req, res) => {
  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  await run("DELETE FROM agents WHERE id = ?", [agent.id]);
  await auditLog(req.user!.id, "agents.delete", { agentId: agent.id });

  res.json({ agentId: agent.id, deleted: true });
});

agentsRouter.get("/:id/rules", authRequired, async (req, res) => {
  const agentId = String(req.params.id);
  const isAdmin = (req.user!.roles ?? []).includes("admin");

  const agent = await getAgentForUser(req.user!.id, agentId, isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : agent.project_id ?? undefined;

  const resolved = await resolveEffectiveRules({
    agentId,
    projectId,
    sessionId
  });

  res.json(resolved);
});

agentsRouter.post("/:id/rules", authRequired, requirePermission("rules.manage.agent"), async (req, res) => {
  const agentId = String(req.params.id);
  const parsed = agentRuleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  if (parsed.data.level === "session" && !parsed.data.sessionId) {
    res.status(400).json({ error: "sessionId is required for session-level rules" });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, agentId, isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
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

  const now = new Date().toISOString();
  const id = randomUUID();

  await run(
    `
      INSERT INTO agent_rules (
        id, agent_id, project_id, session_id, level, title, content, enforcement, priority, active, created_by, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      agentId,
      parsed.data.projectId ?? agent.project_id,
      parsed.data.sessionId ?? null,
      parsed.data.level,
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
  await safeRecordAgentConfigVersion({
    agentId,
    createdBy: req.user!.id,
    reason: "rules.create"
  });

  await auditLog(req.user!.id, "agents.rules.create", {
    agentId,
    ruleId: id,
    level: parsed.data.level,
    enforcement: parsed.data.enforcement,
    priority: parsed.data.priority
  });

  const resolved = await resolveEffectiveRules({
    agentId,
    projectId: parsed.data.projectId ?? agent.project_id ?? undefined,
    sessionId: parsed.data.sessionId
  });

  res.status(201).json({
    id,
    effectiveRules: resolved.effectiveRules
  });
});

agentsRouter.post("/:id/tools", authRequired, requirePermission("agents.tools.assign"), async (req, res) => {
  const parsed = assignAgentToolsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const permissions = await getUserPermissions(req.user!.id, req.user!.role);
  const now = new Date().toISOString();

  for (const update of parsed.data.updates) {
    const tool = getToolDefinition(update.toolKey);
    if (!tool) {
      res.status(404).json({ error: `Unsupported tool: ${update.toolKey}` });
      return;
    }

    if (!(req.user!.roles ?? []).includes("admin") && !permissions.includes(tool.requiredPermission)) {
      res.status(403).json({
        error: `Missing permission required for tool ${update.toolKey}`,
        requiredPermission: tool.requiredPermission
      });
      return;
    }

    const existing = await get<{ id: string }>("SELECT id FROM agent_tools WHERE agent_id = ? AND tool_key = ?", [agent.id, update.toolKey]);

    if (existing) {
      await run(
        `
          UPDATE agent_tools
          SET allowed = ?, config = ?, updated_at = ?
          WHERE agent_id = ? AND tool_key = ?
        `,
        [update.allowed ? 1 : 0, JSON.stringify(update.config ?? {}), now, agent.id, update.toolKey]
      );
    } else {
      await run(
        `
          INSERT INTO agent_tools (id, agent_id, tool_key, allowed, config, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [randomUUID(), agent.id, update.toolKey, update.allowed ? 1 : 0, JSON.stringify(update.config ?? {}), now, now]
      );
    }
  }
  await safeRecordAgentConfigVersion({
    agentId: agent.id,
    createdBy: req.user!.id,
    reason: "tools.update"
  });

  await auditLog(req.user!.id, "agents.tools.update", {
    agentId: agent.id,
    updates: parsed.data.updates.map((item) => ({ toolKey: item.toolKey, allowed: item.allowed }))
  });

  const tools = await all<AgentToolRow>("SELECT * FROM agent_tools WHERE agent_id = ? ORDER BY updated_at DESC", [agent.id]);
  const supported = listSupportedTools();

  res.json({
    agentId: agent.id,
    tools: tools.map((tool) => ({
      toolKey: tool.tool_key,
      allowed: tool.allowed === 1,
      config: parseJsonSafe<Record<string, unknown>>(tool.config, {}),
      updatedAt: tool.updated_at,
      requiredPermission: supported.find((item) => item.key === tool.tool_key)?.requiredPermission ?? null
    }))
  });
});

agentsRouter.post("/:id/skills", authRequired, requirePermission("agents.manage"), async (req, res) => {
  const parsed = assignAgentSkillsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const now = new Date().toISOString();
  const updatesSummary: Array<Record<string, unknown>> = [];

  for (const update of parsed.data.updates) {
    if (update.remove) {
      await run("DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?", [agent.id, update.skillId]);
      updatesSummary.push({
        skillId: update.skillId,
        action: "removed"
      });
      continue;
    }

    const skill = await get<SkillCatalogRow>(
      `
        SELECT id, name, version, status, input_schema, output_schema
        FROM skills_catalog
        WHERE id = ?
      `,
      [update.skillId]
    );
    if (!skill) {
      res.status(404).json({ error: `Skill not found: ${update.skillId}` });
      return;
    }

    if (skill.status && skill.status !== "active") {
      res.status(409).json({
        error: `Skill is not active: ${update.skillId}`,
        status: skill.status
      });
      return;
    }

    const updated = await run(
      `
        UPDATE agent_skills
        SET skill_version = ?, config = ?, enabled = ?
        WHERE agent_id = ? AND skill_id = ?
      `,
      [skill.version, JSON.stringify(update.config ?? {}), update.enabled ? 1 : 0, agent.id, update.skillId]
    );

    if (updated.changes === 0) {
      await run(
        `
          INSERT INTO agent_skills (id, agent_id, skill_id, skill_version, config, enabled, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [randomUUID(), agent.id, update.skillId, skill.version, JSON.stringify(update.config ?? {}), update.enabled ? 1 : 0, now]
      );
    }

    updatesSummary.push({
      skillId: update.skillId,
      skillVersion: skill.version,
      enabled: update.enabled,
      action: updated.changes === 0 ? "assigned" : "updated"
    });
  }
  await safeRecordAgentConfigVersion({
    agentId: agent.id,
    createdBy: req.user!.id,
    reason: "skills.update"
  });

  await auditLog(req.user!.id, "agents.skills.update", {
    agentId: agent.id,
    updates: updatesSummary
  });

  const skills = await all<AgentSkillRow>("SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY created_at DESC", [agent.id]);

  res.json({
    agentId: agent.id,
    updates: updatesSummary,
    skills: skills.map((skill) => ({
      id: skill.id,
      skillId: skill.skill_id,
      skillVersion: skill.skill_version,
      enabled: skill.enabled === 1,
      config: parseJsonSafe<Record<string, unknown>>(skill.config, {})
    }))
  });
});

agentsRouter.post("/:id/sandbox-test", authRequired, requirePermission("agents.manage"), async (req, res) => {
  const parsed = sandboxTestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const agent = await getAgentForUser(req.user!.id, String(req.params.id), isAdmin);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const resolved = await resolveEffectiveRules({
    agentId: agent.id,
    projectId: agent.project_id ?? undefined
  });

  const assignedTools = await all<AgentToolRow>("SELECT * FROM agent_tools WHERE agent_id = ? AND allowed = 1", [agent.id]);
  const forbiddenTools = parseRuleForbiddenTools(resolved.effectiveRules);

  const hardRuleViolations = assignedTools
    .filter((tool) => forbiddenTools.has(tool.tool_key))
    .map((tool) => `Tool ${tool.tool_key} is forbidden by hard rules`);

  const skills = await all<AgentSkillRow>("SELECT * FROM agent_skills WHERE agent_id = ? AND enabled = 1", [agent.id]);
  const skillValidationIssues: string[] = [];

  for (const assigned of skills) {
    const skill = await get<SkillCatalogRow>("SELECT id, name, version, input_schema, output_schema FROM skills_catalog WHERE id = ?", [
      assigned.skill_id
    ]);

    if (!skill) {
      skillValidationIssues.push(`Assigned skill ${assigned.skill_id} does not exist`);
      continue;
    }

    const tests = await all<SkillTestRow>(
      `
        SELECT id, name, input_payload, expected_output
        FROM skill_tests
        WHERE skill_id = ?
        ORDER BY created_at ASC
        LIMIT 5
      `,
      [skill.id]
    );

    const inputSchema = buildZodSchema(parseJsonSafe<SchemaDefinition>(skill.input_schema, { type: "object", properties: {} }));
    const outputSchema = buildZodSchema(parseJsonSafe<SchemaDefinition>(skill.output_schema, { type: "object", properties: {} }));

    for (const test of tests) {
      const inputData = parseJsonSafe<unknown>(test.input_payload, {});
      const expectedOutput = parseJsonSafe<unknown>(test.expected_output, {});

      const inputResult = inputSchema.safeParse(inputData);
      const outputResult = outputSchema.safeParse(expectedOutput);

      if (!inputResult.success) {
        skillValidationIssues.push(`Skill ${skill.name}@${skill.version} test ${test.name} has invalid input schema`);
      }

      if (!outputResult.success) {
        skillValidationIssues.push(`Skill ${skill.name}@${skill.version} test ${test.name} has invalid expected output schema`);
      }
    }
  }

  const outsideScopeCount = await get<{ count: number }>(
    `
      SELECT COUNT(*) as count
      FROM rag_memories
      WHERE agent_id = ? AND user_id <> ?
    `,
    [agent.id, agent.owner_user_id]
  );

  const issues = [...hardRuleViolations, ...skillValidationIssues];
  if ((outsideScopeCount?.count ?? 0) > 0) {
    issues.push("Agent memory scope violation detected");
  }

  if (!["private", "project", "public"].includes(agent.memory_scope)) {
    issues.push("Invalid memory scope configured");
  }

  const status = issues.length === 0 ? "passed" : "failed";
  const resultPayload = {
    status,
    checks: {
      hardRules: hardRuleViolations.length === 0,
      zodOutputs: skillValidationIssues.length === 0,
      memoryScope: (outsideScopeCount?.count ?? 0) === 0
    },
    issues,
    dryRunInput: parsed.data.dryRunInput ?? null
  };

  const testId = randomUUID();
  await run(
    `
      INSERT INTO agent_sandbox_tests (id, agent_id, user_id, status, result, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [testId, agent.id, req.user!.id, status, JSON.stringify(resultPayload), new Date().toISOString()]
  );

  await auditLog(req.user!.id, "agents.sandbox-test", {
    agentId: agent.id,
    testId,
    status,
    issuesCount: issues.length
  });

  res.json({
    testId,
    ...resultPayload
  });
});
