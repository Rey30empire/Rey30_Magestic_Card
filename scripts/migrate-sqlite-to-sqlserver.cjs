#!/usr/bin/env node
/* eslint-disable no-console */
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const sqlite3 = require("sqlite3");
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
  const isLikelyMigrationDb = normalized.startsWith("rey30_") || normalized.endsWith("_test");

  if (isSystemDb && !hasForceOverride()) {
    throw new Error(
      `[${scriptName}] blocked: refusing to run migration on system database '${database}'. ` +
        "Use a dedicated target DB. To override intentionally: set ALLOW_DESTRUCTIVE_SQLSERVER_SCRIPTS=true and pass --force."
    );
  }

  if (!isLikelyMigrationDb && !hasForceOverride()) {
    throw new Error(
      `[${scriptName}] blocked: migration drops/recreates tables and is allowed only on isolated DBs (for example 'rey30_test'). ` +
        "To override intentionally: set ALLOW_DESTRUCTIVE_SQLSERVER_SCRIPTS=true and pass --force."
    );
  }
}

function sanitizeInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  const rounded = Math.trunc(n);
  return Math.min(max, Math.max(min, rounded));
}

function quoteSqliteIdentifier(name) {
  return `"${String(name).replace(/"/g, "\"\"")}"`;
}

function quoteSqliteString(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function quoteTsqlIdentifier(name) {
  return `[${String(name).replace(/]/g, "]]")}]`;
}

function buildSqlServerConfig() {
  const host = (process.env.SQL_SERVER_HOST || process.env.SQL_HOST || "127.0.0.1").trim();
  const database = (process.env.SQL_SERVER_DATABASE || process.env.SQL_DATABASE || "master").trim();
  const user = (process.env.SQL_SERVER_USER || process.env.SQL_USER || "").trim();
  const password = (process.env.SQL_SERVER_PASSWORD || process.env.SQL_PASSWORD || "").trim();
  const instance = (process.env.SQL_SERVER_INSTANCE || process.env.SQL_INSTANCE || "").trim();
  const port = sanitizeInteger(process.env.SQL_SERVER_PORT, 1433, 1, 65535);
  const connectTimeoutMs = sanitizeInteger(process.env.SQL_SERVER_CONNECT_TIMEOUT_MS, 10_000, 500, 120_000);
  const requestTimeoutMs = sanitizeInteger(process.env.SQL_SERVER_REQUEST_TIMEOUT_MS, 30_000, 500, 120_000);
  const poolMax = sanitizeInteger(process.env.SQL_SERVER_POOL_MAX, 5, 1, 50);
  const encrypt = parseBoolean(process.env.SQL_SERVER_ENCRYPT, false);
  const trustServerCertificate = parseBoolean(process.env.SQL_SERVER_TRUST_SERVER_CERTIFICATE, true);

  if (!host || !database || !user || !password) {
    throw new Error("SQL Server config missing. Required: SQL_SERVER_HOST, SQL_SERVER_DATABASE, SQL_SERVER_USER, SQL_SERVER_PASSWORD");
  }

  assertSafeDestructiveTarget(database, "migrate-sqlite-to-sqlserver");

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
    port: instance.length > 0 ? undefined : port,
    database,
    user,
    password,
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

function openSqliteDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(db);
    });
  });
}

