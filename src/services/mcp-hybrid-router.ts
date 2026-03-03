import { z } from "zod";
import { env } from "../config/env";
import { get, run } from "../db/sqlite";
import { parseJsonSafe } from "../utils/json";
import {
  InferenceCategory,
  InferenceProvider,
  getInferenceProviderById,
  getInferenceProvidersConfig,
  listInferenceProvidersByCategory
} from "./inference-providers";

export const hybridTaskSchema = z.object({
  category: z.enum(["GEOMETRY_3D", "VOICE_ID", "VIDEO_ANIMATION", "LOGIC_GEN"]),
  providerId: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(1).max(12000).optional(),
  payload: z.record(z.string(), z.unknown()).default({})
});

export const hybridToggleUpdateSchema = z.object({
  localEngineEnabled: z.boolean().optional(),
  apiEngineEnabled: z.boolean().optional(),
  preferLocalOverApi: z.boolean().optional(),
  providers: z.record(z.string(), z.boolean()).optional()
});

export type HybridTask = z.infer<typeof hybridTaskSchema>;
export type HybridToggleUpdate = z.infer<typeof hybridToggleUpdateSchema>;

export type HybridToggles = {
  localEngineEnabled: boolean;
  apiEngineEnabled: boolean;
  preferLocalOverApi: boolean;
  providers: Record<string, boolean>;
  updatedAt: string;
};

type DailyBudgetState = {
  day: string;
  spentUsd: number;
};

type HybridBudgetRow = {
  day_key: string;
  spent_usd: unknown;
  updated_at: string | null;
};

type HybridToggleRow = {
  user_id: string;
  local_engine_enabled: unknown;
  api_engine_enabled: unknown;
  prefer_local_over_api: unknown;
  providers_json: string | null;
  updated_at: string | null;
};

const togglesByUser = new Map<string, HybridToggles>();
let budgetState: DailyBudgetState = {
  day: new Date().toISOString().slice(0, 10),
  spentUsd: 0
};
let loadedBudgetDay: string | null = null;
let budgetWriteChain: Promise<void> = Promise.resolve();

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeBudget(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value * 10000) / 10000;
}

function normalizeBudgetDayKey(input: string | undefined | null): string {
  const value = (input ?? "").trim();
  if (value.length === 0) {
    return todayIsoDate();
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Invalid budget day format. Use YYYY-MM-DD.");
  }

  return value;
}

function parseBudgetNumber(value: unknown): number {
  if (typeof value === "number") {
    return sanitizeBudget(value);
  }
  if (typeof value === "string") {
    const n = Number(value.trim());
    return sanitizeBudget(n);
  }
  if (typeof value === "bigint") {
    return sanitizeBudget(Number(value));
  }
  return 0;
}

async function loadBudgetForDay(dayKey: string): Promise<DailyBudgetState> {
  const row = await get<HybridBudgetRow>(
    `
      SELECT day_key, spent_usd, updated_at
      FROM mcp_hybrid_budget_daily
      WHERE day_key = ?
      LIMIT 1
    `,
    [dayKey]
  );

  if (!row) {
    return {
      day: dayKey,
      spentUsd: 0
    };
  }

  return {
    day: dayKey,
    spentUsd: parseBudgetNumber(row.spent_usd)
  };
}

async function loadBudgetSnapshotForDay(dayKey: string): Promise<{
  dailyBudgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  day: string;
}> {
  const loaded = await loadBudgetForDay(dayKey);
  const dailyBudgetUsd = sanitizeBudget(env.DAILY_BUDGET_USD);
  const spentUsd = sanitizeBudget(loaded.spentUsd);
  const remainingUsd = sanitizeBudget(Math.max(0, dailyBudgetUsd - spentUsd));
  return {
    dailyBudgetUsd,
    spentUsd,
    remainingUsd,
    day: dayKey
  };
}

async function persistBudgetForDay(dayKey: string, spentUsd: number): Promise<void> {
  const normalized = sanitizeBudget(spentUsd);
  const now = new Date().toISOString();
  await run(
    `
      INSERT INTO mcp_hybrid_budget_daily (day_key, spent_usd, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(day_key) DO UPDATE SET
        spent_usd = excluded.spent_usd,
        updated_at = excluded.updated_at
    `,
    [dayKey, normalized, now, now]
  );
}

