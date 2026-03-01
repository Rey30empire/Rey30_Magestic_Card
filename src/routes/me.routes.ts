import { Router } from "express";
import { z } from "zod";
import { auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { sensitiveRateLimit } from "../middleware/rate-limit";
import { env } from "../config/env";
import { recordAbuseRiskEvent } from "../services/abuse-detection";
import { requestLlmCompletion, resolveAndValidateLlmEndpoint } from "../services/llm";
import { hydrateUserAccess } from "../services/rbac";
import { getVaultMetadata, resolveVaultSecret, storeVaultSecret } from "../services/vault";

type UserRow = {
  id: string;
  username: string;
  role: string;
  creative_points: number;
  elo: number;
};

type UserAiConfigRow = {
  user_id: string;
  provider: string;
  model: string;
  endpoint: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  permissions_json: string | null;
  keys_ref: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type CountRow = {
  count: number;
};

type CreatorApplicationStatusRow = {
  status: string;
};

type AiPermissionKey =
  | "readScene"
  | "createGeometry"
  | "editGeometry"
  | "materials"
  | "booleans"
  | "templates"
  | "delete"
  | "cards"
  | "agents"
  | "skills"
  | "grid"
  | "export";

type AiPermissions = Record<AiPermissionKey, boolean>;

const DEFAULT_AI_PROVIDER = "openai-compatible";
const DEFAULT_AI_MODEL = "gpt-4.1-mini";
const DEFAULT_AI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_AI_SYSTEM_PROMPT = [
  "You are ReyCAD Assistant.",
  "Always return JSON only.",
  "When asked to model, respond with an array of tool calls.",
  "Do not invent node ids; request get_scene before edits if needed.",
  "Avoid destructive actions unless explicitly requested."
].join("\n");
const MAX_PLAN_SCENE_CHARS = 16_000;

const AI_PERMISSION_KEYS: AiPermissionKey[] = [
  "readScene",
  "createGeometry",
  "editGeometry",
  "materials",
  "booleans",
  "templates",
  "delete",
  "cards",
  "agents",
  "skills",
  "grid",
  "export"
];
const sensitiveAiConfigLimiter = sensitiveRateLimit({
  windowMs: env.SENSITIVE_RATE_LIMIT_WINDOW_MS,
  maxPerUser: env.SENSITIVE_RATE_LIMIT_MAX_PER_USER,
  maxPerToken: env.SENSITIVE_RATE_LIMIT_MAX_PER_TOKEN,
  maxBuckets: env.SENSITIVE_RATE_LIMIT_MAX_BUCKETS
});

function defaultAiPermissions(): AiPermissions {
  return {
    readScene: false,
    createGeometry: false,
    editGeometry: false,
    materials: false,
    booleans: false,
    templates: false,
    delete: false,
    cards: false,
    agents: false,
    skills: false,
    grid: false,
    export: false
  };
}

const TOOL_PERMISSION_REQUIREMENTS: Record<string, AiPermissionKey[]> = {
  get_scene: ["readScene"],
  list_assets: ["readScene"],
  create_primitive: ["createGeometry"],
  set_transform: ["editGeometry"],
  set_params: ["editGeometry"],
  group: ["editGeometry"],
  duplicate: ["editGeometry"],
  toggle_hole: ["booleans"],
  add_boolean: ["booleans"],
  assign_material: ["materials"],
  assign_material_batch: ["materials"],
  create_material: ["materials"],
  create_material_batch: ["materials"],
  update_material: ["materials"],
  update_material_batch: ["materials"],
  insert_template: ["templates"],
  delete_nodes: ["delete"],
  create_card_draft: ["cards"],
  create_agent: ["agents"],
  assign_agent_tools: ["agents"],
  assign_agent_skills: ["skills"],
  frame: ["grid"],
  set_grid: ["grid"],
  export_stl: ["export"],
  export_glb: ["export"]
};

const aiPermissionsSchema = z
  .object({
    readScene: z.boolean(),
    createGeometry: z.boolean(),
    editGeometry: z.boolean(),
    materials: z.boolean(),
    booleans: z.boolean(),
    templates: z.boolean(),
    delete: z.boolean(),
    cards: z.boolean(),
    agents: z.boolean(),
    skills: z.boolean(),
    grid: z.boolean(),
    export: z.boolean()
  })
  .strict();

const aiPermissionsPatchSchema = aiPermissionsSchema.partial();

const aiConfigSchema = z.object({
  provider: z.string().trim().min(2).max(64),
  model: z.string().trim().min(1).max(120),
  endpoint: z.string().trim().url().max(320).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(4096).optional(),
  systemPrompt: z.string().trim().min(10).max(6000).optional(),
  permissions: aiPermissionsPatchSchema.optional(),
  enabled: z.boolean().optional(),
  apiKey: z.string().trim().min(10).max(500).optional(),
  keysRef: z.string().uuid().optional(),
  clearApiKey: z.boolean().optional()
});

const aiConfigTestSchema = z.object({
  prompt: z.string().trim().min(1).max(1200).optional()
});

const aiToolPlanSchema = z.object({
  prompt: z.string().trim().min(2).max(2400),
  scene: z.unknown().optional(),
  permissions: aiPermissionsPatchSchema.optional()
});

const aiPermissionsSaveSchema = z.object({
  permissions: aiPermissionsPatchSchema
});

const aiToolCallSchema = z.object({
  tool: z.enum([
    "get_scene",
    "list_assets",
    "create_card_draft",
    "create_material",
    "update_material",
    "create_material_batch",
    "update_material_batch",
    "create_agent",
    "assign_agent_tools",
    "assign_agent_skills",
    "set_transform",
    "set_params",
    "group",
    "toggle_hole",
    "assign_material",
    "assign_material_batch",
    "insert_template",
    "delete_nodes",
    "duplicate",
    "add_boolean",
    "frame",
    "set_grid",
    "create_primitive",
    "export_stl",
    "export_glb"
  ]),
  args: z.record(z.string(), z.unknown())
});

const aiToolCallsSchema = z.array(aiToolCallSchema).min(1).max(80);

const aiPolicyEventSchema = z.object({
  event: z.enum(["blocked_tool", "blocked_remote_plan"]),
  tool: z.string().trim().min(2).max(80),
  reason: z.string().trim().min(2).max(240),
  source: z.enum(["editor", "remote-plan", "unknown"]).default("unknown")
});

const acsHomeQuerySchema = z.object({
  includeCounts: z.preprocess((value) => {
    if (value === undefined) {
      return true;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no"].includes(normalized)) {
        return false;
      }
    }
    return value;
  }, z.boolean())
});

const aiToolArgsSchemas: Record<string, z.ZodTypeAny> = {
  create_material: z.object({
    kind: z.enum(["solidColor", "pbr"]),
    name: z.string().trim().min(1).max(80).optional(),
    color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    pbr: z
      .object({
        metalness: z.number().min(0).max(1).optional(),
        roughness: z.number().min(0).max(1).optional(),
        baseColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional()
      })
      .optional()
  }),
  update_material: z.object({
    materialId: z.string().trim().min(2).max(120),
    patch: z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        pbr: z
          .object({
            metalness: z.number().min(0).max(1).optional(),
            roughness: z.number().min(0).max(1).optional(),
            baseColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional()
          })
          .optional()
      })
      .refine((value) => Object.keys(value).length > 0, "patch requires at least one field")
  }),
  create_material_batch: z.object({
    materials: z
      .array(
        z.object({
          kind: z.enum(["solidColor", "pbr"]),
          name: z.string().trim().min(1).max(80).optional(),
          color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          pbr: z
            .object({
              metalness: z.number().min(0).max(1).optional(),
              roughness: z.number().min(0).max(1).optional(),
              baseColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional()
            })
            .optional()
        })
      )
      .min(1)
      .max(80)
  }),
  update_material_batch: z.object({
    updates: z
      .array(
        z.object({
          materialId: z.string().trim().min(2).max(120),
          patch: z
            .object({
              name: z.string().trim().min(1).max(80).optional(),
              color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
              pbr: z
                .object({
                  metalness: z.number().min(0).max(1).optional(),
                  roughness: z.number().min(0).max(1).optional(),
                  baseColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional()
                })
                .optional()
            })
            .refine((value) => Object.keys(value).length > 0, "patch requires at least one field")
        })
      )
      .min(1)
      .max(80)
  }),
  assign_material_batch: z.object({
    materialId: z.string().trim().min(2).max(120),
    nodeIds: z.array(z.string().trim().min(2).max(120)).min(1).max(200)
  }),
  create_agent: z.object({
    name: z.string().trim().min(2).max(80),
    role: z.string().trim().min(2).max(60),
    detail: z.string().trim().min(2).max(400).optional(),
    personality: z.string().trim().min(2).max(1200).optional(),
    lore: z.string().trim().min(2).max(2400).optional(),
    memoryScope: z.enum(["private", "project", "public"]).optional()
  }),
  assign_agent_tools: z.object({
    agentId: z.string().uuid(),
    updates: z
      .array(
        z.object({
          toolKey: z.string().trim().min(3).max(120),
          allowed: z.boolean(),
          config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
        })
      )
      .min(1)
      .max(50)
  }),
  assign_agent_skills: z.object({
    agentId: z.string().uuid(),
    updates: z
      .array(
        z.object({
          skillId: z.string().uuid(),
          enabled: z.boolean().optional(),
          remove: z.boolean().optional(),
          config: z.record(z.string(), z.unknown()).optional()
        })
      )
      .min(1)
      .max(50)
  }),
  export_stl: z.object({
    selectionIds: z.array(z.string().trim().min(2).max(120)).max(200).optional(),
    filename: z.string().trim().min(1).max(120).optional()
  }),
  export_glb: z.object({
    selectionIds: z.array(z.string().trim().min(2).max(120)).max(200).optional(),
    filename: z.string().trim().min(1).max(120).optional()
  })
};

