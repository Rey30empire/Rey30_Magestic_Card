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
export type DbEngine = "sqlite" | "sqlserver";

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

function parseDbEngine(value: string | undefined): DbEngine {
  if (value === "sqlserver" || value === "sqlite") {
    return value;
  }

  return "sqlserver";
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
const dbEngine = parseDbEngine(process.env.DB_ENGINE);
const defaultCorsOrigins = ["http://127.0.0.1:4000", "http://localhost:4000", "http://127.0.0.1:4173", "http://localhost:4173"];
const corsOrigins = parseStringList(process.env.CORS_ORIGINS, defaultCorsOrigins);
const socketCorsOrigins = parseStringList(process.env.SOCKET_CORS_ORIGINS, corsOrigins);
const defaultLlmAllowedHosts = ["api.openai.com", "openrouter.ai", "api.groq.com", "api.anthropic.com"];
const llmAllowedHosts = parseStringList(process.env.LLM_ALLOWED_HOSTS, defaultLlmAllowedHosts).map((host) =>
  host.toLowerCase()
);
const sqlServerHost = process.env.SQL_SERVER_HOST?.trim() || process.env.SQL_HOST?.trim() || "127.0.0.1";
const sqlServerInstance = process.env.SQL_SERVER_INSTANCE?.trim() || process.env.SQL_INSTANCE?.trim() || "";
const sqlServerDatabase = process.env.SQL_SERVER_DATABASE?.trim() || process.env.SQL_DATABASE?.trim() || "master";
const sqlServerUser = process.env.SQL_SERVER_USER?.trim() || process.env.SQL_USER?.trim() || "";
const sqlServerPassword = (process.env.SQL_SERVER_PASSWORD ?? process.env.SQL_PASSWORD ?? "").trim();

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  DB_ENGINE: dbEngine,
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
  TRAINING_STAGE_TIMEOUT_MS: parseNumber(process.env.TRAINING_STAGE_TIMEOUT_MS, 0),
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
  SQL_SERVER_ENABLED: parseBoolean(process.env.SQL_SERVER_ENABLED, dbEngine === "sqlserver"),
  SQL_SERVER_HOST: sqlServerHost,
  SQL_SERVER_PORT: parseNumber(process.env.SQL_SERVER_PORT, 1433),
  SQL_SERVER_INSTANCE: sqlServerInstance,
  SQL_SERVER_DATABASE: sqlServerDatabase,
  SQL_SERVER_USER: sqlServerUser,
  SQL_SERVER_PASSWORD: sqlServerPassword,
  SQL_SERVER_ENCRYPT: parseBoolean(process.env.SQL_SERVER_ENCRYPT, false),
  SQL_SERVER_TRUST_SERVER_CERTIFICATE: parseBoolean(process.env.SQL_SERVER_TRUST_SERVER_CERTIFICATE, true),
  SQL_SERVER_CONNECT_TIMEOUT_MS: parseNumber(process.env.SQL_SERVER_CONNECT_TIMEOUT_MS, 5000),
  SQL_SERVER_REQUEST_TIMEOUT_MS: parseNumber(process.env.SQL_SERVER_REQUEST_TIMEOUT_MS, 10_000),
  SQL_SERVER_POOL_MAX: parseNumber(process.env.SQL_SERVER_POOL_MAX, 5),
  SQL_SERVER_DUAL_WRITE: parseBoolean(process.env.SQL_SERVER_DUAL_WRITE, false),
  LLM_REQUEST_TIMEOUT_MS: parseNumber(process.env.LLM_REQUEST_TIMEOUT_MS, 15_000),
  LLM_MAX_RETRIES: parseNumber(process.env.LLM_MAX_RETRIES, 1),
  LLM_ALLOW_HTTP: parseBoolean(process.env.LLM_ALLOW_HTTP, false),
  LLM_ALLOW_LOCAL_ENDPOINTS: parseBoolean(process.env.LLM_ALLOW_LOCAL_ENDPOINTS, false),
  LLM_ALLOWED_HOSTS: llmAllowedHosts,
  REYMESHY_SIDECAR_ENABLED: parseBoolean(process.env.REYMESHY_SIDECAR_ENABLED, true),
  REYMESHY_SIDECAR_EXECUTABLE: process.env.REYMESHY_SIDECAR_EXECUTABLE?.trim() ?? "",
  REYMESHY_SIDECAR_ARGS: parseStringList(process.env.REYMESHY_SIDECAR_ARGS, []),
  REYMESHY_SIDECAR_CWD: process.env.REYMESHY_SIDECAR_CWD?.trim() ?? "",
  REYMESHY_SIDECAR_TIMEOUT_MS: parseNumber(process.env.REYMESHY_SIDECAR_TIMEOUT_MS, 12_000),
  REYMESHY_JOB_CONCURRENCY: parseNumber(process.env.REYMESHY_JOB_CONCURRENCY, 1),
  REYMESHY_JOB_MAX_STORED: parseNumber(process.env.REYMESHY_JOB_MAX_STORED, 500),
  VRAM_SENTINEL_ENABLED: parseBoolean(process.env.VRAM_SENTINEL_ENABLED, false),
  VRAM_SENTINEL_FAIL_OPEN: parseBoolean(process.env.VRAM_SENTINEL_FAIL_OPEN, true),
  VRAM_SENTINEL_POLL_MS: parseNumber(process.env.VRAM_SENTINEL_POLL_MS, 3000),
  VRAM_SENTINEL_COMMAND_TIMEOUT_MS: parseNumber(process.env.VRAM_SENTINEL_COMMAND_TIMEOUT_MS, 2000),
  VRAM_SENTINEL_COMMAND: process.env.VRAM_SENTINEL_COMMAND?.trim() ?? "",
  VRAM_SENTINEL_COMMAND_ARGS: parseStringList(process.env.VRAM_SENTINEL_COMMAND_ARGS, []),
  REYMESHY_VRAM_MAX_USED_MB: parseNumber(process.env.REYMESHY_VRAM_MAX_USED_MB, 22000),
  REYMESHY_VRAM_MIN_FREE_MB: parseNumber(process.env.REYMESHY_VRAM_MIN_FREE_MB, 1200),
  REYMESHY_VRAM_TASK_RESERVE_MB: parseNumber(process.env.REYMESHY_VRAM_TASK_RESERVE_MB, 1200),
  MCP_GATEWAY_ENABLED: parseBoolean(process.env.MCP_GATEWAY_ENABLED, false),
  MCP_TOOL_REYMESHY_ENABLED: parseBoolean(process.env.MCP_TOOL_REYMESHY_ENABLED, true),
  MCP_TOOL_OLLAMA_ENABLED: parseBoolean(process.env.MCP_TOOL_OLLAMA_ENABLED, false),
  MCP_TOOL_INSTANTMESH_ENABLED: parseBoolean(process.env.MCP_TOOL_INSTANTMESH_ENABLED, false),
  MCP_OLLAMA_API_BASE_URL: process.env.MCP_OLLAMA_API_BASE_URL?.trim() || "http://127.0.0.1:11434",
  MCP_OLLAMA_TIMEOUT_MS: parseNumber(process.env.MCP_OLLAMA_TIMEOUT_MS, 15_000),
  MCP_INSTANTMESH_COMMAND: process.env.MCP_INSTANTMESH_COMMAND?.trim() ?? "",
  MCP_INSTANTMESH_ARGS: parseStringList(process.env.MCP_INSTANTMESH_ARGS, []),
  MCP_INSTANTMESH_TIMEOUT_MS: parseNumber(process.env.MCP_INSTANTMESH_TIMEOUT_MS, 30_000),
  MCP_HYBRID_PROVIDERS_FILE: process.env.MCP_HYBRID_PROVIDERS_FILE?.trim() || "config/InferenceProviders.json",
  MCP_HYBRID_RESULTS_QUEUE: process.env.MCP_HYBRID_RESULTS_QUEUE?.trim() || "mcp-hybrid-results",
  MCP_HYBRID_RESULT_BUS_TIMEOUT_MS: parseNumber(process.env.MCP_HYBRID_RESULT_BUS_TIMEOUT_MS, 1200),
  MCP_GEOMETRY_DEFAULT_PROVIDER: process.env.MCP_GEOMETRY_DEFAULT_PROVIDER?.trim() || "api.meshy",
  MCP_MESHY_WAIT_FOR_COMPLETION: parseBoolean(process.env.MCP_MESHY_WAIT_FOR_COMPLETION, true),
  MCP_MESHY_POLL_INTERVAL_MS: parseNumber(process.env.MCP_MESHY_POLL_INTERVAL_MS, 3000),
  MCP_MESHY_POLL_TIMEOUT_MS: parseNumber(process.env.MCP_MESHY_POLL_TIMEOUT_MS, 180_000),
  MCP_HYBRID_PROCESS_CONTROL_ENABLED: parseBoolean(process.env.MCP_HYBRID_PROCESS_CONTROL_ENABLED, false),
  MCP_HYBRID_PROCESS_CONTROL_TIMEOUT_MS: parseNumber(process.env.MCP_HYBRID_PROCESS_CONTROL_TIMEOUT_MS, 2500),
  MCP_HYBRID_LOCAL_PROCESS_NAMES: parseStringList(process.env.MCP_HYBRID_LOCAL_PROCESS_NAMES, [
    "ollama",
    "python_worker",
    "python",
    "python3"
  ]),
  LOCAL_MLL_ENABLED: parseBoolean(process.env.LOCAL_MLL_ENABLED, true),
  LOCAL_VRAM_LIMIT_MB: parseNumber(process.env.LOCAL_VRAM_LIMIT_MB, 20_480),
  DAILY_BUDGET_USD: parseNumber(process.env.DAILY_BUDGET_USD, 10),
  PREFER_LOCAL_OVER_API: parseBoolean(process.env.PREFER_LOCAL_OVER_API, true),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY?.trim() ?? "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY?.trim() ?? "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY?.trim() ?? "",
  RUNWAY_GEN2_API_KEY: process.env.RUNWAY_GEN2_API_KEY?.trim() ?? "",
  MESHY_AI_API_KEY: process.env.MESHY_AI_API_KEY?.trim() ?? "",
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY?.trim() ?? "",
  FAL_AI_API_KEY: process.env.FAL_AI_API_KEY?.trim() ?? "",
  VAULT_STORAGE_DIR: process.env.VAULT_STORAGE_DIR?.trim() || "./data/vault",
  VAULT_UPLOAD_MAX_BYTES: parseNumber(process.env.VAULT_UPLOAD_MAX_BYTES, 50 * 1024 * 1024),
  VAULT_ALLOWED_EXTENSIONS: parseStringList(process.env.VAULT_ALLOWED_EXTENSIONS, [
    ".glb",
    ".gltf",
    ".obj",
    ".fbx",
    ".png",
    ".jpg",
    ".jpeg",
    ".hdr",
    ".zip",
    ".json"
  ]).map((extension) => {
    const normalized = extension.trim().toLowerCase();
    if (normalized === "*") {
      return normalized;
    }

    return normalized.startsWith(".") ? normalized : `.${normalized}`;
  }),
  CORS_ORIGINS: corsOrigins,
  SOCKET_CORS_ORIGINS: socketCorsOrigins,
  TRUST_PROXY: parseBoolean(process.env.TRUST_PROXY, false)
};
