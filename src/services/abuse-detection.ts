import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { all, get, run } from "../db/sqlite";
import { parseJsonSafe } from "../utils/json";

export type AbuseRiskSource = "marketplace" | "dev-tools" | "training" | "ai-config" | "rate-limit" | "security";

export type AbuseRiskEventInput = {
  userId: string;
  source: AbuseRiskSource;
  eventKey: string;
  score?: number;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  traceId?: string | null;
};

export type AbuseBlockState = {
  userId: string;
  blockedUntil: string;
  incidentId: string | null;
  reason: string;
  score: number;
};

export type AbuseIncidentStatus = "open" | "resolved" | "all";

export type AbuseIncidentItem = {
  id: string;
  userId: string;
  username: string | null;
  source: string;
  reason: string;
  status: "open" | "resolved";
  score: number;
  threshold: number;
  eventsCount: number;
  firstEventAt: string;
  lastEventAt: string;
  blockUntil: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
};

type RiskAggregateRow = {
  total_score: number;
  events_count: number;
  first_event_at: string | null;
  last_event_at: string | null;
};

type IncidentRow = {
  id: string;
  user_id: string;
  username: string | null;
  source: string;
  reason: string;
  status: "open" | "resolved";
  score: number;
  threshold: number;
  events_count: number;
  first_event_at: string;
  last_event_at: string;
  block_until: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
};

type BlockRow = {
  user_id: string;
  blocked_until: string;
  incident_id: string | null;
  reason: string;
  score: number;
};

const DEFAULT_EVENT_SCORE = 10;
const EVENT_SCORES: Record<string, number> = {
  "marketplace.duplicate-active-listing": 30,
  "marketplace.listing-unavailable": 25,
  "marketplace.buy-conflict": 25,
  "marketplace.owner-mismatch": 30,
  "marketplace.invalid-buy-state": 15,
  "dev-tools.permission-denied": 25,
  "dev-tools.tool-unassigned": 20,
  "dev-tools.sandbox-blocked": 20,
  "dev-tools.execution-failed": 15,
  "rate-limit.sensitive.user": 20,
  "rate-limit.sensitive.token": 20,
  "ai-config.policy-blocked-tool": 10
};

function nowIso(): string {
  return new Date().toISOString();
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function toTimeMs(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeScore(value: number | undefined, eventKey: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(1000, Math.trunc(value)));
  }

  return EVENT_SCORES[eventKey] ?? DEFAULT_EVENT_SCORE;
}

function mapIncidentRow(row: IncidentRow): AbuseIncidentItem {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    source: row.source,
    reason: row.reason,
    status: row.status,
    score: row.score,
    threshold: row.threshold,
    eventsCount: row.events_count,
    firstEventAt: row.first_event_at,
    lastEventAt: row.last_event_at,
    blockUntil: row.block_until,
    metadata: parseJsonSafe<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note
  };
}

async function getRiskWindowAggregate(userId: string): Promise<RiskAggregateRow> {
  const sinceIso = isoFromMs(Date.now() - Math.max(60_000, env.ABUSE_RISK_WINDOW_MS));
  const aggregate = await get<RiskAggregateRow>(
    `
      SELECT
        COALESCE(SUM(score), 0) AS total_score,
        COUNT(*) AS events_count,
        MIN(created_at) AS first_event_at,
        MAX(created_at) AS last_event_at
      FROM abuse_risk_events
      WHERE user_id = ? AND created_at >= ?
    `,
    [userId, sinceIso]
  );

  return {
    total_score: aggregate?.total_score ?? 0,
    events_count: aggregate?.events_count ?? 0,
    first_event_at: aggregate?.first_event_at ?? null,
    last_event_at: aggregate?.last_event_at ?? null
  };
}

async function getOpenIncident(userId: string): Promise<IncidentRow | undefined> {
  return get<IncidentRow>(
    `
      SELECT
        i.id,
        i.user_id,
        u.username,
        i.source,
        i.reason,
        i.status,
        i.score,
        i.threshold,
        i.events_count,
        i.first_event_at,
        i.last_event_at,
        i.block_until,
        i.metadata,
        i.created_at,
        i.updated_at,
        i.resolved_at,
        i.resolved_by,
        i.resolution_note
      FROM abuse_incidents i
      LEFT JOIN users u ON u.id = i.user_id
      WHERE i.user_id = ? AND i.status = 'open'
      ORDER BY i.updated_at DESC
      LIMIT 1
    `,
    [userId]
  );
}