function validateNewToolArgs(toolCalls: Array<{ tool: string; args: Record<string, unknown> }>): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const [index, call] of toolCalls.entries()) {
    const schema = aiToolArgsSchemas[call.tool];
    if (!schema) {
      continue;
    }

    const result = schema.safeParse(call.args);
    if (!result.success) {
      errors.push(`tool[${index}] ${call.tool}: invalid args`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}

function parseAiPermissions(raw: string | null | undefined): AiPermissions {
  const base = defaultAiPermissions();
  if (!raw || raw.trim().length === 0) {
    return base;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of AI_PERMISSION_KEYS) {
      if (typeof parsed[key] === "boolean") {
        base[key] = parsed[key];
      }
    }
    return base;
  } catch {
    return base;
  }
}

function hasPermission(permissions: Set<string>, key: string): boolean {
  return permissions.has(key);
}

function hasAnyPermission(permissions: Set<string>, keys: string[]): boolean {
  return keys.some((key) => permissions.has(key));
}

function hasRole(roles: Set<string>, role: string): boolean {
  return roles.has(role);
}

function trainingModesByPlatform(platform: string): Array<Record<string, unknown>> {
  const isDesktop = platform === "desktop";
  return [
    {
      mode: "profile-tuning",
      allowed: true,
      requiredPlatform: null
    },
    {
      mode: "fine-tuning",
      allowed: isDesktop,
      requiredPlatform: "desktop"
    },
    {
      mode: "lora",
      allowed: isDesktop,
      requiredPlatform: "desktop"
    },
    {
      mode: "adapter",
      allowed: isDesktop,
      requiredPlatform: "desktop"
    }
  ];
}

async function collectAcsHomeCounts(userId: string, isAdmin: boolean): Promise<Record<string, number>> {
  const [
    projects,
    agents,
    memory,
    trainingTotal,
    trainingActive,
    templatesOwned,
    templatesActive,
    skillsVisible,
    toolAssignments,
    sandboxRuns
  ] = await Promise.all([
    get<CountRow>("SELECT COUNT(*) as count FROM projects WHERE owner_user_id = ? AND status = 'active'", [userId]),
    get<CountRow>("SELECT COUNT(*) as count FROM agents WHERE owner_user_id = ?", [userId]),
    get<CountRow>("SELECT COUNT(*) as count FROM rag_memories WHERE user_id = ?", [userId]),
    get<CountRow>("SELECT COUNT(*) as count FROM training_jobs WHERE user_id = ?", [userId]),
    get<CountRow>("SELECT COUNT(*) as count FROM training_jobs WHERE user_id = ? AND status IN ('queued', 'running')", [userId]),
    get<CountRow>("SELECT COUNT(*) as count FROM agent_marketplace_templates WHERE creator_user_id = ?", [userId]),
    get<CountRow>("SELECT COUNT(*) as count FROM agent_marketplace_templates WHERE creator_user_id = ? AND status = 'active'", [userId]),
    isAdmin
      ? get<CountRow>("SELECT COUNT(*) as count FROM skills_catalog")
      : get<CountRow>("SELECT COUNT(*) as count FROM skills_catalog WHERE created_by = ?", [userId]),
    get<CountRow>(
      `
        SELECT COUNT(*) as count
        FROM agent_tools t
        INNER JOIN agents a ON a.id = t.agent_id
        WHERE a.owner_user_id = ?
      `,
      [userId]
    ),
    get<CountRow>(
      `
        SELECT COUNT(*) as count
        FROM agent_sandbox_tests t
        INNER JOIN agents a ON a.id = t.agent_id
        WHERE a.owner_user_id = ?
      `,
      [userId]
    )
  ]);

  return {
    projects: projects?.count ?? 0,
    agents: agents?.count ?? 0,
    memoryEntries: memory?.count ?? 0,
    trainingJobsTotal: trainingTotal?.count ?? 0,
    trainingJobsActive: trainingActive?.count ?? 0,
    templatesOwned: templatesOwned?.count ?? 0,
    templatesActive: templatesActive?.count ?? 0,
    skillsVisible: skillsVisible?.count ?? 0,
    toolAssignments: toolAssignments?.count ?? 0,
    sandboxRuns: sandboxRuns?.count ?? 0
  };
}

function buildAcsModules(input: {
  roles: Set<string>;
  permissions: Set<string>;
  platform: string;
}): Array<Record<string, unknown>> {
  const { roles, permissions, platform } = input;
  const isDesktop = platform === "desktop";
  const isAdmin = roles.has("admin");
  const isApprovedCreator = roles.has("approvedCreator") || isAdmin;

  const rulesManage = hasAnyPermission(permissions, ["rules.manage.agent", "rules.manage.project", "rules.manage.global"]) || isAdmin;
  const skillsCatalog = hasAnyPermission(permissions, ["skills.create", "skills.tests.run"]) || isAdmin;
  const toolsManage = hasAnyPermission(permissions, ["agents.tools.assign", "dev_tools.access"]) || isAdmin;

  return [
    {
      key: "acsHome",
      title: "ACS Home",
      available: true,
      reason: null
    },
    {
      key: "agentEditor",
      title: "Agent Editor",
      available: hasPermission(permissions, "agents.manage") || isAdmin,
      reason: hasPermission(permissions, "agents.manage") || isAdmin ? null : "Missing permission: agents.manage"
    },
    {
      key: "connection",
      title: "Connection",
      available: hasPermission(permissions, "agents.connect") || isAdmin,
      reason: hasPermission(permissions, "agents.connect") || isAdmin ? null : "Missing permission: agents.connect"
    },
    {
      key: "rulesConsole",
      title: "Rules Console",
      available: rulesManage,
      reason: rulesManage ? null : "Missing permission: rules.manage.*"
    },
    {
      key: "skillsCatalog",
      title: "Skills Catalog",
      available: skillsCatalog,
      reason: skillsCatalog ? null : "Missing permission: skills.create or skills.tests.run"
    },
    {
      key: "tools",
      title: "Tools",
      available: toolsManage,
      reason: toolsManage ? null : "Missing permission: agents.tools.assign or dev_tools.access"
    },
    {
      key: "memory",
      title: "Memory",
      available: hasPermission(permissions, "memory.manage") || isAdmin,
      reason: hasPermission(permissions, "memory.manage") || isAdmin ? null : "Missing permission: memory.manage"
    },
    {
      key: "training",
      title: "Training",
      available: hasPermission(permissions, "training.create") || isAdmin,
      reason: hasPermission(permissions, "training.create") || isAdmin ? (isDesktop ? null : "Desktop required for fine-tuning/lora/adapter") : "Missing permission: training.create"
    },
    {
      key: "sandbox",
      title: "Sandbox",
      available: hasPermission(permissions, "agents.manage") || isAdmin,
      reason: hasPermission(permissions, "agents.manage") || isAdmin ? null : "Missing permission: agents.manage"
    },
    {
      key: "marketplace",
      title: "Marketplace",
      available: true,
      reason: null,
      actions: {
        publishTemplate: isApprovedCreator && (hasPermission(permissions, "publish.agent_template") || isAdmin),
        importTemplate: true,
        moderateTemplates: isAdmin
      }
    }
  ];
}

function mergeAiPermissions(base: AiPermissions, patch: Partial<AiPermissions> | undefined): AiPermissions {
  const next = { ...base };
  if (!patch) {
    return next;
  }

  for (const key of AI_PERMISSION_KEYS) {
    const value = patch[key];
    if (typeof value === "boolean") {
      next[key] = value;
    }
  }
  return next;
}

function listAllowedTools(permissions: AiPermissions): string[] {
  const allowed: string[] = [];
  for (const [tool, required] of Object.entries(TOOL_PERMISSION_REQUIREMENTS)) {
    if (required.every((key) => permissions[key])) {
      allowed.push(tool);
    }
  }
  return allowed.sort();
}

function countEnabledPermissions(permissions: AiPermissions): number {
  return AI_PERMISSION_KEYS.filter((key) => permissions[key]).length;
}

function safeSceneSnapshot(scene: unknown): string {
  if (scene === undefined) {
    return "not provided";
  }
  try {
    return JSON.stringify(scene).slice(0, MAX_PLAN_SCENE_CHARS);
  } catch {
    return "unserializable";
  }
}

function parseJsonToolCalls(rawText: string): unknown {
  const text = rawText.trim();
  if (text.length === 0) {
    throw new Error("Empty model response");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Try fenced JSON.
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return JSON.parse(fencedMatch[1]) as unknown;
  }

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return JSON.parse(text.slice(arrayStart, arrayEnd + 1)) as unknown;
  }

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return JSON.parse(text.slice(objectStart, objectEnd + 1)) as unknown;
  }

  throw new Error("No JSON payload found");
}

