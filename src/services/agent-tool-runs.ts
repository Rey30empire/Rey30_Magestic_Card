import { randomUUID } from "node:crypto";
import { all, run } from "../db/sqlite";
import { parseJsonSafe } from "../utils/json";

export type AgentToolRunStatus = "success" | "failed" | "blocked" | "denied";

type AgentToolRunRow = {
  id: string;
  agent_id: string | null;
  user_id: string;
  username: string | null;
  tool_key: string;
  status: AgentToolRunStatus;
  latency_ms: number;
  input_json: string;
  output_json: string | null;
  error_message: string | null;
  request_id: string | null;
  trace_id: string | null;
  created_at: string;
};

export type AgentToolRunItem = {
  id: string;
  agentId: string | null;
  userId: string;
  username: string | null;
  toolKey: string;
  status: AgentToolRunStatus;
  latencyMs: number;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  errorMessage: string | null;
  requestId: string | null;
  traceId: string | null;
  createdAt: string;
};

type JsonObject = Record<string, unknown>;
const MAX_JSON_LENGTH = 4000;
const MAX_ERROR_LENGTH = 300;

function summarizeUnknown(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= 2) {
      return `[array:${value.length}]`;
    }
    const preview = value.slice(0, 20).map((item) => summarizeUnknown(item, depth + 1));
    return value.length > 20 ? [...preview, `...(${value.length - 20} more)`] : preview;
  }

  if (typeof value === "object") {
    if (depth >= 2) {
      return "[object]";
    }
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      out[key] = summarizeUnknown(entry, depth + 1);
    }
    return out;
  }

  return String(value);
}

function summarizePayload(value: unknown): JsonObject {
  const summarized = summarizeUnknown(value, 0);
  const normalized: JsonObject = typeof summarized === "object" && summarized !== null ? (summarized as JsonObject) : { value: summarized };
  const serialized = JSON.stringify(normalized);
  if (serialized.length <= MAX_JSON_LENGTH) {
    return normalized;
  }

  return {
    _truncated: true,
    preview: serialized.slice(0, MAX_JSON_LENGTH)
  };
}

function mapRow(row: AgentToolRunRow): AgentToolRunItem {
  return {
    id: row.id,
    agentId: row.agent_id,
    userId: row.user_id,
    username: row.username,
    toolKey: row.tool_key,
    status: row.status,
    latencyMs: row.latency_ms,
    input: parseJsonSafe<JsonObject>(row.input_json, {}),
    output: row.output_json ? parseJsonSafe<JsonObject>(row.output_json, {}) : null,
    errorMessage: row.error_message,
    requestId: row.request_id,
    traceId: row.trace_id,
    createdAt: row.created_at
  };
}

export async function recordAgentToolRun(input: {
  agentId?: string | null;
  userId: string;
  toolKey: string;
  status: AgentToolRunStatus;
  latencyMs: number;
  inputPayload: unknown;
  outputPayload?: unknown;
  errorMessage?: string | null;
  requestId?: string | null;
  traceId?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `
      INSERT INTO agent_tool_runs (
        id, agent_id, user_id, tool_key, status, latency_ms, input_json, output_json, error_message, request_id, trace_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      randomUUID(),
      input.agentId ?? null,
      input.userId,
      input.toolKey,
      input.status,
      Math.max(0, Math.trunc(input.latencyMs)),
      JSON.stringify(summarizePayload(input.inputPayload)),
      input.outputPayload === undefined ? null : JSON.stringify(summarizePayload(input.outputPayload)),
      input.errorMessage ? input.errorMessage.slice(0, MAX_ERROR_LENGTH) : null,
      input.requestId ?? null,
      input.traceId ?? null,
      now
    ]
  );
}

export async function listAgentToolRuns(input: {
  agentId: string;
  limit?: number;
  offset?: number;
  status?: AgentToolRunStatus | "all";
  toolKey?: string;
  from?: string;
  to?: string;
}): Promise<AgentToolRunItem[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  const offset = Math.max(0, Math.min(200_000, Math.trunc(input.offset ?? 0)));
  const where: string[] = ["r.agent_id = ?"];
  const params: Array<string | number> = [input.agentId];

  if (input.status && input.status !== "all") {
    where.push("r.status = ?");
    params.push(input.status);
  }

  if (input.toolKey) {
    where.push("r.tool_key = ?");
    params.push(input.toolKey);
  }

  if (input.from) {
    where.push("r.created_at >= ?");
    params.push(input.from);
  }

  if (input.to) {
    where.push("r.created_at <= ?");
    params.push(input.to);
  }

  const rows = await all<AgentToolRunRow>(
    `
      SELECT
        r.id,
        r.agent_id,
        r.user_id,
        u.username,
        r.tool_key,
        r.status,
        r.latency_ms,
        r.input_json,
        r.output_json,
        r.error_message,
        r.request_id,
        r.trace_id,
        r.created_at
      FROM agent_tool_runs r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset]
  );

  return rows.map(mapRow);
}