export async function recordAbuseRiskEvent(input: AbuseRiskEventInput): Promise<{
  eventId: string;
  totalScore: number;
  threshold: number;
  blocked: boolean;
  blockedUntil: string | null;
  incidentId: string | null;
}> {
  const score = normalizeScore(input.score, input.eventKey);
  const createdAt = nowIso();
  const eventId = randomUUID();

  await run(
    `
      INSERT INTO abuse_risk_events (id, user_id, source, event_key, score, metadata, request_id, trace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      eventId,
      input.userId,
      input.source,
      input.eventKey,
      score,
      JSON.stringify(input.metadata ?? {}),
      input.requestId ?? null,
      input.traceId ?? null,
      createdAt
    ]
  );

  const aggregate = await getRiskWindowAggregate(input.userId);
  const threshold = Math.max(1, env.ABUSE_RISK_BLOCK_THRESHOLD);
  if (aggregate.total_score < threshold) {
    return {
      eventId,
      totalScore: aggregate.total_score,
      threshold,
      blocked: false,
      blockedUntil: null,
      incidentId: null
    };
  }

  const targetBlockUntilMs = Date.now() + Math.max(60_000, env.ABUSE_RISK_BLOCK_MS);
  const existingBlock = await get<BlockRow>("SELECT user_id, blocked_until, incident_id, reason, score FROM abuse_user_blocks WHERE user_id = ?", [
    input.userId
  ]);
  const existingBlockMs = toTimeMs(existingBlock?.blocked_until);
  const blockedUntil = isoFromMs(Math.max(targetBlockUntilMs, existingBlockMs));
  const nowMs = Date.now();

  const existingIncident = await getOpenIncident(input.userId);
  const existingIncidentUpdatedMs = toTimeMs(existingIncident?.updated_at);
  const reuseIncident =
    Boolean(existingIncident?.id) && nowMs - existingIncidentUpdatedMs <= Math.max(30_000, env.ABUSE_RISK_INCIDENT_COOLDOWN_MS);

  const firstEventAt = aggregate.first_event_at ?? createdAt;
  const lastEventAt = aggregate.last_event_at ?? createdAt;
  const incidentId = reuseIncident ? (existingIncident?.id as string) : randomUUID();
  const incidentSource = existingIncident?.source ?? input.source;
  const incidentReason = input.eventKey;
  const incidentMetadata = JSON.stringify({
    triggerEventId: eventId,
    triggerEventKey: input.eventKey,
    triggerSource: input.source,
    latestMetadata: input.metadata ?? {}
  });

  if (reuseIncident) {
    await run(
      `
        UPDATE abuse_incidents
        SET
          source = ?,
          reason = ?,
          score = ?,
          threshold = ?,
          events_count = ?,
          first_event_at = ?,
          last_event_at = ?,
          block_until = ?,
          metadata = ?,
          updated_at = ?,
          status = 'open',
          resolved_at = NULL,
          resolved_by = NULL,
          resolution_note = NULL
        WHERE id = ?
      `,
      [
        incidentSource,
        incidentReason,
        aggregate.total_score,
        threshold,
        aggregate.events_count,
        firstEventAt,
        lastEventAt,
        blockedUntil,
        incidentMetadata,
        createdAt,
        incidentId
      ]
    );
  } else {
    await run(
      `
        INSERT INTO abuse_incidents (
          id,
          user_id,
          source,
          reason,
          status,
          score,
          threshold,
          events_count,
          first_event_at,
          last_event_at,
          block_until,
          metadata,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        incidentId,
        input.userId,
        input.source,
        incidentReason,
        aggregate.total_score,
        threshold,
        aggregate.events_count,
        firstEventAt,
        lastEventAt,
        blockedUntil,
        incidentMetadata,
        createdAt,
        createdAt
      ]
    );
  }

  await run(
    `
      INSERT INTO abuse_user_blocks (user_id, blocked_until, incident_id, reason, score, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        blocked_until = excluded.blocked_until,
        incident_id = excluded.incident_id,
        reason = excluded.reason,
        score = excluded.score,
        updated_at = excluded.updated_at
    `,
    [input.userId, blockedUntil, incidentId, incidentReason, aggregate.total_score, createdAt]
  );

  return {
    eventId,
    totalScore: aggregate.total_score,
    threshold,
    blocked: true,
    blockedUntil,
    incidentId
  };
}

export async function getActiveAbuseBlock(userId: string): Promise<AbuseBlockState | null> {
  const row = await get<BlockRow>("SELECT user_id, blocked_until, incident_id, reason, score FROM abuse_user_blocks WHERE user_id = ?", [userId]);
  if (!row) {
    return null;
  }

  if (toTimeMs(row.blocked_until) <= Date.now()) {
    await run("DELETE FROM abuse_user_blocks WHERE user_id = ?", [userId]);
    return null;
  }

  return {
    userId: row.user_id,
    blockedUntil: row.blocked_until,
    incidentId: row.incident_id,
    reason: row.reason,
    score: row.score
  };
}

