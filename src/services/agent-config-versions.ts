import { randomUUID } from "node:crypto";
import { all, get, run } from "../db/sqlite";
import { parseJsonSafe } from "../utils/json";

type AgentRow = {
  id: string;
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
};

type AgentConnectionRow = {
  provider: string;
  model: string;
  keys_ref: string | null;
  status: string;
  config: string;
  connected_at: string | null;
  disconnected_at: string | null;
};

type AgentToolRow = {
  tool_key: string;
  allowed: number;
  config: string;
};

type AgentSkillRow = {
  skill_id: string;
  skill_version: string;
  enabled: number;
  config: string;
};

type AgentRuleRow = {
  project_id: string | null;
  session_id: string | null;
  level: string;
  title: string;
  content: string;
  enforcement: string;
  priority: number;
  active: number;
};

type AgentConfigVersionRow = {
  id: string;
  version: number;
  reason: string;
  snapshot_json: string;
  created_by: string | null;
  created_by_username: string | null;
  created_at: string;
};

type AgentConfigSnapshot = {
  agent: {
    projectId: string | null;
    name: string;
    role: string;
    detail: string | null;
    personality: string | null;
    lore: string | null;
    memoryScope: string;
    status: "disconnected" | "connected" | "suspended";
    provider: string | null;
    model: string | null;
  };
  connection: {
    provider: string;
    model: string;
    keysRef: string | null;
    status: string;
    config: Record<string, unknown>;
    connectedAt: string | null;
    disconnectedAt: string | null;
  } | null;
  tools: Array<{
    toolKey: string;
    allowed: boolean;
    config: Record<string, unknown>;
  }>;
  skills: Array<{
    skillId: string;
    skillVersion: string;
    enabled: boolean;
    config: Record<string, unknown>;
  }>;
  rules: Array<{
    projectId: string | null;
    sessionId: string | null;
    level: string;
    title: string;
    content: string;
    enforcement: string;
    priority: number;
    active: boolean;
  }>;
  capturedAt: string;
};

