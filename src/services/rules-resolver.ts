import { all } from "../db/sqlite";

type RuleRow = {
  id: string;
  title: string;
  content: string;
  enforcement: "soft" | "hard";
  priority: number;
  source: "global" | "project" | "agent" | "session";
};

type GlobalRuleDbRow = {
  id: string;
  title: string;
  content: string;
  enforcement: "soft" | "hard";
  priority: number;
};

type ProjectRuleDbRow = {
  id: string;
  title: string;
  content: string;
  enforcement: "soft" | "hard";
  priority: number;
};

type AgentRuleDbRow = {
  id: string;
  title: string;
  content: string;
  enforcement: "soft" | "hard";
  priority: number;
  level: "agent" | "session";
};

const levelWeight: Record<RuleRow["source"], number> = {
  global: 4,
  project: 3,
  agent: 2,
  session: 1
};

function normalizeRuleKey(title: string): string {
  return title.trim().toLowerCase();
}

function dedupeByPriority(rules: RuleRow[]): RuleRow[] {
  const selected = new Map<string, RuleRow>();

  const sorted = [...rules].sort((a, b) => {
    const byLevel = levelWeight[b.source] - levelWeight[a.source];
    if (byLevel !== 0) {
      return byLevel;
    }

    return b.priority - a.priority;
  });

  for (const rule of sorted) {
    const key = normalizeRuleKey(rule.title);
    if (!selected.has(key)) {
      selected.set(key, rule);
    }
  }

  return [...selected.values()];
}

export async function resolveEffectiveRules(input: {
  agentId: string;
  projectId?: string;
  sessionId?: string;
}): Promise<{
  globalRules: RuleRow[];
  projectRules: RuleRow[];
  agentRules: RuleRow[];
  sessionRules: RuleRow[];
  effectiveRules: RuleRow[];
}> {
  const globalRules = (
    await all<GlobalRuleDbRow>(
      `
        SELECT id, title, content, enforcement, priority
        FROM global_rules
        WHERE active = 1
        ORDER BY priority DESC, created_at DESC
      `
    )
  ).map((row) => ({ ...row, source: "global" as const }));

  const projectRules = input.projectId
    ? (
        await all<ProjectRuleDbRow>(
          `
            SELECT id, title, content, enforcement, priority
            FROM project_rules
            WHERE project_id = ? AND active = 1
            ORDER BY priority DESC, created_at DESC
          `,
          [input.projectId]
        )
      ).map((row) => ({ ...row, source: "project" as const }))
    : [];

  const agentRulesRaw = await all<AgentRuleDbRow>(
    `
      SELECT id, title, content, enforcement, priority, level
      FROM agent_rules
      WHERE agent_id = ?
        AND active = 1
        AND (
          level = 'agent'
          OR (level = 'session' AND (? IS NOT NULL AND session_id = ?))
        )
      ORDER BY priority DESC, created_at DESC
    `,
    [input.agentId, input.sessionId ?? null, input.sessionId ?? null]
  );

  const agentRules = agentRulesRaw
    .filter((rule) => rule.level === "agent")
    .map((row) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      enforcement: row.enforcement,
      priority: row.priority,
      source: "agent" as const
    }));

  const sessionRules = agentRulesRaw
    .filter((rule) => rule.level === "session")
    .map((row) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      enforcement: row.enforcement,
      priority: row.priority,
      source: "session" as const
    }));

  const effectiveRules = dedupeByPriority([...globalRules, ...projectRules, ...agentRules, ...sessionRules]);

  return {
    globalRules,
    projectRules,
    agentRules,
    sessionRules,
    effectiveRules
  };
}
