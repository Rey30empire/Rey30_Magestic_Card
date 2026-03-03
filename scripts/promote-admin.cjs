#!/usr/bin/env node
/* eslint-disable no-console */
const path = require("node:path");
const sql = require("mssql");
const sqlite3 = require("sqlite3");
const dotenv = require("dotenv");

dotenv.config();

function toBool(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "n"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function toInt(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const rounded = Math.trunc(numeric);
  return Math.min(max, Math.max(min, rounded));
}

function resolveDbEngine() {
  const raw = (process.env.DB_ENGINE || "sqlserver").trim().toLowerCase();
  if (raw === "sqlite" || raw === "sqlserver") {
    return raw;
  }
  return "sqlserver";
}

function resolveSqlServerConfig(mode) {
  const host = (process.env.SQL_SERVER_HOST || process.env.SQL_HOST || "").trim();
  const database = (process.env.SQL_SERVER_DATABASE || process.env.SQL_DATABASE || "").trim();
  const rawUser = (process.env.SQL_SERVER_USER || process.env.SQL_USER || "").trim();
  const password = (process.env.SQL_SERVER_PASSWORD || process.env.SQL_PASSWORD || "").trim();
  const instance = (process.env.SQL_SERVER_INSTANCE || process.env.SQL_INSTANCE || "").trim();
  const port = toInt(process.env.SQL_SERVER_PORT, 1433, 1, 65535);
  const connectTimeoutMs = toInt(process.env.SQL_SERVER_CONNECT_TIMEOUT_MS, 5_000, 200, 120_000);
  const requestTimeoutMs = toInt(process.env.SQL_SERVER_REQUEST_TIMEOUT_MS, 10_000, 200, 120_000);
  const poolMax = toInt(process.env.SQL_SERVER_POOL_MAX, 5, 1, 50);
  const encrypt = toBool(process.env.SQL_SERVER_ENCRYPT, false);
  const trustServerCertificate = toBool(process.env.SQL_SERVER_TRUST_SERVER_CERTIFICATE, true);

  if (!host || !database || !rawUser || !password) {
    throw new Error(
      "Missing SQL Server credentials. Set SQL_SERVER_HOST, SQL_SERVER_DATABASE, SQL_SERVER_USER and SQL_SERVER_PASSWORD."
    );
  }

  let user = rawUser;
  let domain = undefined;
  if (mode === "domain") {
    const separator = rawUser.indexOf("\\");
    if (separator > 0 && separator < rawUser.length - 1) {
      const domainPart = rawUser.slice(0, separator).trim();
      const userPart = rawUser.slice(separator + 1).trim();
      if (domainPart && userPart) {
        user = userPart;
        domain = domainPart;
      }
    }
  }

  const options = {
    encrypt,
    trustServerCertificate,
    enableArithAbort: true
  };
  if (instance) {
    options.instanceName = instance;
  }

  return {
    server: host,
    port: instance ? undefined : port,
    database,
    user,
    domain,
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

async function withSqlServerPool(fn) {
  let pool = null;
  let firstError = null;
  try {
    pool = await sql.connect(resolveSqlServerConfig("literal"));
  } catch (error) {
    firstError = error;
  }

  if (!pool) {
    const rawUser = (process.env.SQL_SERVER_USER || process.env.SQL_USER || "").trim();
    if (!rawUser.includes("\\")) {
      throw firstError;
    }
    pool = await sql.connect(resolveSqlServerConfig("domain"));
  }

  try {
    return await fn(pool);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

async function promoteAdminSqlServer(userId) {
  await withSqlServerPool(async (pool) => {
    const roleResult = await pool.request().query("SELECT TOP 1 id FROM roles WHERE [key] = 'admin'");
    const roleId = roleResult.recordset?.[0]?.id;
    if (!roleId) {
      throw new Error("admin role not found");
    }

    await pool.request().input("userId", userId).query("UPDATE users SET role = 'admin' WHERE id = @userId");

    await pool
      .request()
      .input("userId", userId)
      .input("roleId", roleId)
      .query(`
        IF NOT EXISTS (
          SELECT 1 FROM user_roles WHERE user_id = @userId AND role_id = @roleId
        )
        BEGIN
          INSERT INTO user_roles (id, user_id, role_id, assigned_by, created_at)
          VALUES (LOWER(REPLACE(CONVERT(VARCHAR(36), NEWID()), '-', '')), @userId, @roleId, NULL, SYSUTCDATETIME());
        END
      `);
  });
}

function promoteAdminSqlite(userId) {
  const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || "data/rey30.db");
  const sqlite = sqlite3.verbose();
  const db = new sqlite.Database(dbPath);
  const now = new Date().toISOString();

  return new Promise((resolve, reject) => {
    function fail(error) {
      db.close(() => reject(error));
    }

    db.serialize(() => {
      db.get("SELECT id FROM roles WHERE key = 'admin'", (error, roleRow) => {
        if (error) {
          fail(error);
          return;
        }
        if (!roleRow || !roleRow.id) {
          fail(new Error("admin role not found"));
          return;
        }

        db.run("UPDATE users SET role = 'admin' WHERE id = ?", [userId], (error2) => {
          if (error2) {
            fail(error2);
            return;
          }

          db.run(
            "INSERT OR IGNORE INTO user_roles (id, user_id, role_id, assigned_by, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, NULL, ?)",
            [userId, roleRow.id, now],
            (error3) => {
              if (error3) {
                fail(error3);
                return;
              }

              db.close((closeError) => {
                if (closeError) {
                  reject(closeError);
                  return;
                }
                resolve();
              });
            }
          );
        });
      });
    });
  });
}

async function main() {
  const userId = (process.argv[2] || "").trim();
  if (!userId) {
    throw new Error("Usage: node scripts/promote-admin.cjs <userId>");
  }

  const dbEngine = resolveDbEngine();
  if (dbEngine === "sqlserver") {
    await promoteAdminSqlServer(userId);
  } else {
    await promoteAdminSqlite(userId);
  }

  console.log("PROMOTED_ADMIN");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

