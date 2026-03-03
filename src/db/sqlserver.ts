import sql from "mssql";
import { env } from "../config/env";
import { getTraceContext } from "../services/ops-tracing";

type TrainingJobMirrorInput = {
  id: string;
  userId: string;
  projectId: string | null;
  agentId: string | null;
  idempotencyKey: string | null;
  mode: string;
  status: string;
  config: unknown;
  platform: string;
  logs: unknown;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type SqlServerHealthSnapshot = {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  lastCheckedAt: string | null;
  error: string | null;
  target: {
    host: string;
    port: number;
    instance: string | null;
    database: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
  };
};

let pool: sql.ConnectionPool | null = null;
let mirrorInitialized = false;
const sqlServerTransactionsByTraceId = new Map<string, sql.Transaction>();
const GLOBAL_SQLSERVER_TX_KEY = "__global__";
let lastSnapshot: SqlServerHealthSnapshot = makeSnapshot({
  enabled: false,
  configured: false,
  connected: false,
  error: null
});

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.trunc(value);
  return Math.min(max, Math.max(min, rounded));
}

function buildTarget() {
  const port = sanitizeInteger(env.SQL_SERVER_PORT, 1433, 1, 65535);
  const instance = env.SQL_SERVER_INSTANCE.trim();
  return {
    host: env.SQL_SERVER_HOST,
    port,
    instance: instance.length > 0 ? instance : null,
    database: env.SQL_SERVER_DATABASE,
    encrypt: env.SQL_SERVER_ENCRYPT,
    trustServerCertificate: env.SQL_SERVER_TRUST_SERVER_CERTIFICATE
  };
}

function makeSnapshot(input: {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  error: string | null;
}): SqlServerHealthSnapshot {
  return {
    enabled: input.enabled,
    configured: input.configured,
    connected: input.connected,
    lastCheckedAt: nowIso(),
    error: input.error,
    target: buildTarget()
  };
}

export function isSqlServerConfigured(): boolean {
  return (
    env.SQL_SERVER_HOST.trim().length > 0 &&
    env.SQL_SERVER_DATABASE.trim().length > 0 &&
    env.SQL_SERVER_USER.trim().length > 0 &&
    env.SQL_SERVER_PASSWORD.trim().length > 0
  );
}

function isSqlServerActive(): boolean {
  return env.SQL_SERVER_ENABLED || env.DB_ENGINE === "sqlserver";
}

function resolveSqlServerIdentity(mode: "literal" | "domain"): { user: string; domain: string | undefined } {
  const raw = env.SQL_SERVER_USER.trim();
  if (mode === "literal") {
    return { user: raw, domain: undefined };
  }

  const separatorIndex = raw.indexOf("\\");
  if (separatorIndex <= 0 || separatorIndex >= raw.length - 1) {
    return { user: raw, domain: undefined };
  }

  const domain = raw.slice(0, separatorIndex).trim();
  const user = raw.slice(separatorIndex + 1).trim();
  if (domain.length === 0 || user.length === 0) {
    return { user: raw, domain: undefined };
  }

  return { user, domain };
}

