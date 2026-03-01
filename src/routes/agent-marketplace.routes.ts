import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { all, auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { requirePermission, requireRole } from "../middleware/authorization";
import { importAgentTemplateSchema, publishAgentTemplateSchema } from "../schemas/acs.schemas";
import { env } from "../config/env";
import { checkAgentSandboxGate } from "../services/sandbox-gate";
import { parseJsonSafe } from "../utils/json";

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
  status: string;
};

type AgentRuleRow = {
  level: string;
  title: string;
  content: string;
  enforcement: string;
  priority: number;
  active: number;
};

type AgentSkillRow = {
  skill_id: string;
  skill_version: string;
  config: string;
  enabled: number;
};

type AgentToolRow = {
  tool_key: string;
  allowed: number;
  config: string;
};

type TemplateRow = {
  id: string;
  creator_user_id: string;
  source_agent_id: string | null;
  name: string;
  description: string;
  tags: string;
  template_payload: string;
  status: string;
  template_key: string;
  version: number;
  parent_template_id: string | null;
  compatibility_min: string;
  compatibility_max: string | null;
  quality_score: number;
  quality_report: string;
  imports_count: number;
  created_at: string;
  updated_at: string;
  moderated_by: string | null;
  moderated_at: string | null;
  moderation_note: string | null;
  creator_name?: string;
};

type TemplatePayload = {
  profile: {
    name: string;
    role: string;
    detail: string | null;
    personality: string | null;
    lore: string | null;
    memoryScope: string;
  };
  rules: Array<{
    level: string;
    title: string;
    content: string;
    enforcement: string;
    priority: number;
    active: boolean;
  }>;
  skills: Array<{
    skillId: string;
    skillVersion: string;
    enabled: boolean;
    config: Record<string, unknown>;
  }>;
  tools: Array<{
    toolKey: string;
    allowed: boolean;
    config: Record<string, unknown>;
  }>;
  exportedAt: string;
};

const listTemplatesQuerySchema = z.object({
  templateKey: z.string().min(4).max(120).optional(),
  includeAllVersions: z.coerce.boolean().default(false)
});

const manageTemplatesQuerySchema = z.object({
  status: z.enum(["active", "deprecated", "incompatible", "rejected", "all"]).default("all"),
  templateKey: z.string().min(4).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(200_000).default(0)
});

const moderateTemplateSchema = z.object({
  action: z.enum(["approve", "reject", "deprecate", "mark-incompatible"]),
  note: z.string().trim().min(2).max(600).optional()
});

const deprecateTemplateSchema = z.object({
  note: z.string().trim().min(2).max(600).optional()
});

type SemanticVersion = {
  major: number;
  minor: number;
  patch: number;
};

function parseSemver(value: string): SemanticVersion | null {
  const normalized = value.trim().replace(/^v/i, "");
  const matched = normalized.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!matched) {
    return null;
  }

  return {
    major: Number(matched[1] ?? 0),
    minor: Number(matched[2] ?? 0),
    patch: Number(matched[3] ?? 0)
  };
}

function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a) ?? { major: 0, minor: 0, patch: 0 };
  const parsedB = parseSemver(b) ?? { major: 0, minor: 0, patch: 0 };

  if (parsedA.major !== parsedB.major) {
    return parsedA.major < parsedB.major ? -1 : 1;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor < parsedB.minor ? -1 : 1;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch < parsedB.patch ? -1 : 1;
  }

  return 0;
}

function isAppVersionCompatible(clientVersion: string, minVersion: string, maxVersion: string | null): boolean {
  if (compareSemver(clientVersion, minVersion) < 0) {
    return false;
  }
  if (maxVersion && compareSemver(clientVersion, maxVersion) > 0) {
    return false;
  }
  return true;
}

