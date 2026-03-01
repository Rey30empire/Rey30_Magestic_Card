import { z } from "zod";
import { schemaDefinitionSchema } from "./schema-definition";

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const creatorApplySchema = z.object({
  message: z.string().min(10).max(600).optional()
});

export const creatorRedeemInviteSchema = z.object({
  code: z.string().min(6).max(64)
});

export const adminInviteCreateSchema = z.object({
  role: z.enum(["approvedCreator", "creator"]).default("approvedCreator"),
  maxUses: z.number().int().min(1).max(100).default(1),
  expiresAt: z.string().datetime().optional(),
  permissionGrants: z.array(z.string().min(3)).max(50).default([])
});

export const adminCreatorReviewSchema = z.object({
  note: z.string().min(3).max(600).optional(),
  permissionGrants: z.array(z.string().min(3)).max(50).default([])
});

export const adminCreatorSuspendSchema = z.object({
  note: z.string().min(3).max(600).optional()
});

export const agentStatusSchema = z.enum(["disconnected", "connected", "suspended"]);

export const createAgentSchema = z.object({
  name: z.string().min(2).max(80),
  role: z.string().min(2).max(60),
  detail: z.string().min(2).max(400).optional(),
  personality: z.string().min(2).max(1200).optional(),
  lore: z.string().min(2).max(2400).optional(),
  memoryScope: z.enum(["private", "project", "public"]).default("private")
});

export const updateAgentSchema = z
  .object({
    name: z.string().min(2).max(80).optional(),
    role: z.string().min(2).max(60).optional(),
    detail: z.string().min(2).max(400).optional(),
    personality: z.string().min(2).max(1200).optional(),
    lore: z.string().min(2).max(2400).optional(),
    memoryScope: z.enum(["private", "project", "public"]).optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: "At least one field is required" });

export const connectAgentSchema = z
  .object({
    provider: z.enum(["ollama", "llama.cpp", "api"]),
    model: z.string().min(1).max(120),
    keysRef: z.string().uuid().optional(),
    apiKey: z.string().min(8).max(500).optional(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({})
  })
  .refine((payload) => Boolean(payload.keysRef || payload.apiKey), {
    message: "keysRef or apiKey is required"
  });

export const assignAgentToolsSchema = z.object({
  updates: z
    .array(
      z.object({
        toolKey: z.string().min(3).max(120),
        allowed: z.boolean(),
        config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
      })
    )
    .min(1)
    .max(50)
});

export const assignAgentSkillsSchema = z.object({
  updates: z
    .array(
      z.object({
        skillId: z.string().uuid(),
        enabled: z.boolean().default(true),
        config: z.record(z.string(), z.unknown()).optional(),
        remove: z.boolean().default(false)
      })
    )
    .min(1)
    .max(50)
});

export const sandboxTestSchema = z.object({
  dryRunInput: z.record(z.string(), z.unknown()).optional()
});

export const globalRuleSchema = z.object({
  title: z.string().min(3).max(120),
  content: z.string().min(3).max(2000),
  enforcement: z.enum(["soft", "hard"]),
  priority: z.number().int().min(1).max(100).default(50),
  active: z.boolean().default(true)
});

export const projectRuleSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(3).max(120),
  content: z.string().min(3).max(2000),
  enforcement: z.enum(["soft", "hard"]),
  priority: z.number().int().min(1).max(100).default(50),
  active: z.boolean().default(true)
});

export const createProjectSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().min(2).max(2000).optional()
});

export const updateProjectSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    description: z.string().min(2).max(2000).nullable().optional(),
    status: z.enum(["active", "archived"]).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required"
  });

export const listProjectsQuerySchema = paginationQuerySchema.merge(
  z.object({
    status: z.enum(["active", "archived"]).optional()
  })
);

export const agentRuleSchema = z.object({
  projectId: z.string().uuid().optional(),
  sessionId: z.string().min(2).max(120).optional(),
  level: z.enum(["agent", "session"]).default("agent"),
  title: z.string().min(3).max(120),
  content: z.string().min(3).max(2000),
  enforcement: z.enum(["soft", "hard"]),
  priority: z.number().int().min(1).max(100).default(50),
  active: z.boolean().default(true)
});

export const createSkillSchema = z.object({
  name: z.string().min(2).max(100),
  version: z.string().min(1).max(30),
  description: z.string().min(3).max(1500),
  environment: z.enum(["draft", "staging", "prod"]).default("prod"),
  inputSchema: schemaDefinitionSchema,
  outputSchema: schemaDefinitionSchema,
  requiredTools: z.array(z.string().min(3)).max(50).default([]),
  tests: z
    .array(
      z.object({
        name: z.string().min(2).max(120),
        input: z.unknown(),
        expectedOutput: z.unknown()
      })
    )
    .max(100)
    .default([])
});

export const listSkillsQuerySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  environment: z.enum(["draft", "staging", "prod"]).optional()
});

export const promoteSkillSchema = z.object({
  targetEnvironment: z.enum(["draft", "staging", "prod"]),
  note: z.string().min(2).max(400).optional()
});

export const createMemorySchema = z.object({
  projectId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  scope: z.enum(["user", "project", "agent"]),
  text: z.string().min(2).max(6000),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const memoryQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  scope: z.enum(["user", "project", "agent"]).optional()
});

export const createTrainingJobSchema = z.object({
  projectId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  mode: z.enum(["fine-tuning", "lora", "adapter", "profile-tuning"]).default("fine-tuning"),
  config: z.record(z.string(), z.unknown()).default({})
});

export const publishAgentTemplateSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(2).max(120),
  description: z.string().min(3).max(2000),
  tags: z.array(z.string().min(2).max(30)).max(20).default([]),
  templateKey: z.string().min(4).max(120).optional(),
  compatibilityMin: z.string().min(1).max(30).optional(),
  compatibilityMax: z.string().min(1).max(30).optional()
});

export const importAgentTemplateSchema = z.object({
  nameOverride: z.string().min(2).max(120).optional()
});