async function ensureBudgetDay(): Promise<void> {
  const today = todayIsoDate();
  if (loadedBudgetDay === today) {
    return;
  }

  const loaded = await loadBudgetForDay(today);
  budgetState = loaded;
  loadedBudgetDay = today;
}

async function withBudgetWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = budgetWriteChain;
  let release: () => void = () => undefined;
  budgetWriteChain = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function defaultProviderToggles(): Record<string, boolean> {
  const toggles: Record<string, boolean> = {};
  for (const provider of getInferenceProvidersConfig().providers) {
    toggles[provider.id] = provider.enabledByDefault;
  }
  return toggles;
}

function mergeProviderDefaults(input: Record<string, boolean>): Record<string, boolean> {
  const merged = defaultProviderToggles();
  for (const [providerId, enabled] of Object.entries(input)) {
    merged[providerId] = Boolean(enabled);
  }
  return merged;
}

function normalizeFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeProviderToggles(value: unknown): Record<string, boolean> {
  const parsed = typeof value === "string" ? parseJsonSafe<Record<string, unknown>>(value, {}) : {};
  const out: Record<string, boolean> = {};
  for (const [providerId, enabled] of Object.entries(parsed)) {
    out[providerId] = normalizeFlag(enabled, false);
  }
  return out;
}

function serializeProviderToggles(input: Record<string, boolean>): string {
  try {
    return JSON.stringify(mergeProviderDefaults(input));
  } catch {
    return "{}";
  }
}

function cloneToggles(input: HybridToggles): HybridToggles {
  return {
    ...input,
    providers: { ...input.providers }
  };
}

function buildDefaultHybridToggles(): HybridToggles {
  return {
    localEngineEnabled: env.LOCAL_MLL_ENABLED,
    apiEngineEnabled: true,
    preferLocalOverApi: env.PREFER_LOCAL_OVER_API,
    providers: defaultProviderToggles(),
    updatedAt: new Date().toISOString()
  };
}

async function loadHybridTogglesFromDb(userId: string): Promise<HybridToggles | null> {
  const row = await get<HybridToggleRow>(
    `
      SELECT
        user_id,
        local_engine_enabled,
        api_engine_enabled,
        prefer_local_over_api,
        providers_json,
        updated_at
      FROM mcp_hybrid_toggles
      WHERE user_id = ?
      LIMIT 1
    `,
    [userId]
  );

  if (!row) {
    return null;
  }

  return {
    localEngineEnabled: normalizeFlag(row.local_engine_enabled, env.LOCAL_MLL_ENABLED),
    apiEngineEnabled: normalizeFlag(row.api_engine_enabled, true),
    preferLocalOverApi: normalizeFlag(row.prefer_local_over_api, env.PREFER_LOCAL_OVER_API),
    providers: mergeProviderDefaults(normalizeProviderToggles(row.providers_json)),
    updatedAt: typeof row.updated_at === "string" && row.updated_at.trim().length > 0 ? row.updated_at : new Date().toISOString()
  };
}

async function persistHybridTogglesToDb(userId: string, toggles: HybridToggles): Promise<void> {
  const now = toggles.updatedAt || new Date().toISOString();
  await run(
    `
      INSERT INTO mcp_hybrid_toggles (
        user_id,
        local_engine_enabled,
        api_engine_enabled,
        prefer_local_over_api,
        providers_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        local_engine_enabled = excluded.local_engine_enabled,
        api_engine_enabled = excluded.api_engine_enabled,
        prefer_local_over_api = excluded.prefer_local_over_api,
        providers_json = excluded.providers_json,
        updated_at = excluded.updated_at
    `,
    [
      userId,
      toggles.localEngineEnabled ? 1 : 0,
      toggles.apiEngineEnabled ? 1 : 0,
      toggles.preferLocalOverApi ? 1 : 0,
      serializeProviderToggles(toggles.providers),
      now,
      now
    ]
  );
}

export async function getHybridToggles(userId: string): Promise<HybridToggles> {
  const existing = togglesByUser.get(userId);
  if (existing) {
    return cloneToggles({
      ...existing,
      providers: mergeProviderDefaults(existing.providers)
    });
  }

  const persisted = await loadHybridTogglesFromDb(userId);
  if (persisted) {
    togglesByUser.set(userId, persisted);
    return cloneToggles(persisted);
  }

  const fresh = buildDefaultHybridToggles();
  await persistHybridTogglesToDb(userId, fresh);
  togglesByUser.set(userId, fresh);
  return cloneToggles(fresh);
}