async function getUserAiConfig(userId: string): Promise<UserAiConfigRow | undefined> {
  return get<UserAiConfigRow>("SELECT * FROM user_ai_configs WHERE user_id = ?", [userId]);
}

function mapAiConfigResponse(row: UserAiConfigRow | undefined, hasApiKey: boolean, keysLabel?: string | null): Record<string, unknown> {
  if (!row) {
    return {
      configured: false,
      enabled: false,
      provider: DEFAULT_AI_PROVIDER,
      model: DEFAULT_AI_MODEL,
      endpoint: DEFAULT_AI_ENDPOINT,
      temperature: 0.2,
      maxTokens: 600,
      systemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
      permissions: defaultAiPermissions(),
      hasApiKey: false,
      keysRef: null,
      keysLabel: null
    };
  }

  const permissions = parseAiPermissions(row.permissions_json);
  return {
    configured: true,
    enabled: row.enabled === 1,
    provider: row.provider,
    model: row.model,
    endpoint: row.endpoint,
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    systemPrompt: row.system_prompt,
    permissions,
    hasApiKey,
    keysRef: row.keys_ref,
    keysLabel: keysLabel ?? null,
    updatedAt: row.updated_at
  };
}

export const meRouter = Router();

meRouter.get("/", authRequired, async (req, res) => {
  const user = await get<UserRow>("SELECT id, username, role, creative_points, elo FROM users WHERE id = ?", [req.user!.id]);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const access = await hydrateUserAccess(user.id, user.role);

  res.json({
    id: user.id,
    username: user.username,
    role: access.primaryRole,
    roles: access.roles,
    permissions: access.permissions,
    creativePoints: user.creative_points,
    elo: user.elo,
    platform: req.clientPlatform ?? "web"
  });
});

