import { randomUUID } from "node:crypto";
import { z } from "zod";
import { run } from "../db/sqlite";
import { createCardSchema, validateCardBalance } from "./card-validator";

export type ToolExecutionContext = {
  userId: string;
  agentId?: string;
};

export type ToolDefinition = {
  key: string;
  name: string;
  description: string;
  requiredPermission: string;
  inputSchema: z.ZodTypeAny;
  execute: (context: ToolExecutionContext, input: unknown) => Promise<unknown>;
};

const memoryToolInput = z.object({
  projectId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  scope: z.enum(["user", "project", "agent"]).default("user"),
  text: z.string().min(2).max(5000)
});

const profileToolInput = z.object({
  includeStatus: z.boolean().default(true)
});

const balanceToolInput = createCardSchema;

const tools: ToolDefinition[] = [
  {
    key: "memory.storeSnippet",
    name: "Memory Store Snippet",
    description: "Stores RAG memory scoped to user/project/agent.",
    requiredPermission: "memory.manage",
    inputSchema: memoryToolInput,
    execute: async (context, rawInput) => {
      const input = memoryToolInput.parse(rawInput);
      const now = new Date().toISOString();

      const targetAgentId = input.agentId ?? context.agentId ?? null;

      await run(
        `
          INSERT INTO rag_memories (id, user_id, project_id, agent_id, scope, content, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          context.userId,
          input.projectId ?? null,
          targetAgentId,
          input.scope,
          input.text,
          JSON.stringify({ source: "tool:memory.storeSnippet" }),
          now,
          now
        ]
      );

      return {
        ok: true,
        scope: input.scope,
        stored: true
      };
    }
  },
  {
    key: "agent.profileEcho",
    name: "Agent Profile Echo",
    description: "Returns a minimal profile snapshot for diagnostics.",
    requiredPermission: "agents.manage",
    inputSchema: profileToolInput,
    execute: async (context, rawInput) => {
      const input = profileToolInput.parse(rawInput);
      return {
        ok: true,
        userId: context.userId,
        agentId: context.agentId ?? null,
        includeStatus: input.includeStatus
      };
    }
  },
  {
    key: "cards.balanceCheck",
    name: "Cards Balance Check",
    description: "Runs the card validator engine and returns balance diagnostics.",
    requiredPermission: "pro.balance_tools",
    inputSchema: balanceToolInput,
    execute: async (_context, rawInput) => {
      const input = balanceToolInput.parse(rawInput);
      const result = validateCardBalance(input);
      return {
        ok: result.ok,
        errors: result.errors
      };
    }
  }
];

export function listSupportedTools(): Omit<ToolDefinition, "inputSchema" | "execute">[] {
  return tools.map((tool) => ({
    key: tool.key,
    name: tool.name,
    description: tool.description,
    requiredPermission: tool.requiredPermission
  }));
}

export function getToolDefinition(toolKey: string): ToolDefinition | undefined {
  return tools.find((tool) => tool.key === toolKey);
}

export async function executeToolAction(toolKey: string, context: ToolExecutionContext, input: unknown): Promise<unknown> {
  const tool = getToolDefinition(toolKey);
  if (!tool) {
    throw new Error(`Unsupported tool: ${toolKey}`);
  }

  return tool.execute(context, input);
}