async function buildTemplatePayload(agent: AgentRow): Promise<TemplatePayload> {
  const rules = await all<AgentRuleRow>(
    `
      SELECT level, title, content, enforcement, priority, active
      FROM agent_rules
      WHERE agent_id = ?
      ORDER BY created_at ASC
    `,
    [agent.id]
  );

  const skills = await all<AgentSkillRow>(
    `
      SELECT skill_id, skill_version, config, enabled
      FROM agent_skills
      WHERE agent_id = ?
      ORDER BY created_at ASC
    `,
    [agent.id]
  );

  const tools = await all<AgentToolRow>(
    `
      SELECT tool_key, allowed, config
      FROM agent_tools
      WHERE agent_id = ?
      ORDER BY created_at ASC
    `,
    [agent.id]
  );

  return {
    profile: {
      name: agent.name,
      role: agent.role,
      detail: agent.detail,
      personality: agent.personality,
      lore: agent.lore,
      memoryScope: agent.memory_scope
    },
    rules: rules.map((rule) => ({
      level: rule.level,
      title: rule.title,
      content: rule.content,
      enforcement: rule.enforcement,
      priority: rule.priority,
      active: rule.active === 1
    })),
    skills: skills.map((skill) => ({
      skillId: skill.skill_id,
      skillVersion: skill.skill_version,
      enabled: skill.enabled === 1,
      config: parseJsonSafe<Record<string, unknown>>(skill.config, {})
    })),
    tools: tools.map((tool) => ({
      toolKey: tool.tool_key,
      allowed: tool.allowed === 1,
      config: parseJsonSafe<Record<string, unknown>>(tool.config, {})
    })),
    exportedAt: new Date().toISOString()
  };
}

function evaluateTemplateQuality(payload: TemplatePayload): { score: number; report: Record<string, unknown> } {
  let score = 20;
  const issues: string[] = [];

  if (payload.rules.length > 0) {
    score += 15;
  } else {
    issues.push("template has no rules");
  }

  if (payload.skills.length > 0) {
    score += 15;
  } else {
    issues.push("template has no skills");
  }

  if (payload.tools.length > 0) {
    score += 15;
  } else {
    issues.push("template has no tools");
  }

  if (payload.profile.detail && payload.profile.detail.trim().length >= 10) {
    score += 10;
  } else {
    issues.push("profile detail too short");
  }

  if (payload.profile.personality && payload.profile.personality.trim().length >= 10) {
    score += 10;
  } else {
    issues.push("profile personality too short");
  }

  if (payload.profile.lore && payload.profile.lore.trim().length >= 10) {
    score += 10;
  } else {
    issues.push("profile lore too short");
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    report: {
      issues,
      counts: {
        rules: payload.rules.length,
        skills: payload.skills.length,
        tools: payload.tools.length
      }
    }
  };
}

