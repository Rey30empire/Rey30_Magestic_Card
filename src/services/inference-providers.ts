import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "../config/env";

export const inferenceCategorySchema = z.enum(["GEOMETRY_3D", "VOICE_ID", "VIDEO_ANIMATION", "LOGIC_GEN"]);
export type InferenceCategory = z.infer<typeof inferenceCategorySchema>;

const inferenceProviderSchema = z.object({
  id: z.string().trim().min(3).max(120),
  name: z.string().trim().min(2).max(160),
  category: inferenceCategorySchema,
  mode: z.enum(["local", "api"]),
  endpoint: z.string().trim().url().optional(),
  endpointEnvKey: z.string().trim().min(3).max(120).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().default("POST"),
  authEnvKey: z.string().trim().min(3).max(120).optional(),
  authScheme: z.enum(["bearer", "header", "body"]).optional().default("bearer"),
  authHeader: z.string().trim().min(2).max(80).optional(),
  authBodyField: z.string().trim().min(2).max(80).optional(),
  enabledByDefault: z.boolean().default(true),
  minFreeVramMb: z.number().int().min(0).max(256_000).optional(),
  estimatedCostUsd: z.number().min(0).max(10_000).default(0)
});

const inferenceProvidersConfigSchema = z.object({
  version: z.string().trim().min(1).max(80),
  providers: z.array(inferenceProviderSchema).min(1).max(100)
});

export type InferenceProvider = z.infer<typeof inferenceProviderSchema>;
export type InferenceProvidersConfig = z.infer<typeof inferenceProvidersConfigSchema>;

const fallbackProviders: InferenceProvidersConfig = {
  version: "fallback",
  providers: [
    {
      id: "local.instantmesh",
      name: "InstantMesh Local",
      category: "GEOMETRY_3D",
      mode: "local",
      method: "POST",
      authScheme: "bearer",
      enabledByDefault: true,
      minFreeVramMb: 14000,
      estimatedCostUsd: 0
    },
    {
      id: "api.meshy",
      name: "Meshy.ai",
      category: "GEOMETRY_3D",
      mode: "api",
      endpoint: "https://api.meshy.ai/openapi/v2/text-to-3d",
      endpointEnvKey: "MESHY_API_ENDPOINT",
      method: "POST",
      authEnvKey: "MESHY_AI_API_KEY",
      authScheme: "bearer",
      enabledByDefault: true,
      estimatedCostUsd: 0.18
    },
    {
      id: "local.ollama",
      name: "Ollama Local",
      category: "LOGIC_GEN",
      mode: "local",
      method: "POST",
      authScheme: "bearer",
      enabledByDefault: true,
      minFreeVramMb: 8000,
      estimatedCostUsd: 0
    },
    {
      id: "api.anthropic",
      name: "Anthropic Claude",
      category: "LOGIC_GEN",
      mode: "api",
      endpoint: "https://api.anthropic.com/v1/messages",
      method: "POST",
      authEnvKey: "ANTHROPIC_API_KEY",
      authScheme: "header",
      authHeader: "x-api-key",
      enabledByDefault: true,
      estimatedCostUsd: 0.08
    }
  ]
};

type ProvidersCache = {
  path: string;
  mtimeMs: number;
  loadedAt: string;
  config: InferenceProvidersConfig;
  error: string | null;
};

let cache: ProvidersCache | null = null;

function resolveProvidersFilePath(): string {
  const configured = env.MCP_HYBRID_PROVIDERS_FILE && env.MCP_HYBRID_PROVIDERS_FILE.trim().length > 0
    ? env.MCP_HYBRID_PROVIDERS_FILE.trim()
    : "config/InferenceProviders.json";
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function readConfigFromDisk(filePath: string): ProvidersCache {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, "utf8");
  const parsedJson = JSON.parse(raw) as unknown;
  const parsed = inferenceProvidersConfigSchema.parse(parsedJson);
  return {
    path: filePath,
    mtimeMs: stat.mtimeMs,
    loadedAt: new Date().toISOString(),
    config: parsed,
    error: null
  };
}

function ensureProvidersCache(): ProvidersCache {
  const filePath = resolveProvidersFilePath();

  try {
    const stat = fs.statSync(filePath);
    if (cache && cache.path === filePath && cache.mtimeMs === stat.mtimeMs) {
      return cache;
    }

    cache = readConfigFromDisk(filePath);
    return cache;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cache = {
      path: filePath,
      mtimeMs: 0,
      loadedAt: new Date().toISOString(),
      config: fallbackProviders,
      error: message
    };
    return cache;
  }
}

export function getInferenceProvidersConfig(): InferenceProvidersConfig {
  return ensureProvidersCache().config;
}

export function getInferenceProvidersMeta(): {
  path: string;
  loadedAt: string;
  version: string;
  providersCount: number;
  error: string | null;
} {
  const active = ensureProvidersCache();
  return {
    path: active.path,
    loadedAt: active.loadedAt,
    version: active.config.version,
    providersCount: active.config.providers.length,
    error: active.error
  };
}

export function listInferenceProvidersByCategory(category: InferenceCategory): InferenceProvider[] {
  return getInferenceProvidersConfig().providers.filter((provider) => provider.category === category);
}

export function getInferenceProviderById(providerId: string): InferenceProvider | null {
  const normalized = providerId.trim();
  if (normalized.length === 0) {
    return null;
  }

  const provider = getInferenceProvidersConfig().providers.find((candidate) => candidate.id === normalized);
  return provider ?? null;
}