export async function listAbuseIncidents(input?: {
  status?: AbuseIncidentStatus;
  userId?: string;
  limit?: number;
  offset?: number;
}): Promise<AbuseIncidentItem[]> {
  const status = input?.status ?? "all";
  const limit = Math.max(1, Math.min(500, Math.trunc(input?.limit ?? 100)));
  const offset = Math.max(0, Math.min(200_000, Math.trunc(input?.offset ?? 0)));
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (status !== "all") {
    where.push("i.status = ?");
    params.push(status);
  }

  if (input?.userId) {
    where.push("i.user_id = ?");
    params.push(input.userId);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await all<IncidentRow>(
    `
      SELECT
        i.id,
        i.user_id,
        u.username,
        i.source,
        i.reason,
        i.status,
        i.score,
        i.threshold,
        i.events_count,
        i.first_event_at,
        i.last_event_at,
        i.block_until,
        i.metadata,
        i.created_at,
        i.updated_at,
        i.resolved_at,
        i.resolved_by,
        i.resolution_note
      FROM abuse_incidents i
      LEFT JOIN users u ON u.id = i.user_id
      ${whereSql}
      ORDER BY i.updated_at DESC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset]
  );

  return rows.map(mapIncidentRow);
}

export async function getAbuseSecuritySummary(windowMinutes = 60): Promise<{
  windowMinutes: number;
  openIncidents: number;
  activeBlocks: number;
  recentEvents: number;
  topRiskUsers: Array<{
    userId: string;
    username: string | null;
    score: number;
    eventsCount: number;
    lastEventAt: string;
  }>;
}> {
  const safeWindow = Math.max(1, Math.min(360, Math.trunc(windowMinutes)));
  const sinceIso = isoFromMs(Date.now() - safeWindow * 60_000);

  const openIncidentsRow = await get<{ count: number }>("SELECT COUNT(*) as count FROM abuse_incidents WHERE status = 'open'");
  const activeBlocksRow = await get<{ count: number }>("SELECT COUNT(*) as count FROM abuse_user_blocks WHERE blocked_until > ?", [nowIso()]);
  const recentEventsRow = await get<{ count: number }>("SELECT COUNT(*) as count FROM abuse_risk_events WHERE created_at >= ?", [sinceIso]);

  const topRows = await all<{
    user_id: string;
    username: string | null;
    score: number;
    events_count: number;
    last_event_at: string;
  }>(
    `
      SELECT
        e.user_id,
        u.username,
        COALESCE(SUM(e.score), 0) AS score,
        COUNT(*) AS events_count,
        MAX(e.created_at) AS last_event_at
      FROM abuse_risk_events e
      LEFT JOIN users u ON u.id = e.user_id
      WHERE e.created_at >= ?
      GROUP BY e.user_id, u.username
      ORDER BY score DESC, last_event_at DESC
      LIMIT 10
    `,
    [sinceIso]
  );

  return {
    windowMinutes: safeWindow,
    openIncidents: openIncidentsRow?.count ?? 0,
    activeBlocks: activeBlocksRow?.count ?? 0,
    recentEvents: recentEventsRow?.count ?? 0,
    topRiskUsers: topRows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      score: row.score,
      eventsCount: row.events_count,
      lastEventAt: row.last_event_at
    }))
  };
}

export async function resolveAbuseIncident(input: {
  incidentId: string;
  resolvedBy: string;
  note?: string;
  unblockUser?: boolean;
}): Promise<AbuseIncidentItem | null> {
  const incident = await get<IncidentRow>(
    `
      SELECT
        i.id,
        i.user_id,
        u.username,
        i.source,
        i.reason,
        i.status,
        i.score,
        i.threshold,
        i.events_count,
        i.first_event_at,
        i.last_event_at,
        i.block_until,
        i.metadata,
        i.created_at,
        i.updated_at,
        i.resolved_at,
        i.resolved_by,
        i.resolution_note
      FROM abuse_incidents i
      LEFT JOIN users u ON u.id = i.user_id
      WHERE i.id = ?
      LIMIT 1
    `,
    [input.incidentId]
  );
  if (!incident) {
    return null;
  }

  const now = nowIso();
  await run(
    `
      UPDATE abuse_incidents
      SET
        status = 'resolved',
        updated_at = ?,
        resolved_at = ?,
        resolved_by = ?,
        resolution_note = ?
      WHERE id = ?
    `,
    [now, now, input.resolvedBy, input.note ?? null, input.incidentId]
  );

  if (input.unblockUser !== false) {
    await run("DELETE FROM abuse_user_blocks WHERE user_id = ?", [incident.user_id]);
  }

  const updated = await get<IncidentRow>(
    `
      SELECT
        i.id,
        i.user_id,
        u.username,
        i.source,
        i.reason,
        i.status,
        i.score,
        i.threshold,
        i.events_count,
        i.first_event_at,
        i.last_event_at,
        i.block_until,
        i.metadata,
        i.created_at,
        i.updated_at,
        i.resolved_at,
        i.resolved_by,
        i.resolution_note
      FROM abuse_incidents i
      LEFT JOIN users u ON u.id = i.user_id
      WHERE i.id = ?
      LIMIT 1
    `,
    [input.incidentId]
  );

  return updated ? mapIncidentRow(updated) : null;
}