function mapTemplateSummary(row: TemplateRow): Record<string, unknown> {
  return {
    id: row.id,
    templateKey: row.template_key,
    version: row.version,
    parentTemplateId: row.parent_template_id,
    creatorUserId: row.creator_user_id,
    creatorUsername: row.creator_name,
    sourceAgentId: row.source_agent_id,
    name: row.name,
    description: row.description,
    tags: parseJsonSafe<string[]>(row.tags, []),
    status: row.status,
    compatibilityMin: row.compatibility_min,
    compatibilityMax: row.compatibility_max,
    qualityScore: row.quality_score,
    qualityReport: parseJsonSafe<Record<string, unknown>>(row.quality_report, {}),
    importsCount: row.imports_count,
    moderatedBy: row.moderated_by,
    moderatedAt: row.moderated_at,
    moderationNote: row.moderation_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const agentMarketplaceRouter = Router();

agentMarketplaceRouter.post(
  "/templates",
  authRequired,
  requireRole("approvedCreator"),
  requirePermission("publish.agent_template"),
  async (req, res) => {
    const parsed = publishAgentTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }

    const isAdmin = (req.user!.roles ?? []).includes("admin");
    const agent = isAdmin
      ? await get<AgentRow>("SELECT * FROM agents WHERE id = ?", [parsed.data.agentId])
      : await get<AgentRow>("SELECT * FROM agents WHERE id = ? AND owner_user_id = ?", [parsed.data.agentId, req.user!.id]);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const sandboxGate = await checkAgentSandboxGate(agent.id);
    if (!sandboxGate.ok) {
      res.status(409).json({
        error: "Agent sandbox verification required before publish",
        reason: sandboxGate.reason,
        agentId: agent.id,
        latestTestId: sandboxGate.latestTestId,
        testedAt: sandboxGate.testedAt,
        ageMinutes: sandboxGate.ageMinutes,
        action: "Run POST /api/agents/:id/sandbox-test and retry"
      });
      return;
    }

    const payload = await buildTemplatePayload(agent);
    const quality = evaluateTemplateQuality(payload);
    if (quality.score < env.TEMPLATE_QUALITY_MIN_SCORE) {
      res.status(422).json({
        error: "Template quality gate failed",
        minScore: env.TEMPLATE_QUALITY_MIN_SCORE,
        qualityScore: quality.score,
        qualityReport: quality.report
      });
      return;
    }

    const requestedTemplateKey = parsed.data.templateKey?.trim();
    let templateKey = requestedTemplateKey || randomUUID();
    let nextVersion = 1;
    let parentTemplateId: string | null = null;

    if (requestedTemplateKey) {
      const latest = await get<{ id: string; version: number; creator_user_id: string }>(
        `
          SELECT id, version, creator_user_id
          FROM agent_marketplace_templates
          WHERE template_key = ?
          ORDER BY version DESC
          LIMIT 1
        `,
        [requestedTemplateKey]
      );
      if (latest) {
        if (!isAdmin && latest.creator_user_id !== req.user!.id) {
          res.status(403).json({ error: "templateKey belongs to another creator" });
          return;
        }
        nextVersion = latest.version + 1;
        parentTemplateId = latest.id;
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const compatibilityMin = parsed.data.compatibilityMin?.trim() || env.MARKETPLACE_APP_VERSION;
    const compatibilityMax = parsed.data.compatibilityMax?.trim() ?? null;

    if (parseSemver(compatibilityMin) === null || (compatibilityMax && parseSemver(compatibilityMax) === null)) {
      res.status(400).json({ error: "Invalid compatibility version format" });
      return;
    }

    if (compatibilityMax && compareSemver(compatibilityMin, compatibilityMax) > 0) {
      res.status(400).json({ error: "compatibilityMin cannot be greater than compatibilityMax" });
      return;
    }

    await run(
      `
        INSERT INTO agent_marketplace_templates (
          id,
          creator_user_id,
          source_agent_id,
          name,
          description,
          tags,
          template_payload,
          status,
          template_key,
          version,
          parent_template_id,
          compatibility_min,
          compatibility_max,
          quality_score,
          quality_report,
          imports_count,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `,
      [
        id,
        req.user!.id,
        agent.id,
        parsed.data.name,
        parsed.data.description,
        JSON.stringify(parsed.data.tags),
        JSON.stringify(payload),
        templateKey,
        nextVersion,
        parentTemplateId,
        compatibilityMin,
        compatibilityMax,
        quality.score,
        JSON.stringify(quality.report),
        now,
        now
      ]
    );

    await auditLog(req.user!.id, "publish.agent-template", {
      templateId: id,
      templateKey,
      version: nextVersion,
      sourceAgentId: agent.id,
      qualityScore: quality.score
    });

    res.status(201).json({
      id,
      templateKey,
      version: nextVersion,
      status: "active",
      qualityScore: quality.score,
      importsCount: 0
    });
  }
);

agentMarketplaceRouter.get("/templates", async (req, res) => {
  const parsed = listTemplatesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const where: string[] = ["t.status = 'active'"];
  const params: Array<string | number> = [];
  if (parsed.data.templateKey) {
    where.push("t.template_key = ?");
    params.push(parsed.data.templateKey);
  }

  const rows = parsed.data.includeAllVersions
    ? await all<TemplateRow>(
        `
          SELECT
            t.id,
            t.creator_user_id,
            t.source_agent_id,
            t.name,
            t.description,
            t.tags,
            t.template_payload,
            t.status,
            t.template_key,
            t.version,
            t.parent_template_id,
            t.compatibility_min,
            t.compatibility_max,
            t.quality_score,
            t.quality_report,
            t.imports_count,
            t.created_at,
            t.updated_at,
            t.moderated_by,
            t.moderated_at,
            t.moderation_note,
            u.username AS creator_name
          FROM agent_marketplace_templates t
          INNER JOIN users u ON u.id = t.creator_user_id
          WHERE ${where.join(" AND ")}
          ORDER BY t.template_key ASC, t.version DESC
          LIMIT 500
        `,
        params
      )
    : await all<TemplateRow>(
        `
          WITH latest AS (
            SELECT template_key, MAX(version) AS latest_version
            FROM agent_marketplace_templates
            WHERE status = 'active'
            GROUP BY template_key
          )
          SELECT
            t.id,
            t.creator_user_id,
            t.source_agent_id,
            t.name,
            t.description,
            t.tags,
            t.template_payload,
            t.status,
            t.template_key,
            t.version,
            t.parent_template_id,
            t.compatibility_min,
            t.compatibility_max,
            t.quality_score,
            t.quality_report,
            t.imports_count,
            t.created_at,
            t.updated_at,
            t.moderated_by,
            t.moderated_at,
            t.moderation_note,
            u.username AS creator_name
          FROM agent_marketplace_templates t
          INNER JOIN latest l ON l.template_key = t.template_key AND l.latest_version = t.version
          INNER JOIN users u ON u.id = t.creator_user_id
          WHERE ${where.join(" AND ")}
          ORDER BY t.created_at DESC
          LIMIT 300
        `,
        params
      );

  res.json({
    items: rows.map(mapTemplateSummary)
  });
});

agentMarketplaceRouter.get(
  "/templates/manage",
  authRequired,
  requireRole("admin"),
  async (req, res) => {
    const parsed = manageTemplatesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
      return;
    }

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (parsed.data.status !== "all") {
      where.push("t.status = ?");
      params.push(parsed.data.status);
    }
    if (parsed.data.templateKey) {
      where.push("t.template_key = ?");
      params.push(parsed.data.templateKey);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await all<TemplateRow>(
      `
        SELECT
          t.id,
          t.creator_user_id,
          t.source_agent_id,
          t.name,
          t.description,
          t.tags,
          t.template_payload,
          t.status,
          t.template_key,
          t.version,
          t.parent_template_id,
          t.compatibility_min,
          t.compatibility_max,
          t.quality_score,
          t.quality_report,
          t.imports_count,
          t.created_at,
          t.updated_at,
          t.moderated_by,
          t.moderated_at,
          t.moderation_note,
          u.username AS creator_name
        FROM agent_marketplace_templates t
        INNER JOIN users u ON u.id = t.creator_user_id
        ${whereSql}
        ORDER BY t.updated_at DESC
        LIMIT ? OFFSET ?
      `,
      [...params, parsed.data.limit, parsed.data.offset]
    );

    await auditLog(req.user!.id, "agent-marketplace.templates.manage.read", {
      status: parsed.data.status,
      templateKey: parsed.data.templateKey ?? null,
      count: rows.length
    });

    res.json({
      items: rows.map(mapTemplateSummary),
      pagination: {
        limit: parsed.data.limit,
        offset: parsed.data.offset
      }
    });
  }
);

agentMarketplaceRouter.post("/templates/:id/import", authRequired, async (req, res) => {
  const parsed = importAgentTemplateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const templateId = String(req.params.id);
  const template = await get<TemplateRow>(
    `
      SELECT
        id, creator_user_id, source_agent_id, name, description, tags, template_payload, status,
        template_key, version, parent_template_id, compatibility_min, compatibility_max, quality_score, quality_report,
        imports_count, created_at, updated_at, moderated_by, moderated_at, moderation_note
      FROM agent_marketplace_templates
      WHERE id = ?
    `,
    [templateId]
  );

  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  if (template.status !== "active") {
    res.status(409).json({
      error: "Template is not importable",
      status: template.status
    });
    return;
  }

  const clientVersionRaw = req.header("x-client-app-version")?.trim();
  const clientVersion = clientVersionRaw && parseSemver(clientVersionRaw) ? clientVersionRaw : env.MARKETPLACE_APP_VERSION;
  if (!isAppVersionCompatible(clientVersion, template.compatibility_min, template.compatibility_max)) {
    res.status(409).json({
      error: "Template compatibility mismatch",
      templateId: template.id,
      clientVersion,
      compatibilityMin: template.compatibility_min,
      compatibilityMax: template.compatibility_max
    });
    return;
  }

  const payload = parseJsonSafe<TemplatePayload>(template.template_payload, {
    profile: {
      name: "Imported Agent",
      role: "assistant",
      detail: null,
      personality: null,
      lore: null,
      memoryScope: "private"
    },
    rules: [],
    skills: [],
    tools: [],
    exportedAt: new Date().toISOString()
  });

  const importedAgentId = randomUUID();
  const now = new Date().toISOString();
  const importedName = parsed.data.nameOverride ?? `${payload.profile.name} (imported)`;

  await run(
    `
      INSERT INTO agents (
        id, owner_user_id, project_id, name, role, detail, personality, lore, memory_scope,
        status, provider, model, created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'disconnected', NULL, NULL, ?, ?)
    `,
    [
      importedAgentId,
      req.user!.id,
      importedName,
      payload.profile.role,
      payload.profile.detail,
      payload.profile.personality,
      payload.profile.lore,
      payload.profile.memoryScope,
      now,
      now
    ]
  );

  for (const rule of payload.rules) {
    await run(
      `
        INSERT INTO agent_rules (
          id, agent_id, project_id, session_id, level, title, content, enforcement, priority, active, created_by, created_at, updated_at
        )
        VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        importedAgentId,
        rule.level === "session" ? "session" : "agent",
        rule.title,
        rule.content,
        rule.enforcement === "hard" ? "hard" : "soft",
        rule.priority,
        rule.active ? 1 : 0,
        req.user!.id,
        now,
        now
      ]
    );
  }

  for (const skill of payload.skills) {
    const existingSkill = await get<{ id: string }>("SELECT id FROM skills_catalog WHERE id = ?", [skill.skillId]);
    if (!existingSkill) {
      continue;
    }

    await run(
      `
        INSERT INTO agent_skills (id, agent_id, skill_id, skill_version, config, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [randomUUID(), importedAgentId, skill.skillId, skill.skillVersion, JSON.stringify(skill.config ?? {}), skill.enabled ? 1 : 0, now]
    );
  }

  for (const tool of payload.tools) {
    await run(
      `
        INSERT INTO agent_tools (id, agent_id, tool_key, allowed, config, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [randomUUID(), importedAgentId, tool.toolKey, tool.allowed ? 1 : 0, JSON.stringify(tool.config ?? {}), now, now]
    );
  }

  await run(
    `
      UPDATE agent_marketplace_templates
      SET imports_count = imports_count + 1,
          updated_at = ?
      WHERE id = ?
    `,
    [now, templateId]
  );

  await auditLog(req.user!.id, "agent-marketplace.import-template", {
    templateId,
    templateKey: template.template_key,
    templateVersion: template.version,
    importedAgentId
  });

  res.status(201).json({
    templateId,
    templateKey: template.template_key,
    templateVersion: template.version,
    agentId: importedAgentId,
    status: "disconnected"
  });
});

agentMarketplaceRouter.post(
  "/templates/:id/deprecate",
  authRequired,
  requireRole("approvedCreator"),
  requirePermission("publish.agent_template"),
  async (req, res) => {
    const parsed = deprecateTemplateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }

    const templateId = String(req.params.id);
    const isAdmin = (req.user!.roles ?? []).includes("admin");
    const template = isAdmin
      ? await get<TemplateRow>("SELECT * FROM agent_marketplace_templates WHERE id = ?", [templateId])
      : await get<TemplateRow>("SELECT * FROM agent_marketplace_templates WHERE id = ? AND creator_user_id = ?", [templateId, req.user!.id]);

    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const now = new Date().toISOString();
    await run(
      `
        UPDATE agent_marketplace_templates
        SET status = 'deprecated', moderated_by = ?, moderated_at = ?, moderation_note = ?, updated_at = ?
        WHERE id = ?
      `,
      [req.user!.id, now, parsed.data.note ?? "deprecated by creator", now, template.id]
    );

    await auditLog(req.user!.id, "agent-marketplace.template.deprecate", {
      templateId: template.id,
      templateKey: template.template_key,
      version: template.version
    });

    res.json({
      id: template.id,
      status: "deprecated"
    });
  }
);

agentMarketplaceRouter.post(
  "/templates/:id/moderate",
  authRequired,
  requireRole("admin"),
  async (req, res) => {
    const parsed = moderateTemplateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }

    const templateId = String(req.params.id);
    const template = await get<TemplateRow>("SELECT * FROM agent_marketplace_templates WHERE id = ?", [templateId]);
    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const nextStatus =
      parsed.data.action === "approve"
        ? "active"
        : parsed.data.action === "reject"
          ? "rejected"
          : parsed.data.action === "deprecate"
            ? "deprecated"
            : "incompatible";

    const now = new Date().toISOString();
    await run(
      `
        UPDATE agent_marketplace_templates
        SET status = ?, moderated_by = ?, moderated_at = ?, moderation_note = ?, updated_at = ?
        WHERE id = ?
      `,
      [nextStatus, req.user!.id, now, parsed.data.note ?? null, now, template.id]
    );

    await auditLog(req.user!.id, "agent-marketplace.template.moderate", {
      templateId: template.id,
      fromStatus: template.status,
      toStatus: nextStatus,
      action: parsed.data.action
    });

    res.json({
      id: template.id,
      status: nextStatus
    });
  }
);
