import { Pool } from "pg";
import { env } from "../config/env";

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

let pool: Pool | null = null;
let initialized = false;

function isPostgresConfigured(): boolean {
  return Boolean(env.POSTGRES_URL && env.POSTGRES_URL.trim().length > 0);
}

export function isPostgresDualWriteEnabled(): boolean {
  return env.POSTGRES_DUAL_WRITE && isPostgresConfigured();
}

function getPool(): Pool {
  if (!pool) {
    if (!isPostgresConfigured()) {
      throw new Error("POSTGRES_URL is not configured");
    }

    pool = new Pool({
      connectionString: env.POSTGRES_URL,
      max: Math.max(1, env.POSTGRES_POOL_MAX)
    });
  }

  return pool;
}

async function initializeSchema(): Promise<void> {
  const client = getPool();
  await client.query(`
    CREATE TABLE IF NOT EXISTS training_jobs_mirror (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      agent_id TEXT,
      idempotency_key TEXT,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      config JSONB NOT NULL,
      platform TEXT NOT NULL,
      logs JSONB NOT NULL,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      source_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query("ALTER TABLE training_jobs_mirror ADD COLUMN IF NOT EXISTS idempotency_key TEXT;");
  await client.query("CREATE INDEX IF NOT EXISTS idx_training_jobs_mirror_user_created ON training_jobs_mirror(user_id, created_at DESC);");
  await client.query("CREATE INDEX IF NOT EXISTS idx_training_jobs_mirror_status_updated ON training_jobs_mirror(status, updated_at DESC);");

  await client.query(`
    CREATE TABLE IF NOT EXISTS audit_logs_mirror (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_audit_logs_mirror_user_created ON audit_logs_mirror(user_id, created_at DESC);");
}

export async function initPostgresMirror(): Promise<void> {
  if (!isPostgresDualWriteEnabled()) {
    return;
  }

  if (initialized) {
    return;
  }

  await initializeSchema();
  initialized = true;
}

export async function mirrorAuditLog(input: {
  userId: string | null;
  action: string;
  payload: unknown;
  createdAt: string;
}): Promise<void> {
  if (!isPostgresDualWriteEnabled()) {
    return;
  }

  await initPostgresMirror();
  await getPool().query(
    `
      INSERT INTO audit_logs_mirror (user_id, action, payload, created_at)
      VALUES ($1, $2, $3::jsonb, $4::timestamptz)
    `,
    [input.userId, input.action, JSON.stringify(input.payload), input.createdAt]
  );
}

export async function mirrorTrainingJob(input: TrainingJobMirrorInput): Promise<void> {
  if (!isPostgresDualWriteEnabled()) {
    return;
  }

  await initPostgresMirror();
  await getPool().query(
    `
      INSERT INTO training_jobs_mirror (
        id, user_id, project_id, agent_id, idempotency_key, mode, status, config, platform, logs,
        error_message, created_at, updated_at, started_at, finished_at, source_updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb,
        $11, $12::timestamptz, $13::timestamptz, $14::timestamptz, $15::timestamptz, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        project_id = EXCLUDED.project_id,
        agent_id = EXCLUDED.agent_id,
        idempotency_key = EXCLUDED.idempotency_key,
        mode = EXCLUDED.mode,
        status = EXCLUDED.status,
        config = EXCLUDED.config,
        platform = EXCLUDED.platform,
        logs = EXCLUDED.logs,
        error_message = EXCLUDED.error_message,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        started_at = EXCLUDED.started_at,
        finished_at = EXCLUDED.finished_at,
        source_updated_at = NOW()
    `,
    [
      input.id,
      input.userId,
      input.projectId,
      input.agentId,
      input.idempotencyKey,
      input.mode,
      input.status,
      JSON.stringify(input.config),
      input.platform,
      JSON.stringify(input.logs),
      input.errorMessage,
      input.createdAt,
      input.updatedAt,
      input.startedAt,
      input.finishedAt
    ]
  );
}

export async function closePostgresMirror(): Promise<void> {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = null;
  initialized = false;
}