function sqliteAll(db, query) {
  return new Promise((resolve, reject) => {
    db.all(query, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

function sqliteClose(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function inferTargetType(declaredType, isPk) {
  const t = String(declaredType || "").trim().toUpperCase();

  if (t.includes("INT")) {
    return "BIGINT";
  }
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) {
    return "FLOAT";
  }
  if (t.includes("NUMERIC") || t.includes("DECIMAL")) {
    return "DECIMAL(38, 10)";
  }
  if (t.includes("BOOL")) {
    return "BIT";
  }
  if (t.includes("BLOB")) {
    return "VARBINARY(MAX)";
  }
  if (t.includes("DATE") || t.includes("TIME")) {
    return "NVARCHAR(64)";
  }
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT") || t.length === 0) {
    return isPk ? "NVARCHAR(450)" : "NVARCHAR(MAX)";
  }

  return isPk ? "NVARCHAR(450)" : "NVARCHAR(MAX)";
}

function buildCreateTableSql(tableName, columns) {
  const table = quoteTsqlIdentifier(tableName);
  const columnDefs = [];
  const pkColumns = columns
    .filter((col) => Number(col.pk || 0) > 0)
    .sort((a, b) => Number(a.pk || 0) - Number(b.pk || 0));

  for (const col of columns) {
    const isPk = Number(col.pk || 0) > 0;
    const type = inferTargetType(col.type, isPk);
    const nullable = Number(col.notnull || 0) === 1 || isPk ? "NOT NULL" : "NULL";
    columnDefs.push(`${quoteTsqlIdentifier(col.name)} ${type} ${nullable}`);
  }

  if (pkColumns.length > 0) {
    const pkName = `PK_${String(tableName).replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 120);
    const pkCols = pkColumns.map((col) => quoteTsqlIdentifier(col.name)).join(", ");
    columnDefs.push(`CONSTRAINT ${quoteTsqlIdentifier(pkName)} PRIMARY KEY (${pkCols})`);
  }

  return `
IF OBJECT_ID(N'dbo.${String(tableName).replace(/'/g, "''")}', N'U') IS NOT NULL
BEGIN
  DROP TABLE dbo.${table};
END;

CREATE TABLE dbo.${table} (
  ${columnDefs.join(",\n  ")}
);
`;
}

function escapeUnicodeString(value) {
  return `N'${String(value).replace(/'/g, "''")}'`;
}

function toSqlLiteral(value, targetType) {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (Buffer.isBuffer(value)) {
    return `0x${value.toString("hex")}`;
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  if (targetType === "BIGINT") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(Math.trunc(value));
    }
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      return value.trim();
    }
    return "NULL";
  }

  if (targetType === "FLOAT" || targetType.startsWith("DECIMAL")) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
      return value.trim();
    }
    return "NULL";
  }

  if (targetType === "BIT") {
    if (typeof value === "number") {
      return value === 0 ? "0" : "1";
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "y", "on"].includes(normalized)) {
        return "1";
      }
      if (["0", "false", "no", "n", "off"].includes(normalized)) {
        return "0";
      }
    }
    return "NULL";
  }

  if (targetType === "VARBINARY(MAX)" && typeof value === "string") {
    if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
      return `0x${value}`;
    }
    return "NULL";
  }

  return escapeUnicodeString(value);
}

async function main() {
  const sqlitePath = path.resolve(process.cwd(), process.env.DB_PATH || "./data/rey30.db");
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite DB not found at ${sqlitePath}`);
  }

  const sqliteDb = await openSqliteDatabase(sqlitePath);
  let sqlPool = null;

  try {
    const sqlConfig = buildSqlServerConfig();
    sqlPool = await new sql.ConnectionPool(sqlConfig).connect();

    const tableRows = await sqliteAll(
      sqliteDb,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
    );

    const results = [];
    let totalRows = 0;

    for (const tableRow of tableRows) {
      const tableName = tableRow.name;
      const pragmaQuery = `PRAGMA table_info(${quoteSqliteString(tableName)})`;
      const columns = await sqliteAll(sqliteDb, pragmaQuery);

      if (!Array.isArray(columns) || columns.length === 0) {
        results.push({ table: tableName, rows: 0, skipped: true });
        continue;
      }

      const createSql = buildCreateTableSql(tableName, columns);
      await sqlPool.request().query(createSql);

      const selectSql = `SELECT * FROM ${quoteSqliteIdentifier(tableName)}`;
      const rows = await sqliteAll(sqliteDb, selectSql);
      const targetTypes = new Map(columns.map((col) => [col.name, inferTargetType(col.type, Number(col.pk || 0) > 0)]));
      const columnList = columns.map((col) => quoteTsqlIdentifier(col.name)).join(", ");
      const tableId = quoteTsqlIdentifier(tableName);

      for (const row of rows) {
        const values = columns
          .map((col) => toSqlLiteral(row[col.name], targetTypes.get(col.name)))
          .join(", ");
        const insertSql = `INSERT INTO dbo.${tableId} (${columnList}) VALUES (${values});`;
        await sqlPool.request().query(insertSql);
      }

      results.push({ table: tableName, rows: rows.length, skipped: false });
      totalRows += rows.length;
      console.log(`[migrate] ${tableName}: ${rows.length} rows`);
    }

    console.log(`[migrate] tables=${results.length} rows=${totalRows} sqlite=${sqlitePath}`);
    console.log("[migrate] done");
  } finally {
    await sqliteClose(sqliteDb).catch(() => undefined);
    if (sqlPool) {
      await sqlPool.close().catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error("[migrate] failed", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
