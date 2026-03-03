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
      `[${scriptName}] blocked: cleanup allowed only on isolated test DBs (for example 'rey30_test'). ` +
        "To override intentionally: set ALLOW_DESTRUCTIVE_SQLSERVER_SCRIPTS=true and pass --force."
    );
  }
}

async function main() {
  const database = (process.env.SQL_SERVER_DATABASE || process.env.SQL_DATABASE || "master").trim();
  assertSafeDestructiveTarget(database, "sqlserver-clean-card-domain");

  const config = {
    server: (process.env.SQL_SERVER_HOST || process.env.SQL_HOST || "127.0.0.1").trim(),
    database,
    user: (process.env.SQL_SERVER_USER || process.env.SQL_USER || "").trim(),
    password: (process.env.SQL_SERVER_PASSWORD || process.env.SQL_PASSWORD || "").trim(),
    options: {
      encrypt: parseBoolean(process.env.SQL_SERVER_ENCRYPT, false),
      trustServerCertificate: parseBoolean(process.env.SQL_SERVER_TRUST_SERVER_CERTIFICATE, true),
      enableArithAbort: true
    },
    pool: {
      max: 2,
      min: 0,
      idleTimeoutMillis: 30_000
    },
    connectionTimeout: 10_000,
    requestTimeout: 30_000
  };

  if (!config.user || !config.password) {
    throw new Error("Missing SQL Server credentials. Set SQL_SERVER_USER and SQL_SERVER_PASSWORD.");
  }

  const pool = await new sql.ConnectionPool(config).connect();
  try {
    await pool.request().query(`
      DELETE FROM dbo.licenses;
      DELETE FROM dbo.market_listings;
      DELETE FROM dbo.inventory;
      DELETE FROM dbo.card_versions;
      DELETE FROM dbo.card_drafts;
      DELETE FROM dbo.cards;
    `);
    console.log("[sqlserver-clean] card domain tables cleaned");
  } finally {
    await pool.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("[sqlserver-clean] failed", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