meRouter.get("/acs-home", authRequired, async (req, res) => {
  const parsed = acsHomeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const user = await get<UserRow>("SELECT id, username, role, creative_points, elo FROM users WHERE id = ?", [req.user!.id]);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const access = await hydrateUserAccess(user.id, user.role);
  const roles = new Set<string>(access.roles);
  const permissions = new Set<string>(access.permissions);
  const platform = req.clientPlatform ?? "web";
  const isAdmin = roles.has("admin");
  const creatorApplication = await get<CreatorApplicationStatusRow>(
    "SELECT status FROM creator_applications WHERE user_id = ? LIMIT 1",
    [user.id]
  );

  const response: Record<string, unknown> = {
    user: {
      id: user.id,
      username: user.username,
      primaryRole: access.primaryRole,
      roles: access.roles,
      permissions: access.permissions
    },
    platform,
    creator: {
      isApprovedCreator: roles.has("approvedCreator") || isAdmin,
      applicationStatus: creatorApplication?.status ?? null
    },
    modules: buildAcsModules({
      roles,
      permissions,
      platform
    }),
    trainingModes: trainingModesByPlatform(platform)
  };

  if (parsed.data.includeCounts) {
    response.counts = await collectAcsHomeCounts(user.id, isAdmin);
  }

  await auditLog(req.user!.id, "me.acs-home.read", {
    platform,
    includeCounts: parsed.data.includeCounts
  });

  res.json(response);
});

