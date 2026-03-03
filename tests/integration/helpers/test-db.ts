import { randomUUID } from "node:crypto";
import sqlite3 from "sqlite3";
import sql from "mssql";
import dotenv from "dotenv";

dotenv.config();

type TestSqlValue = string | number | null;

type SqlServerIdentity = {
  user: string;
  domain?: string;
};

export function isSqlServerPrimaryForTests(): boolean {
  return (process.env.DB_ENGINE ?? "").trim().toLowerCase() === "sqlserver";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
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

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }

  const rounded = Math.trunc(n);
  return Math.min(max, Math.max(min, rounded));
}

function resolveSqlServerIdentity(rawUser: string, mode: "literal" | "domain"): SqlServerIdentity {
  if (mode === "literal") {
    return { user: rawUser };
  }

  const separatorIndex = rawUser.indexOf("\\");
  if (separatorIndex <= 0 || separatorIndex >= rawUser.length - 1) {
    return { user: rawUser };
  }

  const domain = rawUser.slice(0, separatorIndex).trim();
  const user = rawUser.slice(separatorIndex + 1).trim();
  if (domain.length === 0 || user.length === 0) {
    return { user: rawUser };
  }

  return { user, domain };
}

function buildSqlServerConfig(mode: "literal" | "domain"): sql.config {
  const host = (process.env.SQL_SERVER_HOST ?? process.env.SQL_HOST ?? "127.0.0.1").trim();
  const database = (process.env.SQL_SERVER_DATABASE ?? process.env.SQL_DATABASE ?? "master").trim();
  const userRaw = (process.env.SQL_SERVER_USER ?? process.env.SQL_USER ?? "").trim();
  const password = (process.env.SQL_SERVER_PASSWORD ?? process.env.SQL_PASSWORD ?? "").trim();
  const instance = (process.env.SQL_SERVER_INSTANCE ?? process.env.SQL_INSTANCE ?? "").trim();

  if (!host || !database || !userRaw || !password) {
    throw new Error("SQL Server env missing: SQL_SERVER_HOST, SQL_SERVER_DATABASE, SQL_SERVER_USER, SQL_SERVER_PASSWORD");
  }

  const identity = resolveSqlServerIdentity(userRaw, mode);
  const port = parseInteger(process.env.SQL_SERVER_PORT, 1433, 1, 65535);
  const connectTimeoutMs = parseInteger(process.env.SQL_SERVER_CONNECT_TIMEOUT_MS, 5000, 200, 120_000);
  const requestTimeoutMs = parseInteger(process.env.SQL_SERVER_REQUEST_TIMEOUT_MS, 15_000, 200, 120_000);
  const encrypt = parseBoolean(process.env.SQL_SERVER_ENCRYPT, false);
  const trustServerCertificate = parseBoolean(process.env.SQL_SERVER_TRUST_SERVER_CERTIFICATE, true);

  const options: sql.IOptions = {
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
    user: identity.user,
    domain: identity.domain,
    password,
    port: instance.length > 0 ? undefined : port,
    connectionTimeout: connectTimeoutMs,
    requestTimeout: requestTimeoutMs,
    pool: {
      max: 4,
      min: 0,
      idleTimeoutMillis: 30_000
    },
    options
  };
}

async function createSqlServerPool(): Promise<sql.ConnectionPool> {
  try {
    return await new sql.ConnectionPool(buildSqlServerConfig("literal")).connect();
  } catch (firstError) {
    const rawUser = (process.env.SQL_SERVER_USER ?? process.env.SQL_USER ?? "").trim();
    if (!rawUser.includes("\\")) {
      throw firstError;
    }

    return new sql.ConnectionPool(buildSqlServerConfig("domain")).connect();
  }
}