function buildSqlServerConfig(mode: "literal" | "domain"): sql.config {
  const port = sanitizeInteger(env.SQL_SERVER_PORT, 1433, 1, 65535);
  const connectTimeoutMs = sanitizeInteger(env.SQL_SERVER_CONNECT_TIMEOUT_MS, 5000, 200, 120_000);
  const requestTimeoutMs = sanitizeInteger(env.SQL_SERVER_REQUEST_TIMEOUT_MS, 10_000, 200, 120_000);
  const poolMax = sanitizeInteger(env.SQL_SERVER_POOL_MAX, 5, 1, 50);
  const instance = env.SQL_SERVER_INSTANCE.trim();
  const identity = resolveSqlServerIdentity(mode);

  const options: sql.IOptions = {
    encrypt: env.SQL_SERVER_ENCRYPT,
    trustServerCertificate: env.SQL_SERVER_TRUST_SERVER_CERTIFICATE,
    enableArithAbort: true
  };

  if (instance.length > 0) {
    options.instanceName = instance;
  }

  return {
    server: env.SQL_SERVER_HOST,
    port: instance.length > 0 ? undefined : port,
    database: env.SQL_SERVER_DATABASE,
    user: identity.user,
    domain: identity.domain,
    password: env.SQL_SERVER_PASSWORD,
    connectionTimeout: connectTimeoutMs,
    requestTimeout: requestTimeoutMs,
    pool: {
      max: poolMax,
      min: 0,
      idleTimeoutMillis: 30_000
    },
    options
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeTransactionCommand(raw: string): string {
  return raw
    .trim()
    .replace(/;+$/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function resolveSqlServerTransactionKey(): string {
  const traceId = getTraceContext()?.traceId;
  if (!traceId || traceId.trim().length === 0) {
    return GLOBAL_SQLSERVER_TX_KEY;
  }
  return traceId;
}

function getActiveSqlServerTransaction(): sql.Transaction | null {
  return sqlServerTransactionsByTraceId.get(resolveSqlServerTransactionKey()) ?? null;
}

async function beginSqlServerTransaction(): Promise<void> {
  const transactionKey = resolveSqlServerTransactionKey();
  if (sqlServerTransactionsByTraceId.has(transactionKey)) {
    return;
  }

  const connectedPool = await connectPoolWithFallback();
  const transaction = new sql.Transaction(connectedPool);
  await transaction.begin();
  sqlServerTransactionsByTraceId.set(transactionKey, transaction);
}

async function commitSqlServerTransaction(): Promise<void> {
  const transactionKey = resolveSqlServerTransactionKey();
  const active = sqlServerTransactionsByTraceId.get(transactionKey);
  if (!active) {
    return;
  }

  try {
    await active.commit();
  } finally {
    sqlServerTransactionsByTraceId.delete(transactionKey);
  }
}

async function rollbackSqlServerTransaction(): Promise<void> {
  const transactionKey = resolveSqlServerTransactionKey();
  const active = sqlServerTransactionsByTraceId.get(transactionKey);
  if (!active) {
    return;
  }

  try {
    await active.rollback();
  } finally {
    sqlServerTransactionsByTraceId.delete(transactionKey);
  }
}

async function connectPoolWithFallback(): Promise<sql.ConnectionPool> {
  try {
    return await connectPool(buildSqlServerConfig("literal"));
  } catch (firstError) {
    if (!env.SQL_SERVER_USER.includes("\\")) {
      throw firstError;
    }

    return connectPool(buildSqlServerConfig("domain"));
  }
}

async function connectPool(config: sql.config): Promise<sql.ConnectionPool> {
  if (pool?.connected) {
    return pool;
  }

  if (pool) {
    await pool.close().catch(() => undefined);
    pool = null;
  }

  const nextPool = new sql.ConnectionPool(config);
  pool = await nextPool.connect();
  return pool;
}

export async function refreshSqlServerHealthSnapshot(): Promise<SqlServerHealthSnapshot> {
  if (!isSqlServerActive()) {
    lastSnapshot = makeSnapshot({
      enabled: false,
      configured: isSqlServerConfigured(),
      connected: false,
      error: null
    });
    return lastSnapshot;
  }

  if (!isSqlServerConfigured()) {
    lastSnapshot = makeSnapshot({
      enabled: true,
      configured: false,
      connected: false,
      error: "SQL Server enabled but configuration is incomplete"
    });
    return lastSnapshot;
  }

  try {
    const connectedPool = await connectPool(buildSqlServerConfig("literal"));
    await connectedPool.request().query("SELECT 1 AS ok");
    lastSnapshot = makeSnapshot({
      enabled: true,
      configured: true,
      connected: true,
      error: null
    });
    return lastSnapshot;
  } catch (firstError) {
    const hasDomainStyleUser = env.SQL_SERVER_USER.includes("\\");
    if (hasDomainStyleUser) {
      try {
        const connectedPool = await connectPool(buildSqlServerConfig("domain"));
        await connectedPool.request().query("SELECT 1 AS ok");
        lastSnapshot = makeSnapshot({
          enabled: true,
          configured: true,
          connected: true,
          error: null
        });
        return lastSnapshot;
      } catch (secondError) {
        const firstMessage = toErrorMessage(firstError);
        const secondMessage = toErrorMessage(secondError);
        lastSnapshot = makeSnapshot({
          enabled: true,
          configured: true,
          connected: false,
          error: `${firstMessage} | fallback-domain: ${secondMessage}`
        });
        return lastSnapshot;
      }
    }

    const message = toErrorMessage(firstError);
    lastSnapshot = makeSnapshot({
      enabled: true,
      configured: true,
      connected: false,
      error: message
    });
    return lastSnapshot;
  }
}

function serializeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

function normalizeBigIntValue(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : value;
  }

  if (typeof value === "bigint") {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) {
      return asNumber;
    }
    return value.toString();
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const asNumber = Number(value.trim());
    if (Number.isSafeInteger(asNumber)) {
      return asNumber;
    }
  }

  return value;
}

function normalizeSqlServerRecordset(
  recordset: Record<string, unknown>[],
  columns: Record<string, { type?: { name?: string } }>
): Record<string, unknown>[] {
  if (recordset.length === 0) {
    return recordset;
  }

  const bigintColumns = new Set<string>();
  const bitColumns = new Set<string>();

  for (const [columnName, columnMeta] of Object.entries(columns)) {
    const typeName = columnMeta?.type?.name?.toLowerCase();
    if (typeName === "bigint") {
      bigintColumns.add(columnName);
      continue;
    }
    if (typeName === "bit") {
      bitColumns.add(columnName);
    }
  }

  if (bigintColumns.size === 0 && bitColumns.size === 0) {
    return recordset;
  }

  return recordset.map((row) => {
    const normalized: Record<string, unknown> = { ...row };
    for (const columnName of bigintColumns) {
      normalized[columnName] = normalizeBigIntValue(normalized[columnName]);
    }
    for (const columnName of bitColumns) {
      const value = normalized[columnName];
      if (typeof value === "boolean") {
        normalized[columnName] = value ? 1 : 0;
      }
    }
    return normalized;
  });
}

async function initializeSqlServerMirrorSchema(connectedPool: sql.ConnectionPool): Promise<void> {
  await connectedPool.request().query(`
    IF OBJECT_ID(N'dbo.training_jobs_mirror', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.training_jobs_mirror (
        id NVARCHAR(64) NOT NULL PRIMARY KEY,
        user_id NVARCHAR(64) NOT NULL,
        project_id NVARCHAR(64) NULL,
        agent_id NVARCHAR(64) NULL,
        idempotency_key NVARCHAR(120) NULL,
        mode NVARCHAR(64) NOT NULL,
        status NVARCHAR(32) NOT NULL,
        config NVARCHAR(MAX) NOT NULL,
        platform NVARCHAR(32) NOT NULL,
        logs NVARCHAR(MAX) NOT NULL,
        error_message NVARCHAR(4000) NULL,
        created_at DATETIME2(3) NOT NULL,
        updated_at DATETIME2(3) NOT NULL,
        started_at DATETIME2(3) NULL,
        finished_at DATETIME2(3) NULL,
        source_updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_training_jobs_mirror_source_updated_at DEFAULT SYSUTCDATETIME()
      );
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = N'idx_training_jobs_mirror_user_created'
        AND object_id = OBJECT_ID(N'dbo.training_jobs_mirror')
    )
    BEGIN
      CREATE INDEX idx_training_jobs_mirror_user_created
      ON dbo.training_jobs_mirror(user_id, created_at DESC);
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = N'idx_training_jobs_mirror_status_updated'
        AND object_id = OBJECT_ID(N'dbo.training_jobs_mirror')
    )
    BEGIN
      CREATE INDEX idx_training_jobs_mirror_status_updated
      ON dbo.training_jobs_mirror(status, updated_at DESC);
    END;

    IF OBJECT_ID(N'dbo.audit_logs_mirror', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.audit_logs_mirror (
        id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        user_id NVARCHAR(64) NULL,
        action NVARCHAR(255) NOT NULL,
        payload NVARCHAR(MAX) NOT NULL,
        created_at DATETIME2(3) NOT NULL
      );
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = N'idx_audit_logs_mirror_user_created'
        AND object_id = OBJECT_ID(N'dbo.audit_logs_mirror')
    )
    BEGIN
      CREATE INDEX idx_audit_logs_mirror_user_created
      ON dbo.audit_logs_mirror(user_id, created_at DESC);
    END;
  `);
}

async function ensureSqlServerPrimarySchema(connectedPool: sql.ConnectionPool): Promise<void> {
  await connectedPool.request().query(`
    IF OBJECT_ID(N'dbo.audit_logs', N'U') IS NOT NULL
    BEGIN
      IF COLUMNPROPERTY(OBJECT_ID(N'dbo.audit_logs'), 'id', 'IsIdentity') <> 1
      BEGIN
        IF OBJECT_ID(N'dbo.audit_logs__tmp', N'U') IS NOT NULL
        BEGIN
          DROP TABLE dbo.audit_logs__tmp;
        END;

        CREATE TABLE dbo.audit_logs__tmp (
          id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          user_id NVARCHAR(64) NULL,
          action NVARCHAR(255) NOT NULL,
          payload NVARCHAR(MAX) NOT NULL,
          created_at NVARCHAR(64) NOT NULL,
          prev_hash NVARCHAR(255) NULL,
          entry_hash NVARCHAR(255) NULL
        );

        SET IDENTITY_INSERT dbo.audit_logs__tmp ON;

        INSERT INTO dbo.audit_logs__tmp (id, user_id, action, payload, created_at, prev_hash, entry_hash)
        SELECT
          TRY_CAST(id AS BIGINT),
          TRY_CAST(user_id AS NVARCHAR(64)),
          TRY_CAST(action AS NVARCHAR(255)),
          TRY_CAST(payload AS NVARCHAR(MAX)),
          TRY_CAST(created_at AS NVARCHAR(64)),
          TRY_CAST(prev_hash AS NVARCHAR(255)),
          TRY_CAST(entry_hash AS NVARCHAR(255))
        FROM dbo.audit_logs
        WHERE TRY_CAST(id AS BIGINT) IS NOT NULL;

        SET IDENTITY_INSERT dbo.audit_logs__tmp OFF;

        DROP TABLE dbo.audit_logs;
        EXEC sp_rename 'dbo.audit_logs__tmp', 'audit_logs';

        IF NOT EXISTS (
          SELECT 1
          FROM sys.indexes
          WHERE name = N'idx_audit_logs_user_created'
            AND object_id = OBJECT_ID(N'dbo.audit_logs')
        )
        BEGIN
          CREATE INDEX idx_audit_logs_user_created ON dbo.audit_logs(user_id, created_at DESC);
        END;

        IF NOT EXISTS (
          SELECT 1
          FROM sys.indexes
          WHERE name = N'idx_audit_logs_prev_hash'
            AND object_id = OBJECT_ID(N'dbo.audit_logs')
        )
        BEGIN
          CREATE INDEX idx_audit_logs_prev_hash ON dbo.audit_logs(prev_hash);
        END;

        IF NOT EXISTS (
          SELECT 1
          FROM sys.indexes
          WHERE name = N'idx_audit_logs_entry_hash_unique'
            AND object_id = OBJECT_ID(N'dbo.audit_logs')
        )
        BEGIN
          CREATE UNIQUE INDEX idx_audit_logs_entry_hash_unique ON dbo.audit_logs(entry_hash) WHERE entry_hash IS NOT NULL;
        END;
      END;
    END;

    IF OBJECT_ID(N'dbo.mcp_hybrid_toggles', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.mcp_hybrid_toggles (
        user_id NVARCHAR(64) NOT NULL PRIMARY KEY,
        local_engine_enabled BIT NOT NULL CONSTRAINT DF_mcp_hybrid_toggles_local_engine_enabled DEFAULT 1,
        api_engine_enabled BIT NOT NULL CONSTRAINT DF_mcp_hybrid_toggles_api_engine_enabled DEFAULT 1,
        prefer_local_over_api BIT NOT NULL CONSTRAINT DF_mcp_hybrid_toggles_prefer_local_over_api DEFAULT 1,
        providers_json NVARCHAR(MAX) NOT NULL CONSTRAINT DF_mcp_hybrid_toggles_providers_json DEFAULT N'{}',
        created_at NVARCHAR(64) NOT NULL,
        updated_at NVARCHAR(64) NOT NULL
      );
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = N'idx_mcp_hybrid_toggles_updated'
        AND object_id = OBJECT_ID(N'dbo.mcp_hybrid_toggles')
    )
    BEGIN
      CREATE INDEX idx_mcp_hybrid_toggles_updated
      ON dbo.mcp_hybrid_toggles(updated_at DESC);
    END;

    IF OBJECT_ID(N'dbo.mcp_hybrid_budget_daily', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.mcp_hybrid_budget_daily (
        day_key NVARCHAR(16) NOT NULL PRIMARY KEY,
        spent_usd DECIMAL(18, 4) NOT NULL CONSTRAINT DF_mcp_hybrid_budget_daily_spent_usd DEFAULT 0,
        created_at NVARCHAR(64) NOT NULL,
        updated_at NVARCHAR(64) NOT NULL
      );
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = N'idx_mcp_hybrid_budget_daily_updated'
        AND object_id = OBJECT_ID(N'dbo.mcp_hybrid_budget_daily')
    )
    BEGIN
      CREATE INDEX idx_mcp_hybrid_budget_daily_updated
      ON dbo.mcp_hybrid_budget_daily(updated_at DESC);
    END;
  `);
}

export function isSqlServerDualWriteEnabled(): boolean {
  return env.SQL_SERVER_DUAL_WRITE && env.SQL_SERVER_ENABLED && isSqlServerConfigured();
}

export async function initSqlServerMirror(): Promise<void> {
  if (!isSqlServerDualWriteEnabled()) {
    return;
  }

  if (mirrorInitialized) {
    return;
  }

  try {
    const connectedPool = await connectPoolWithFallback();
    await initializeSqlServerMirrorSchema(connectedPool);
    mirrorInitialized = true;
  } catch (error) {
    console.warn(`[sql-server-mirror] ${toErrorMessage(error)}`);
  }
}

export async function mirrorAuditLogToSqlServer(input: {
  userId: string | null;
  action: string;
  payload: unknown;
  createdAt: string;
}): Promise<void> {
  if (!isSqlServerDualWriteEnabled()) {
    return;
  }

  await initSqlServerMirror();
  if (!mirrorInitialized) {
    throw new Error("SQL Server mirror schema is not initialized");
  }

  const connectedPool = await connectPoolWithFallback();
  const request = connectedPool.request();
  request.input("userId", sql.NVarChar(64), input.userId);
  request.input("action", sql.NVarChar(255), input.action);
  request.input("payload", sql.NVarChar(sql.MAX), serializeJson(input.payload));
  request.input("createdAt", sql.NVarChar(40), input.createdAt);
  await request.query(`
    INSERT INTO dbo.audit_logs_mirror (user_id, action, payload, created_at)
    VALUES (@userId, @action, @payload, CAST(@createdAt AS DATETIME2(3)))
  `);
}

export async function mirrorTrainingJobToSqlServer(input: TrainingJobMirrorInput): Promise<void> {
  if (!isSqlServerDualWriteEnabled()) {
    return;
  }

  await initSqlServerMirror();
  if (!mirrorInitialized) {
    throw new Error("SQL Server mirror schema is not initialized");
  }

  const connectedPool = await connectPoolWithFallback();
  const request = connectedPool.request();
  request.input("id", sql.NVarChar(64), input.id);
  request.input("userId", sql.NVarChar(64), input.userId);
  request.input("projectId", sql.NVarChar(64), input.projectId);
  request.input("agentId", sql.NVarChar(64), input.agentId);
  request.input("idempotencyKey", sql.NVarChar(120), input.idempotencyKey);
  request.input("mode", sql.NVarChar(64), input.mode);
  request.input("status", sql.NVarChar(32), input.status);
  request.input("configJson", sql.NVarChar(sql.MAX), serializeJson(input.config));
  request.input("platform", sql.NVarChar(32), input.platform);
  request.input("logsJson", sql.NVarChar(sql.MAX), serializeJson(input.logs));
  request.input("errorMessage", sql.NVarChar(4000), input.errorMessage);
  request.input("createdAt", sql.NVarChar(40), input.createdAt);
  request.input("updatedAt", sql.NVarChar(40), input.updatedAt);
  request.input("startedAt", sql.NVarChar(40), input.startedAt);
  request.input("finishedAt", sql.NVarChar(40), input.finishedAt);

  await request.query(`
    UPDATE dbo.training_jobs_mirror
    SET
      user_id = @userId,
      project_id = @projectId,
      agent_id = @agentId,
      idempotency_key = @idempotencyKey,
      mode = @mode,
      status = @status,
      config = @configJson,
      platform = @platform,
      logs = @logsJson,
      error_message = @errorMessage,
      created_at = CAST(@createdAt AS DATETIME2(3)),
      updated_at = CAST(@updatedAt AS DATETIME2(3)),
      started_at = CAST(@startedAt AS DATETIME2(3)),
      finished_at = CAST(@finishedAt AS DATETIME2(3)),
      source_updated_at = SYSUTCDATETIME()
    WHERE id = @id;

    IF @@ROWCOUNT = 0
    BEGIN
      INSERT INTO dbo.training_jobs_mirror (
        id, user_id, project_id, agent_id, idempotency_key, mode, status, config, platform, logs,
        error_message, created_at, updated_at, started_at, finished_at, source_updated_at
      )
      VALUES (
        @id, @userId, @projectId, @agentId, @idempotencyKey, @mode, @status, @configJson, @platform, @logsJson,
        @errorMessage, CAST(@createdAt AS DATETIME2(3)), CAST(@updatedAt AS DATETIME2(3)),
        CAST(@startedAt AS DATETIME2(3)), CAST(@finishedAt AS DATETIME2(3)), SYSUTCDATETIME()
      );
    END;
  `);
}

export async function executeSqlServerQuery(query: string, params: Array<string | number | null> = []): Promise<{
  recordset: Record<string, unknown>[];
  rowsAffected: number[];
}> {
  const command = normalizeTransactionCommand(query);
  if (params.length === 0 && (command === "BEGIN" || command === "BEGIN TRANSACTION")) {
    await beginSqlServerTransaction();
    return { recordset: [], rowsAffected: [] };
  }

  if (params.length === 0 && (command === "COMMIT" || command === "COMMIT TRANSACTION")) {
    await commitSqlServerTransaction();
    return { recordset: [], rowsAffected: [] };
  }

  if (params.length === 0 && (command === "ROLLBACK" || command === "ROLLBACK TRANSACTION")) {
    await rollbackSqlServerTransaction();
    return { recordset: [], rowsAffected: [] };
  }

  const connectedPool = await connectPoolWithFallback();
  const activeTransaction = getActiveSqlServerTransaction();
  const request = activeTransaction ? new sql.Request(activeTransaction) : connectedPool.request();

  for (let index = 0; index < params.length; index += 1) {
    const name = `p${index + 1}`;
    const value = params[index];
    if (typeof value === "string") {
      if (value.length > 4000) {
        request.input(name, sql.NVarChar(sql.MAX), value);
      } else {
        request.input(name, sql.NVarChar(Math.max(1, value.length)), value);
      }
      continue;
    }

    request.input(name, value);
  }

  const result = await request.query(query);
  const rawRecordset = (result.recordset ?? []) as Record<string, unknown>[];
  const normalizedRecordset = normalizeSqlServerRecordset(
    rawRecordset,
    ((result.recordset as { columns?: Record<string, { type?: { name?: string } }> } | undefined)?.columns ?? {}) as Record<
      string,
      { type?: { name?: string } }
    >
  );
  return {
    recordset: normalizedRecordset,
    rowsAffected: result.rowsAffected ?? []
  };
}

export function getSqlServerHealthSnapshot(): SqlServerHealthSnapshot {
  return lastSnapshot;
}

export async function initSqlServerConnection(): Promise<void> {
  const snapshot = await refreshSqlServerHealthSnapshot();
  if (snapshot.connected && env.DB_ENGINE === "sqlserver") {
    try {
      const connectedPool = await connectPoolWithFallback();
      await ensureSqlServerPrimarySchema(connectedPool);
    } catch (error) {
      console.warn(`[sql-server-schema] ${toErrorMessage(error)}`);
    }
  }

  if (snapshot.enabled && !snapshot.connected) {
    console.warn(`[sql-server] ${snapshot.error ?? "connection unavailable"}`);
  }
}

export async function closeSqlServerConnection(): Promise<void> {
  const activeTransactions = Array.from(sqlServerTransactionsByTraceId.values());
  sqlServerTransactionsByTraceId.clear();
  await Promise.all(activeTransactions.map((transaction) => transaction.rollback().catch(() => undefined)));

  if (pool) {
    await pool.close().catch(() => undefined);
    pool = null;
  }

  mirrorInitialized = false;
  lastSnapshot = makeSnapshot({
    enabled: env.SQL_SERVER_ENABLED,
    configured: isSqlServerConfigured(),
    connected: false,
    error: null
  });
}