meRouter.get("/ai-config", authRequired, async (req, res) => {
  const row = await getUserAiConfig(req.user!.id);
  if (!row) {
    res.json(mapAiConfigResponse(undefined, false, null));
    return;
  }

  let metadata: { keysRef: string; label: string } | null = null;
  if (row.keys_ref) {
    metadata = await getVaultMetadata(req.user!.id, row.keys_ref);
  }

  res.json(mapAiConfigResponse(row, Boolean(metadata), metadata?.label ?? null));
});

meRouter.put("/ai-config", authRequired, sensitiveAiConfigLimiter, async (req, res) => {
  const parsed = aiConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const now = new Date().toISOString();
  const current = await getUserAiConfig(req.user!.id);
  const provider = parsed.data.provider.trim();
  const model = parsed.data.model.trim();
  const endpointCandidate = parsed.data.endpoint ?? current?.endpoint ?? DEFAULT_AI_ENDPOINT;
  let endpoint: string;
  try {
    endpoint = (await resolveAndValidateLlmEndpoint(provider, endpointCandidate)).endpoint;
  } catch (error) {
    res.status(400).json({
      error: "Invalid or blocked endpoint",
      details: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  const temperature = parsed.data.temperature ?? current?.temperature ?? 0.2;
  const maxTokens = parsed.data.maxTokens ?? current?.max_tokens ?? 600;
  const systemPrompt = parsed.data.systemPrompt ?? current?.system_prompt ?? DEFAULT_AI_SYSTEM_PROMPT;
  const enabled = parsed.data.enabled ?? current?.enabled === 1;
  const basePermissions = parseAiPermissions(current?.permissions_json);
  const nextPermissions = mergeAiPermissions(basePermissions, parsed.data.permissions);

  let keysRef: string | null = current?.keys_ref ?? null;

  if (parsed.data.clearApiKey) {
    keysRef = null;
  }

  if (parsed.data.keysRef) {
    const metadata = await getVaultMetadata(req.user!.id, parsed.data.keysRef);
    if (!metadata) {
      res.status(404).json({ error: "keysRef not found in vault" });
      return;
    }
    keysRef = metadata.keysRef;
  }

  if (parsed.data.apiKey) {
    const stored = await storeVaultSecret(req.user!.id, `llm:${provider}:${model}`, parsed.data.apiKey);
    keysRef = stored.keysRef;
  }

  if (enabled && !keysRef) {
    res.status(400).json({ error: "API key is required to enable AI config" });
    return;
  }

  await run(
    `
      INSERT INTO user_ai_configs (
        user_id, provider, model, endpoint, system_prompt, temperature, max_tokens, permissions_json, keys_ref, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        endpoint = excluded.endpoint,
        system_prompt = excluded.system_prompt,
        temperature = excluded.temperature,
        max_tokens = excluded.max_tokens,
        permissions_json = excluded.permissions_json,
        keys_ref = excluded.keys_ref,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `,
    [
      req.user!.id,
      provider,
      model,
      endpoint,
      systemPrompt,
      temperature,
      maxTokens,
      JSON.stringify(nextPermissions),
      keysRef,
      enabled ? 1 : 0,
      current?.created_at ?? now,
      now
    ]
  );

  await auditLog(req.user!.id, "me.ai-config.upsert", {
    provider,
    model,
    endpoint,
    enabled,
    hasApiKey: Boolean(keysRef),
    enabledPermissions: countEnabledPermissions(nextPermissions)
  });

  const updated = await getUserAiConfig(req.user!.id);
  const metadata = updated?.keys_ref ? await getVaultMetadata(req.user!.id, updated.keys_ref) : null;
  res.json(mapAiConfigResponse(updated, Boolean(metadata), metadata?.label ?? null));
});

meRouter.put("/ai-config/permissions", authRequired, sensitiveAiConfigLimiter, async (req, res) => {
  const parsed = aiPermissionsSaveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const now = new Date().toISOString();
  const current = await getUserAiConfig(req.user!.id);
  const nextPermissions = mergeAiPermissions(parseAiPermissions(current?.permissions_json), parsed.data.permissions);

  await run(
    `
      INSERT INTO user_ai_configs (
        user_id, provider, model, endpoint, system_prompt, temperature, max_tokens, permissions_json, keys_ref, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        permissions_json = excluded.permissions_json,
        updated_at = excluded.updated_at
    `,
    [
      req.user!.id,
      current?.provider ?? DEFAULT_AI_PROVIDER,
      current?.model ?? DEFAULT_AI_MODEL,
      current?.endpoint ?? DEFAULT_AI_ENDPOINT,
      current?.system_prompt ?? DEFAULT_AI_SYSTEM_PROMPT,
      current?.temperature ?? 0.2,
      current?.max_tokens ?? 600,
      JSON.stringify(nextPermissions),
      current?.keys_ref ?? null,
      current?.enabled ?? 0,
      current?.created_at ?? now,
      now
    ]
  );

  await auditLog(req.user!.id, "me.ai-config.permissions", {
    enabledPermissions: countEnabledPermissions(nextPermissions)
  });

  const updated = await getUserAiConfig(req.user!.id);
  const metadata = updated?.keys_ref ? await getVaultMetadata(req.user!.id, updated.keys_ref) : null;
  res.json(mapAiConfigResponse(updated, Boolean(metadata), metadata?.label ?? null));
});

meRouter.post("/ai-config/policy-events", authRequired, async (req, res) => {
  const parsed = aiPolicyEventSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  await auditLog(req.user!.id, "me.ai-config.policy-event", {
    event: parsed.data.event,
    tool: parsed.data.tool,
    reason: parsed.data.reason,
    source: parsed.data.source
  });

  if (parsed.data.event === "blocked_tool" || parsed.data.event === "blocked_remote_plan") {
    void recordAbuseRiskEvent({
      userId: req.user!.id,
      source: "ai-config",
      eventKey: "ai-config.policy-blocked-tool",
      metadata: {
        event: parsed.data.event,
        tool: parsed.data.tool,
        reason: parsed.data.reason,
        source: parsed.data.source
      },
      requestId: req.requestId ?? null,
      traceId: req.traceId ?? null
    }).catch((error) => {
      console.error("[abuse-risk] failed to record ai policy event", error);
    });
  }

  res.json({ ok: true });
});

meRouter.post("/ai-config/test", authRequired, sensitiveAiConfigLimiter, async (req, res) => {
  const parsed = aiConfigTestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const row = await getUserAiConfig(req.user!.id);
  if (!row || row.enabled !== 1) {
    res.status(409).json({ error: "AI config is not enabled" });
    return;
  }

  if (!row.keys_ref) {
    res.status(409).json({ error: "AI config does not have API key" });
    return;
  }

  const apiKey = await resolveVaultSecret(req.user!.id, row.keys_ref);
  if (!apiKey) {
    res.status(404).json({ error: "API key not found in vault" });
    return;
  }

  const startedAt = Date.now();

  try {
    const result = await requestLlmCompletion({
      provider: row.provider,
      model: row.model,
      endpoint: row.endpoint,
      apiKey,
      temperature: row.temperature,
      maxTokens: row.max_tokens,
      messages: [
        {
          role: "system",
          content: row.system_prompt
        },
        {
          role: "user",
          content: parsed.data.prompt ?? "Respond with the single word READY"
        }
      ]
    });

    const durationMs = Date.now() - startedAt;
    await auditLog(req.user!.id, "me.ai-config.test", {
      provider: row.provider,
      model: row.model,
      endpoint: row.endpoint,
      durationMs
    });

    res.json({
      ok: true,
      provider: result.provider,
      model: result.model,
      endpoint: result.endpoint,
      durationMs,
      output: result.text
    });
  } catch (error) {
    res.status(502).json({
      error: "Provider test failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

meRouter.post("/ai-config/tool-plan", authRequired, sensitiveAiConfigLimiter, async (req, res) => {
  const parsed = aiToolPlanSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const row = await getUserAiConfig(req.user!.id);
  if (!row || row.enabled !== 1) {
    res.status(409).json({ error: "AI config is not enabled" });
    return;
  }

  if (!row.keys_ref) {
    res.status(409).json({ error: "AI config does not have API key" });
    return;
  }

  const apiKey = await resolveVaultSecret(req.user!.id, row.keys_ref);
  if (!apiKey) {
    res.status(404).json({ error: "API key not found in vault" });
    return;
  }

  const mergedPermissions = mergeAiPermissions(parseAiPermissions(row.permissions_json), parsed.data.permissions);
  const allowedTools = listAllowedTools(mergedPermissions);
  if (allowedTools.length === 0) {
    res.status(409).json({ error: "No AI tools allowed. Enable permissions first.", permissions: mergedPermissions });
    return;
  }

  const instruction = [
    row.system_prompt,
    "",
    "Output contract:",
    "- Return JSON only (no markdown).",
    '- Return an array of tool calls: [{"tool":"name","args":{...}}].',
    `- Allowed tools: ${allowedTools.join(", ")}.`,
    "- Never include comments."
  ].join("\n");

  try {
    const llm = await requestLlmCompletion({
      provider: row.provider,
      model: row.model,
      endpoint: row.endpoint,
      apiKey,
      temperature: row.temperature,
      maxTokens: row.max_tokens,
      messages: [
        {
          role: "system",
          content: instruction
        },
        {
          role: "user",
          content: `User prompt:\n${parsed.data.prompt}\n\nScene snapshot:\n${safeSceneSnapshot(parsed.data.scene)}`
        }
      ]
    });

    const payload = parseJsonToolCalls(llm.text);
    const normalized = Array.isArray(payload) ? payload : [payload];
    const valid = aiToolCallsSchema.safeParse(normalized);
    if (!valid.success) {
      res.status(422).json({
        error: "LLM returned invalid tool call payload",
        details: valid.error.flatten(),
        raw: llm.text
      });
      return;
    }

    const strictValidation = validateNewToolArgs(valid.data);
    if (!strictValidation.ok) {
      await auditLog(req.user!.id, "me.ai-config.tool-plan.invalid-args", {
        provider: row.provider,
        model: row.model,
        errors: strictValidation.errors
      });
      res.status(422).json({
        error: "LLM returned invalid args for restricted tools",
        details: strictValidation.errors,
        raw: llm.text
      });
      return;
    }

    const allowedSet = new Set(allowedTools);
    const disallowedCalls = valid.data.filter((call) => !allowedSet.has(call.tool));
    if (disallowedCalls.length > 0) {
      void recordAbuseRiskEvent({
        userId: req.user!.id,
        source: "ai-config",
        eventKey: "ai-config.policy-blocked-tool",
        metadata: {
          disallowedTools: disallowedCalls.map((call) => call.tool),
          allowedTools
        },
        requestId: req.requestId ?? null,
        traceId: req.traceId ?? null
      }).catch((error) => {
        console.error("[abuse-risk] failed to record disallowed tool-plan event", error);
      });

      await auditLog(req.user!.id, "me.ai-config.tool-plan.policy-block", {
        provider: row.provider,
        model: row.model,
        disallowedTools: disallowedCalls.map((call) => call.tool),
        allowedTools
      });
      res.status(422).json({
        error: "LLM returned tools blocked by permission policy",
        disallowedTools: disallowedCalls.map((call) => call.tool),
        allowedTools,
        raw: llm.text
      });
      return;
    }

    await auditLog(req.user!.id, "me.ai-config.tool-plan", {
      provider: row.provider,
      model: row.model,
      toolCalls: valid.data.length,
      enabledPermissions: countEnabledPermissions(mergedPermissions)
    });

    res.json({
      toolCalls: valid.data,
      permissions: mergedPermissions,
      raw: llm.text
    });
  } catch (error) {
    res.status(502).json({
      error: "Tool plan generation failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});