export async function updateHybridToggles(userId: string, patch: HybridToggleUpdate): Promise<HybridToggles> {
  const current = await getHybridToggles(userId);
  const next: HybridToggles = {
    localEngineEnabled: patch.localEngineEnabled ?? current.localEngineEnabled,
    apiEngineEnabled: patch.apiEngineEnabled ?? current.apiEngineEnabled,
    preferLocalOverApi: patch.preferLocalOverApi ?? current.preferLocalOverApi,
    providers: patch.providers ? mergeProviderDefaults({ ...current.providers, ...patch.providers }) : mergeProviderDefaults(current.providers),
    updatedAt: new Date().toISOString()
  };
  await persistHybridTogglesToDb(userId, next);
  togglesByUser.set(userId, next);
  return cloneToggles(next);
}

export async function getHybridBudgetSnapshot(): Promise<{
  dailyBudgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  day: string;
}> {
  await ensureBudgetDay();
  const dailyBudgetUsd = sanitizeBudget(env.DAILY_BUDGET_USD);
  const spentUsd = sanitizeBudget(budgetState.spentUsd);
  const remainingUsd = sanitizeBudget(Math.max(0, dailyBudgetUsd - spentUsd));

  return {
    dailyBudgetUsd,
    spentUsd,
    remainingUsd,
    day: budgetState.day
  };
}

export async function canSpendHybridBudget(costUsd: number): Promise<{
  allowed: boolean;
  budget: Awaited<ReturnType<typeof getHybridBudgetSnapshot>>;
  requestedCostUsd: number;
}> {
  const budget = await getHybridBudgetSnapshot();
  const requested = sanitizeBudget(costUsd);
  if (requested <= 0) {
    return {
      allowed: true,
      budget,
      requestedCostUsd: requested
    };
  }

  return {
    allowed: budget.remainingUsd >= requested,
    budget,
    requestedCostUsd: requested
  };
}

export async function registerHybridSpend(costUsd: number): Promise<Awaited<ReturnType<typeof getHybridBudgetSnapshot>>> {
  return withBudgetWriteLock(async () => {
    await ensureBudgetDay();
    const normalized = sanitizeBudget(costUsd);
    if (normalized > 0) {
      budgetState.spentUsd = sanitizeBudget(budgetState.spentUsd + normalized);
      await persistBudgetForDay(budgetState.day, budgetState.spentUsd);
    }
    return getHybridBudgetSnapshot();
  });
}

export async function resetHybridBudget(input?: {
  day?: string;
}): Promise<{
  day: string;
  previousSpentUsd: number;
  budget: Awaited<ReturnType<typeof getHybridBudgetSnapshot>>;
}> {
  return withBudgetWriteLock(async () => {
    const day = normalizeBudgetDayKey(input?.day);
    const previous = await loadBudgetForDay(day);
    await persistBudgetForDay(day, 0);

    if (loadedBudgetDay === day) {
      budgetState = {
        day,
        spentUsd: 0
      };
    }

    const budget = day === todayIsoDate() ? await getHybridBudgetSnapshot() : await loadBudgetSnapshotForDay(day);
    return {
      day,
      previousSpentUsd: sanitizeBudget(previous.spentUsd),
      budget
    };
  });
}

function providerEnabled(providerId: string, toggles: HybridToggles): boolean {
  return toggles.providers[providerId] !== false;
}

function selectByMode(
  providers: InferenceProvider[],
  mode: "local" | "api",
  toggles: HybridToggles
): InferenceProvider | null {
  for (const provider of providers) {
    if (provider.mode !== mode) {
      continue;
    }
    if (!providerEnabled(provider.id, toggles)) {
      continue;
    }
    return provider;
  }
  return null;
}

function localProviderAllowedByVram(provider: InferenceProvider, lowestFreeMb: number | null): boolean {
  if (provider.mode !== "local") {
    return true;
  }
  if (!Number.isFinite(provider.minFreeVramMb)) {
    return true;
  }
  if (!Number.isFinite(lowestFreeMb)) {
    return true;
  }
  return (lowestFreeMb as number) >= (provider.minFreeVramMb as number);
}

