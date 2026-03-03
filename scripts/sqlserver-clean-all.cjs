#!/usr/bin/env node
/* eslint-disable no-console */
require("dotenv").config();

const sql = require("mssql");

function parseBoolean(value, fallback = false) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function hasForceOverride() {
  return process.argv.includes("--force") && parseBoolean(process.env.ALLOW_DESTRUCTIVE_SQLSERVER_SCRIPTS, false);
}

function assertSafeDestructiveTarget(database, scriptName) {
  const normalized = String(database || "").trim().toLowerCase();
  const isSystemDb = ["master", "msdb", "model", "tempdb"].includes(normalized);
  const isLikelyTestDb = normalized.startsWith("rey30_") || normalized.endsWith("_test");

  if (isSystemDb && !hasForceOverride()) {
    throw new Error(
      `[${scriptName}] blocked: refusing to run on system database '${database}'. ` +
        "Use a dedicated test DB. To override intentionally: set ALLOW_DESTRUCTIVE_SQLSERVER_SCRIPTS=true and pass --force."
    );
  }

  if (!isLikelyTestDb && !hasForceOverride()) {
    throw new Error(
      `[${scriptName}] blocked: destructive cleanup allowed only on isolated test DBs (for example 'rey30_test'). ` +
        "To override intentionally: set ALLOW_DESTRUCTIVE_SQLSERVER_SCRIPTS=true and pass --force."
    );
  }
}

function buildSqlServerConfig() {
  const host = (process.env.SQL_SERVER_HOST || process.env.SQL_HOST || "").trim();
  const database = (process.env.SQL_SERVER_DATABASE || process.env.SQL_DATABASE || "").trim();
  const user = (process.env.SQL_SERVER_USER || process.env.SQL_USER || "").trim();
  const password = (process.env.SQL_SERVER_PASSWORD || process.env.SQL_PASSWORD || "").trim();
  const instance = (process.env.SQL_SERVER_INSTANCE || process.env.SQL_INSTANCE || "").trim();
  const port = Number(process.env.SQL_SERVER_PORT || 1433);
  const encrypt = parseBoolean(process.env.SQL_SERVER_ENCRYPT, false);
  const trustServerCertificate = parseBoolean(process.env.SQL_SERVER_TRUST_SERVER_CERTIFICATE, true);

  if (!host || !database || !user || !password) {
    throw new Error("Missing SQL Server env vars for cleanup");
  }

  assertSafeDestructiveTarget(database, "sqlserver-clean-all");

  const options = {
    encrypt,
    trustServerCertificate,
    enableArithAbort: true
  };
  if (instance.length > 0) {
    options.instanceName = instance;
  }

  return {
    server: host,
    database,
    user,
    password,
    port: instance.length > 0 ? undefined : (Number.isFinite(port) ? port : 1433),
    connectionTimeout: 10_000,
    requestTimeout: 60_000,
    pool: {
      max: 2,
      min: 0,
      idleTimeoutMillis: 15_000
    },
    options
  };
}

async function main() {
  const pool = await new sql.ConnectionPool(buildSqlServerConfig()).connect();
  try {
    await pool.request().query(`
      DECLARE @sql NVARCHAR(MAX) = N'';
      SELECT @sql = @sql + N'ALTER TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N' NOCHECK CONSTRAINT ALL;'
      FROM sys.tables t
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE t.is_ms_shipped = 0;
      EXEC sp_executesql @sql;

      SET @sql = N'';
      SELECT @sql = @sql + N'DELETE FROM ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N';'
      FROM sys.tables t
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE t.is_ms_shipped = 0;
      EXEC sp_executesql @sql;

      SET @sql = N'';
      SELECT @sql = @sql + N'ALTER TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N' WITH CHECK CHECK CONSTRAINT ALL;'
      FROM sys.tables t
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE t.is_ms_shipped = 0;
      EXEC sp_executesql @sql;
    `);

    console.log("[sqlserver-clean] all tables cleaned");
  } finally {
    await pool.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("[sqlserver-clean] failed", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