async function withSqlServerPool<T>(fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const pool = await createSqlServerPool();
  try {
    return await fn(pool);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

function toSqlServerQuery(query: string, params: TestSqlValue[]): string {
  let placeholderCount = 0;
  const translated = query.replace(/\?/g, () => {
    placeholderCount += 1;
    return `@p${placeholderCount}`;
  });

  if (placeholderCount !== params.length) {
    throw new Error(`SQL param mismatch in test helper: expected ${placeholderCount}, received ${params.length}`);
  }

  return translated;
}

async function sqlServerGet<T>(query: string, params: TestSqlValue[] = []): Promise<T | undefined> {
  return withSqlServerPool(async (pool) => {
    const request = pool.request();
    for (let index = 0; index < params.length; index += 1) {
      request.input(`p${index + 1}`, params[index]);
    }

    const translatedQuery = toSqlServerQuery(query, params);
    const result = await request.query(translatedQuery);
    return (result.recordset?.[0] as T | undefined) ?? undefined;
  });
}

async function sqlServerRun(query: string, params: TestSqlValue[] = []): Promise<void> {
  await withSqlServerPool(async (pool) => {
    const request = pool.request();
    for (let index = 0; index < params.length; index += 1) {
      request.input(`p${index + 1}`, params[index]);
    }

    const translatedQuery = toSqlServerQuery(query, params);
    await request.query(translatedQuery);
  });
}

function sqliteGet<T>(filePath: string, query: string, params: TestSqlValue[] = []): Promise<T | undefined> {
  const sqlite = sqlite3.verbose();
  const db = new sqlite.Database(filePath);
  return new Promise<T | undefined>((resolve, reject) => {
    db.get(query, params, (error, row) => {
      db.close(() => undefined);
      if (error) {
        reject(error);
        return;
      }
      resolve(row as T | undefined);
    });
  });
}

function sqliteRun(filePath: string, query: string, params: TestSqlValue[] = []): Promise<void> {
  const sqlite = sqlite3.verbose();
  const db = new sqlite.Database(filePath);
  return new Promise<void>((resolve, reject) => {
    db.run(query, params, (error) => {
      db.close(() => undefined);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function getRowForTest<T>(filePath: string, query: string, params: TestSqlValue[] = []): Promise<T | undefined> {
  if (isSqlServerPrimaryForTests()) {
    return sqlServerGet<T>(query, params);
  }

  return sqliteGet<T>(filePath, query, params);
}

export async function runStatementForTest(filePath: string, query: string, params: TestSqlValue[] = []): Promise<void> {
  if (isSqlServerPrimaryForTests()) {
    await sqlServerRun(query, params);
    return;
  }

  await sqliteRun(filePath, query, params);
}

export async function grantAdminRoleForTest(filePath: string, userId: string): Promise<void> {
  if (isSqlServerPrimaryForTests()) {
    const adminRole = await sqlServerGet<{ id: string }>("SELECT TOP 1 id FROM roles WHERE [key] = 'admin'");
    if (!adminRole?.id) {
      throw new Error("Admin role not found in SQL Server");
    }

    await sqlServerRun(
      `
        IF NOT EXISTS (
          SELECT 1
          FROM user_roles
          WHERE user_id = ? AND role_id = ?
        )
        BEGIN
          INSERT INTO user_roles (id, user_id, role_id, assigned_by, created_at)
          VALUES (?, ?, ?, NULL, ?);
        END
      `,
      [userId, adminRole.id, randomUUID(), userId, adminRole.id, new Date().toISOString()]
    );
    await sqlServerRun("UPDATE users SET role = 'admin' WHERE id = ?", [userId]);
    return;
  }

  const adminRole = await sqliteGet<{ id: string }>(filePath, "SELECT id FROM roles WHERE key = 'admin'");
  if (!adminRole?.id) {
    throw new Error("Admin role not found in SQLite");
  }

  await sqliteRun(
    filePath,
    `
      INSERT OR IGNORE INTO user_roles (id, user_id, role_id, assigned_by, created_at)
      VALUES (?, ?, ?, NULL, ?)
    `,
    [randomUUID(), userId, adminRole.id, new Date().toISOString()]
  );
  await sqliteRun(filePath, "UPDATE users SET role = 'admin' WHERE id = ?", [userId]);
}