export type AgentConfigVersionSummary = {
  id: string;
  version: number;
  reason: string;
  createdBy: string | null;
  createdByUsername: string | null;
  createdAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function toSnapshot(
  agent: AgentRow,
  connection: AgentConnectionRow | undefined,
  tools: AgentToolRow[],
  skills: AgentSkillRow[],
  rules: AgentRuleRow[]
): AgentConfigSnapshot {
  return {
    agent: {
      projectId: agent.project_id,
      name: agent.name,
      role: agent.role,
      detail: agent.detail,
      personality: agent.personality,
      lore: agent.lore,
      memoryScope: agent.memory_scope,
      status: agent.status,
      provider: agent.provider,
      model: agent.model
    },
    connection: connection
      ? {
          provider: connection.provider,
          model: connection.model,
          keysRef: connection.keys_ref,
          status: connection.status,
          config: parseJsonSafe<Record<string, unknown>>(connection.config, {}),
          connectedAt: connection.connected_at,
          disconnectedAt: connection.disconnected_at
        }
      : null,
    tools: tools.map((tool) => ({
      toolKey: tool.tool_key,
      allowed: tool.allowed === 1,
      config: parseJsonSafe<Record<string, unknown>>(tool.config, {})
    })),
    skills: skills.map((skill) => ({
      skillId: skill.skill_id,
      skillVersion: skill.skill_version,
      enabled: skill.enabled === 1,
      config: parseJsonSafe<Record<string, unknown>>(skill.config, {})
    })),
    rules: rules.map((rule) => ({
      projectId: rule.project_id,
      sessionId: rule.session_id,
      level: rule.level,
      title: rule.title,
      content: rule.content,
      enforcement: rule.enforcement,
      priority: rule.priority,
      active: rule.active === 1
    })),
    capturedAt: nowIso()
  };
}

async function loadSnapshot(agentId: string): Promise<AgentConfigSnapshot | null> {
  const agent = await get<AgentRow>(
    `
      SELECT id, project_id, name, role, detail, personality, lore, memory_scope, status, provider, model
      FROM agents
      WHERE id = ?
    `,
    [agentId]
  );
  if (!agent) {
    return null;
  }

  const connection = await get<AgentConnectionRow>(
    `
      SELECT provider, model, keys_ref, status, config, connected_at, disconnected_at
      FROM agent_connections
      WHERE agent_id = ?
    `,
    [agentId]
  );
  const tools = await all<AgentToolRow>("SELECT tool_key, allowed, config FROM agent_tools WHERE agent_id = ? ORDER BY tool_key ASC", [agentId]);
  const skills = await all<AgentSkillRow>(
    `
      SELECT skill_id, skill_version, enabled, config
      FROM agent_skills
      WHERE agent_id = ?
      ORDER BY skill_id ASC, created_at ASC
    `,
    [agentId]
  );
  const rules = await all<AgentRuleRow>(
    `
      SELECT project_id, session_id, level, title, content, enforcement, priority, active
      FROM agent_rules
      WHERE agent_id = ?
      ORDER BY priority DESC, created_at ASC
    `,
    [agentId]
  );

  return toSnapshot(agent, connection, tools, skills, rules);
}

async function nextVersion(agentId: string): Promise<number> {
  const row = await get<{ latest: number | null }>("SELECT MAX(version) as latest FROM agent_config_versions WHERE agent_id = ?", [agentId]);
  const latest = row?.latest ?? 0;
  return latest + 1;
}

export async function recordAgentConfigVersion(input: {
  agentId: string;
  createdBy: string | null;
  reason: string;
}): Promise<{ id: string; version: number } | null> {
  const snapshot = await loadSnapshot(input.agentId);
  if (!snapshot) {
    return null;
  }

  const version = await nextVersion(input.agentId);
  const id = randomUUID();
  await run(
    `
      INSERT INTO agent_config_versions (id, agent_id, version, reason, snapshot_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [id, input.agentId, version, input.reason, JSON.stringify(snapshot), input.createdBy, nowIso()]
  );

  return { id, version };
}

export async function listAgentConfigVersions(
  agentId: string,
  limit = 50,
  offset = 0
): Promise<{
  items: AgentConfigVersionSummary[];
  latestVersion: number;
}> {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const safeOffset = Math.max(0, Math.min(200_000, Math.trunc(offset)));
  const rows = await all<AgentConfigVersionRow>(
    `
      SELECT
        v.id,
        v.version,
        v.reason,
        v.snapshot_json,
        v.created_by,
        u.username AS created_by_username,
        v.created_at
      FROM agent_config_versions v
      LEFT JOIN users u ON u.id = v.created_by
      WHERE v.agent_id = ?
      ORDER BY v.version DESC
      LIMIT ? OFFSET ?
    `,
    [agentId, safeLimit, safeOffset]
  );

  const latest = await get<{ latest: number | null }>("SELECT MAX(version) as latest FROM agent_config_versions WHERE agent_id = ?", [agentId]);

  return {
    latestVersion: latest?.latest ?? 0,
    items: rows.map((row) => ({
      id: row.id,
      version: row.version,
      reason: row.reason,
      createdBy: row.created_by,
      createdByUsername: row.created_by_username,
      createdAt: row.created_at
    }))
  };
}

export async function rollbackAgentConfigVersion(input: {
  agentId: string;
  version: number;
  actorUserId: string;
  note?: string;
}): Promise<{ rolledBackToVersion: number; newVersion: number } | null> {
  const target = await get<{ snapshot_json: string }>(
    "SELECT snapshot_json FROM agent_config_versions WHERE agent_id = ? AND version = ?",
    [input.agentId, input.version]
  );
  if (!target) {
    return null;
  }

  const snapshot = parseJsonSafe<AgentConfigSnapshot | null>(target.snapshot_json, null);
  if (!snapshot) {
    throw new Error("Corrupted agent config snapshot");
  }

  const now = nowIso();
  try {
    await run("BEGIN TRANSACTION");

    await run(
      `
        UPDATE agents
        SET
          project_id = ?,
          name = ?,
          role = ?,
          detail = ?,
          personality = ?,
          lore = ?,
          memory_scope = ?,
          status = ?,
          provider = ?,
          model = ?,
          updated_at = ?
        WHERE id = ?
      `,
      [
        snapshot.agent.projectId,
        snapshot.agent.name,
        snapshot.agent.role,
        snapshot.agent.detail,
        snapshot.agent.personality,
        snapshot.agent.lore,
        snapshot.agent.memoryScope,
        snapshot.agent.status,
        snapshot.agent.provider,
        snapshot.agent.model,
        now,
        input.agentId
      ]
    );

    if (snapshot.connection) {
      const existingConnection = await get<{ id: string }>("SELECT id FROM agent_connections WHERE agent_id = ?", [input.agentId]);
      if (existingConnection) {
        await run(
          `
            UPDATE agent_connections
            SET
              provider = ?,
              model = ?,
              keys_ref = ?,
              config = ?,
              status = ?,
              connected_at = ?,
              disconnected_at = ?,
              updated_at = ?
            WHERE agent_id = ?
          `,
          [
            snapshot.connection.provider,
            snapshot.connection.model,
            snapshot.connection.keysRef,
            JSON.stringify(snapshot.connection.config ?? {}),
            snapshot.connection.status,
            snapshot.connection.connectedAt,
            snapshot.connection.disconnectedAt,
            now,
            input.agentId
          ]
        );
      } else {
        await run(
          `
            INSERT INTO agent_connections (
              id, agent_id, provider, model, keys_ref, config, status, connected_at, disconnected_at, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            randomUUID(),
            input.agentId,
            snapshot.connection.provider,
            snapshot.connection.model,
            snapshot.connection.keysRef,
            JSON.stringify(snapshot.connection.config ?? {}),
            snapshot.connection.status,
            snapshot.connection.connectedAt,
            snapshot.connection.disconnectedAt,
            now,
            now
          ]
        );
      }
    } else {
      await run("DELETE FROM agent_connections WHERE agent_id = ?", [input.agentId]);
    }

    await run("DELETE FROM agent_tools WHERE agent_id = ?", [input.agentId]);
    for (const tool of snapshot.tools) {
      await run(
        `
          INSERT INTO agent_tools (id, agent_id, tool_key, allowed, config, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [randomUUID(), input.agentId, tool.toolKey, tool.allowed ? 1 : 0, JSON.stringify(tool.config ?? {}), now, now]
      );
    }

    await run("DELETE FROM agent_skills WHERE agent_id = ?", [input.agentId]);
    for (const skill of snapshot.skills) {
      await run(
        `
          INSERT INTO agent_skills (id, agent_id, skill_id, skill_version, config, enabled, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          input.agentId,
          skill.skillId,
          skill.skillVersion,
          JSON.stringify(skill.config ?? {}),
          skill.enabled ? 1 : 0,
          now
        ]
      );
    }

    await run("DELETE FROM agent_rules WHERE agent_id = ?", [input.agentId]);
    for (const rule of snapshot.rules) {
      await run(
        `
          INSERT INTO agent_rules (
            id, agent_id, project_id, session_id, level, title, content, enforcement, priority, active, created_by, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          input.agentId,
          rule.projectId,
          rule.sessionId,
          rule.level,
          rule.title,
          rule.content,
          rule.enforcement,
          rule.priority,
          rule.active ? 1 : 0,
          input.actorUserId,
          now,
          now
        ]
      );
    }

    const finalSnapshot = await loadSnapshot(input.agentId);
    if (!finalSnapshot) {
      throw new Error("Agent not found after rollback");
    }

    const rollbackVersion = await nextVersion(input.agentId);
    const rollbackReason = input.note?.trim()
      ? `rollback to v${input.version}: ${input.note.trim()}`
      : `rollback to v${input.version}`;
    await run(
      `
        INSERT INTO agent_config_versions (id, agent_id, version, reason, snapshot_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [randomUUID(), input.agentId, rollbackVersion, rollbackReason, JSON.stringify(finalSnapshot), input.actorUserId, now]
    );

    await run("COMMIT");

    return {
      rolledBackToVersion: input.version,
      newVersion: rollbackVersion
    };
  } catch (error) {
    try {
      await run("ROLLBACK");
    } catch {
      // ignore rollback errors when no open transaction
    }

    throw error;
  }
}
