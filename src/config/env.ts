import dotenv from "dotenv";

dotenv.config();

const DEFAULT_JWT_SECRET = "change_this_in_production";
const MIN_SECRET_LENGTH = 24;

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
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

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  if (typeof value !== "string") {
    return [...fallback];
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : [...fallback];
}

export type TrainingRunnerMode = "inline" | "external" | "disabled";
export type TrainingQueueBackend = "local" | "redis";

function parseTrainingRunnerMode(value: string | undefined): TrainingRunnerMode {
  if (value === "external" || value === "disabled" || value === "inline") {
    return value;
  }

  return "inline";
}

function parseTrainingQueueBackend(value: string | undefined): TrainingQueueBackend {
  if (value === "redis" || value === "local") {
    return value;
  }

  return "local";
}

function resolveJwtSecret(value: string | undefined): string {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const secret = value?.trim() || DEFAULT_JWT_SECRET;

  if (nodeEnv === "production" && secret === DEFAULT_JWT_SECRET) {
    throw new Error("JWT_SECRET is required in production and cannot use the default value");
  }

  if (nodeEnv === "production" && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} chars in production`);
  }

  if (nodeEnv !== "production" && secret.length < MIN_SECRET_LENGTH) {
    console.warn(`[env] JWT_SECRET shorter than ${MIN_SECRET_LENGTH} chars. Use a stronger secret outside local dev.`);
  }

  return secret;
}

function resolveVaultSecret(value: string | undefined, jwtSecret: string): string {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const secret = value?.trim();

  if (secret && secret.length >= MIN_SECRET_LENGTH) {
    return secret;
  }

  if (nodeEnv === "production") {
    throw new Error(`VAULT_SECRET must be set and be at least ${MIN_SECRET_LENGTH} chars in production`);
  }

  if (secret && secret.length > 0) {
    console.warn(`[env] VAULT_SECRET shorter than ${MIN_SECRET_LENGTH} chars. Falling back to JWT_SECRET.`);
  } else {
    console.warn("[env] VAULT_SECRET not set. Falling back to JWT_SECRET for local development.");
  }

  return jwtSecret;
}

const jwtSecret = resolveJwtSecret(process.env.JWT_SECRET);
const vaultSecret = resolveVaultSecret(process.env.VAULT_SECRET, jwtSecret);
const defaultCorsOrigins = ["http://127.0.0.1:4000", "http://localhost:4000", "http://127.0.0.1:4173", "http://localhost:4173"];
const corsOrigins = parseStringList(process.env.CORS_ORIGINS, defaultCorsOrigins);
const socketCorsOrigins = parseStringList(process.env.SOCKET_CORS_ORIGINS, corsOrigins);
const defaultLlmAllowedHosts = ["api.openai.com", "openrouter.ai", "api.groq.com", "api.anthropic.com"];
const llmAllowedHosts = parseStringList(process.env.LLM_ALLOWED_HOSTS, defaultLlmAllowedHosts).map((host) =>
  host.toLowerCase()
);

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: parseNumber(process.env.PORT, 4000),
  JWT_SECRET: jwtSecret,
  VAULT_SECRET: vaultSecret,
  VAULT_ACTIVE_KEY_ID: process.env.VAULT_ACTIVE_KEY_ID?.trim() || "local-default",
  VAULT_KEYRING: process.env.VAULT_KEYRING,
  DB_PATH: process.env.DB_PATH ?? "./data/rey30.db",
  CREATIVE_POINTS_START: parseNumber(process.env.CREATIVE_POINTS_START, 10),
  API_RATE_LIMIT_WINDOW_MS: parseNumber(process.env.API_RATE_LIMIT_WINDOW_MS, 60_000),
  API_RATE_LIMIT_MAX: parseNumber(process.env.API_RATE_LIMIT_MAX, 240),
  API_RATE_LIMIT_MAX_BUCKETS: parseNumber(process.env.API_RATE_LIMIT_MAX_BUCKETS, 50_000),
  SENSITIVE_RATE_LIMIT_WINDOW_MS: parseNumber(process.env.SENSITIVE_RATE_LIMIT_WINDOW_MS, 60_000),
  SENSITIVE_RATE_LIMIT_MAX_PER_USER: parseNumber(process.env.SENSITIVE_RATE_LIMIT_MAX_PER_USER, 40),
  SENSITIVE_RATE_LIMIT_MAX_PER_TOKEN: parseNumber(process.env.SENSITIVE_RATE_LIMIT_MAX_PER_TOKEN, 80),
  SENSITIVE_RATE_LIMIT_MAX_BUCKETS: parseNumber(process.env.SENSITIVE_RATE_LIMIT_MAX_BUCKETS, 50_000),
  ABUSE_RISK_WINDOW_MS: parseNumber(process.env.ABUSE_RISK_WINDOW_MS, 15 * 60_000),
  ABUSE_RISK_BLOCK_THRESHOLD: parseNumber(process.env.ABUSE_RISK_BLOCK_THRESHOLD, 100),
  ABUSE_RISK_BLOCK_MS: parseNumber(process.env.ABUSE_RISK_BLOCK_MS, 10 * 60_000),
  ABUSE_RISK_INCIDENT_COOLDOWN_MS: parseNumber(process.env.ABUSE_RISK_INCIDENT_COOLDOWN_MS, 5 * 60_000),
  TEMPLATE_QUALITY_MIN_SCORE: parseNumber(process.env.TEMPLATE_QUALITY_MIN_SCORE, 45),
  MARKETPLACE_APP_VERSION: process.env.MARKETPLACE_APP_VERSION?.trim() || "1.0.0",
  OPS_ALERT_CARDS_409_15M: parseNumber(process.env.OPS_ALERT_CARDS_409_15M, 10),
  OPS_ALERT_MARKETPLACE_409_15M: parseNumber(process.env.OPS_ALERT_MARKETPLACE_409_15M, 10),
  OPS_ALERT_RATE_LIMIT_429_15M: parseNumber(process.env.OPS_ALERT_RATE_LIMIT_429_15M, 30),
  OPS_ALERT_HTTP_5XX_15M: parseNumber(process.env.OPS_ALERT_HTTP_5XX_15M, 5),
  OPS_ALERT_TRAINING_QUEUE_DEPTH: parseNumber(process.env.OPS_ALERT_TRAINING_QUEUE_DEPTH, 100),
  OPS_ALERT_TRAINING_FAILURE_RATE_15M: parseNumber(process.env.OPS_ALERT_TRAINING_FAILURE_RATE_15M, 40),
  OPS_METRICS_FLUSH_MS: parseNumber(process.env.OPS_METRICS_FLUSH_MS, 15_000),
  OPS_TRACE_MAX_SPANS: parseNumber(process.env.OPS_TRACE_MAX_SPANS, 5000),
  TRAINING_RUNNER_MODE: parseTrainingRunnerMode(process.env.TRAINING_RUNNER_MODE),
  TRAINING_WORKER_POLL_MS: parseNumber(process.env.TRAINING_WORKER_POLL_MS, 500),
  TRAINING_JOB_MAX_RUNTIME_MS: parseNumber(process.env.TRAINING_JOB_MAX_RUNTIME_MS, 0),
  TRAINING_QUEUE_BACKEND: parseTrainingQueueBackend(process.env.TRAINING_QUEUE_BACKEND),
  TRAINING_QUEUE_NAME: process.env.TRAINING_QUEUE_NAME ?? "training-jobs",
  TRAINING_WORKER_CONCURRENCY: parseNumber(process.env.TRAINING_WORKER_CONCURRENCY, 2),
  TRAINING_QUEUE_ATTEMPTS: parseNumber(process.env.TRAINING_QUEUE_ATTEMPTS, 5),
  TRAINING_QUEUE_BACKOFF_MS: parseNumber(process.env.TRAINING_QUEUE_BACKOFF_MS, 1000),
  TRAINING_DLQ_NAME: process.env.TRAINING_DLQ_NAME ?? "training-jobs-dlq",
  TRAINING_DLQ_ALERT_THRESHOLD: parseNumber(process.env.TRAINING_DLQ_ALERT_THRESHOLD, 10),
  TRAINING_MAX_ACTIVE_PER_USER: parseNumber(process.env.TRAINING_MAX_ACTIVE_PER_USER, 10),
  TRAINING_MAX_ACTIVE_GLOBAL: parseNumber(process.env.TRAINING_MAX_ACTIVE_GLOBAL, 500),
  REDIS_URL: process.env.REDIS_URL,
  POSTGRES_URL: process.env.POSTGRES_URL,
  POSTGRES_DUAL_WRITE: parseBoolean(process.env.POSTGRES_DUAL_WRITE, false),
  POSTGRES_POOL_MAX: parseNumber(process.env.POSTGRES_POOL_MAX, 5),
  LLM_REQUEST_TIMEOUT_MS: parseNumber(process.env.LLM_REQUEST_TIMEOUT_MS, 15_000),
  LLM_MAX_RETRIES: parseNumber(process.env.LLM_MAX_RETRIES, 1),
  LLM_ALLOW_HTTP: parseBoolean(process.env.LLM_ALLOW_HTTP, false),
  LLM_ALLOW_LOCAL_ENDPOINTS: parseBoolean(process.env.LLM_ALLOW_LOCAL_ENDPOINTS, false),
  LLM_ALLOWED_HOSTS: llmAllowedHosts,
  CORS_ORIGINS: corsOrigins,
  SOCKET_CORS_ORIGINS: socketCorsOrigins,
  TRUST_PROXY: parseBoolean(process.env.TRUST_PROXY, false)
};