function chooseCategoryPreference(category: InferenceCategory): "local-first" | "api-first" {
  if (category === "VOICE_ID" || category === "VIDEO_ANIMATION") {
    return "api-first";
  }
  return "local-first";
}

export function resolveHybridProvider(input: {
  category: InferenceCategory;
  requestedProviderId?: string;
  toggles: HybridToggles;
  lowestFreeVramMb: number | null;
}): {
  provider: InferenceProvider | null;
  reason: string | null;
} {
  const geometryDefaultProvider = env.MCP_GEOMETRY_DEFAULT_PROVIDER.trim();
  if (!input.requestedProviderId && input.category === "GEOMETRY_3D" && geometryDefaultProvider.length > 0) {
    const preferred = getInferenceProviderById(geometryDefaultProvider);
    if (
      preferred &&
      preferred.category === "GEOMETRY_3D" &&
      providerEnabled(preferred.id, input.toggles) &&
      !(preferred.mode === "local" && !input.toggles.localEngineEnabled) &&
      !(preferred.mode === "api" && !input.toggles.apiEngineEnabled) &&
      localProviderAllowedByVram(preferred, input.lowestFreeVramMb)
    ) {
      return {
        provider: preferred,
        reason: null
      };
    }
  }

  const requestedProviderId = input.requestedProviderId?.trim();
  if (requestedProviderId) {
    const requested = getInferenceProviderById(requestedProviderId);
    if (!requested) {
      return {
        provider: null,
        reason: `provider_not_found:${requestedProviderId}`
      };
    }
    if (requested.category !== input.category) {
      return {
        provider: null,
        reason: `provider_category_mismatch:${requestedProviderId}`
      };
    }
    if (requested.mode === "local" && !input.toggles.localEngineEnabled) {
      return {
        provider: null,
        reason: "local_engine_disabled"
      };
    }
    if (requested.mode === "api" && !input.toggles.apiEngineEnabled) {
      return {
        provider: null,
        reason: "api_engine_disabled"
      };
    }
    if (!providerEnabled(requested.id, input.toggles)) {
      return {
        provider: null,
        reason: `provider_toggle_off:${requested.id}`
      };
    }
    if (!localProviderAllowedByVram(requested, input.lowestFreeVramMb)) {
      return {
        provider: null,
        reason: `vram_below_threshold:${requested.id}`
      };
    }
    return {
      provider: requested,
      reason: null
    };
  }

  const providers = listInferenceProvidersByCategory(input.category).filter((provider) => providerEnabled(provider.id, input.toggles));
  if (providers.length === 0) {
    return {
      provider: null,
      reason: "no_provider_for_category"
    };
  }

  const pref = chooseCategoryPreference(input.category);
  const localPreferred = input.toggles.preferLocalOverApi;
  const localCandidate = selectByMode(providers, "local", input.toggles);
  const apiCandidate = selectByMode(providers, "api", input.toggles);

  const localAllowed = localCandidate ? localProviderAllowedByVram(localCandidate, input.lowestFreeVramMb) : false;

  if (pref === "api-first") {
    if (input.toggles.apiEngineEnabled && apiCandidate) {
      return { provider: apiCandidate, reason: null };
    }
    if (input.toggles.localEngineEnabled && localCandidate && localAllowed) {
      return { provider: localCandidate, reason: null };
    }
    return { provider: null, reason: "no_api_or_local_provider_available" };
  }

  if (localPreferred) {
    if (input.toggles.localEngineEnabled && localCandidate && localAllowed) {
      return { provider: localCandidate, reason: null };
    }
    if (input.toggles.apiEngineEnabled && apiCandidate) {
      return { provider: apiCandidate, reason: null };
    }
    return { provider: null, reason: localCandidate ? `vram_below_threshold:${localCandidate.id}` : "no_provider_available" };
  }

  if (input.toggles.apiEngineEnabled && apiCandidate) {
    return { provider: apiCandidate, reason: null };
  }
  if (input.toggles.localEngineEnabled && localCandidate && localAllowed) {
    return { provider: localCandidate, reason: null };
  }
  return { provider: null, reason: "no_provider_available" };
}
