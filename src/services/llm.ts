import dns from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "../config/env";

type LlmRole = "system" | "user" | "assistant";
type LlmProvider = "openai" | "openrouter" | "groq" | "anthropic" | "openai-compatible";

export type LlmMessage = {
  role: LlmRole;
  content: string;
};

export type LlmRequest = {
  provider: string;
  model: string;
  endpoint: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  messages: LlmMessage[];
};

export type LlmResult = {
  text: string;
  raw: unknown;
  provider: string;
  endpoint: string;
  model: string;
};

const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DNS_CACHE_TTL_MS = 5 * 60_000;

const providerDefaultHosts: Record<LlmProvider, string[]> = {
  openai: ["api.openai.com"],
  openrouter: ["openrouter.ai"],
  groq: ["api.groq.com"],
  anthropic: ["api.anthropic.com"],
  "openai-compatible": []
};

const dnsPrivateHostCache = new Map<string, { checkedAt: number; privateAddress: boolean }>();

function normalizeProvider(providerRaw: string): LlmProvider {
  const normalized = providerRaw.trim().toLowerCase();
  if (normalized.length === 0) {
    return "openai-compatible";
  }

  if (normalized === "openai" || normalized === "openrouter" || normalized === "groq" || normalized === "anthropic") {
    return normalized;
  }

  return "openai-compatible";
}

function resolveEndpoint(provider: LlmProvider, endpointRaw: string): string {
  const endpoint = endpointRaw.trim();
  if (endpoint.length > 0) {
    return endpoint;
  }

  if (provider === "openai") {
    return DEFAULT_OPENAI_ENDPOINT;
  }
  if (provider === "openrouter") {
    return DEFAULT_OPENROUTER_ENDPOINT;
  }
  if (provider === "groq") {
    return DEFAULT_GROQ_ENDPOINT;
  }
  if (provider === "anthropic") {
    return DEFAULT_ANTHROPIC_ENDPOINT;
  }
  return DEFAULT_OPENAI_ENDPOINT;
}

function uniqueLowerItems(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0))];
}

function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern || host.endsWith(`.${pattern}`);
}

function isHostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  return allowlist.some((pattern) => hostMatchesPattern(host, pattern));
}

function isLocalHostname(host: string): boolean {
  const lowered = host.toLowerCase();
  return lowered === "localhost" || lowered.endsWith(".localhost") || lowered === "localhost.localdomain";
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((value) => Number(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  }
  return a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const lowered = address.toLowerCase();
  if (lowered === "::1" || lowered === "::" || lowered === "0:0:0:0:0:0:0:1") {
    return true;
  }

  if (lowered.startsWith("fc") || lowered.startsWith("fd")) {
    return true;
  }

  if (lowered.startsWith("fe8") || lowered.startsWith("fe9") || lowered.startsWith("fea") || lowered.startsWith("feb")) {
    return true;
  }

  if (lowered.startsWith("::ffff:")) {
    const mapped = lowered.slice("::ffff:".length);
    if (mapped.includes(".")) {
      return isPrivateIpv4(mapped);
    }
  }

  return false;
}

function isPrivateHost(host: string): boolean {
  if (isLocalHostname(host)) {
    return true;
  }

  const ipType = isIP(host);
  if (ipType === 4) {
    return isPrivateIpv4(host);
  }
  if (ipType === 6) {
    return isPrivateIpv6(host);
  }

  return false;
}

async function resolvesToPrivateAddress(host: string): Promise<boolean> {
  const now = Date.now();
  const cached = dnsPrivateHostCache.get(host);
  if (cached && now - cached.checkedAt < DNS_CACHE_TTL_MS) {
    return cached.privateAddress;
  }

  let entries: Array<{ address: string }>;
  try {
    entries = await dns.lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`Failed to resolve endpoint host: ${host} (${error instanceof Error ? error.message : String(error)})`);
  }

  const privateAddress = entries.some((entry) => isPrivateHost(entry.address));
  dnsPrivateHostCache.set(host, { checkedAt: now, privateAddress });
  return privateAddress;
}

function parseOpenAiContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const value = (part as Record<string, unknown>).text;
    if (typeof value === "string") {
      parts.push(value);
    }
  }

  return parts.join("\n");
}

function parseAnthropicContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const value = (block as Record<string, unknown>).text;
    if (typeof value === "string") {
      parts.push(value);
    }
  }

  return parts.join("\n");
}

function clampInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.trunc(value);
  return Math.min(max, Math.max(min, rounded));
}

function getRequestTimeoutMs(): number {
  return clampInteger(env.LLM_REQUEST_TIMEOUT_MS, 15_000, 1000, 120_000);
}

function getRetryCount(): number {
  return clampInteger(env.LLM_MAX_RETRIES, 1, 0, 4);
}

function retryBackoffMs(attempt: number): number {
  return Math.min(2000, 250 * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("socket") ||
    message.includes("timed out") ||
    message.includes("econnreset")
  );
}

async function fetchWithTimeoutAndRetry(endpoint: string, init: RequestInit): Promise<Response> {
  const timeoutMs = getRequestTimeoutMs();
  const maxRetries = getRetryCount();
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        ...init,
        signal: controller.signal
      });

      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
        await response.arrayBuffer().catch(() => undefined);
        await sleep(retryBackoffMs(attempt));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && isRetryableFetchError(error)) {
        await sleep(retryBackoffMs(attempt));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("LLM request failed");
}

function assertEndpointAllowed(provider: LlmProvider, host: string): void {
  const configuredHosts = uniqueLowerItems(env.LLM_ALLOWED_HOSTS);
  const combinedAllowlist =
    provider === "openai-compatible"
      ? configuredHosts
      : uniqueLowerItems([...providerDefaultHosts[provider], ...configuredHosts]);

  if (!isHostAllowed(host, combinedAllowlist)) {
    throw new Error(`Endpoint host is not allowed for provider ${provider}`);
  }
}

export async function resolveAndValidateLlmEndpoint(
  providerRaw: string,
  endpointRaw: string
): Promise<{ provider: LlmProvider; endpoint: string }> {
  const provider = normalizeProvider(providerRaw);
  const candidate = resolveEndpoint(provider, endpointRaw);

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Invalid endpoint URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Endpoint protocol must be http or https");
  }

  if (url.protocol === "http:" && !env.LLM_ALLOW_HTTP) {
    throw new Error("Insecure http endpoints are not allowed");
  }

  if (url.username || url.password) {
    throw new Error("Endpoint URL must not include userinfo");
  }

  const host = url.hostname.trim().toLowerCase();
  if (!host) {
    throw new Error("Endpoint host is required");
  }

  assertEndpointAllowed(provider, host);

  if (!env.LLM_ALLOW_LOCAL_ENDPOINTS) {
    if (isPrivateHost(host)) {
      throw new Error("Endpoint host cannot be local/private");
    }
    if (await resolvesToPrivateAddress(host)) {
      throw new Error("Endpoint host resolves to private address");
    }
  }

  url.hash = "";
  return {
    provider,
    endpoint: url.toString()
  };
}

async function callOpenAiCompatible(input: LlmRequest, provider: LlmProvider, endpoint: string): Promise<LlmResult> {
  const payload = {
    model: input.model,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content
    }))
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${input.apiKey}`
  };

  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://rey30.local";
    headers["X-Title"] = "Rey30 Mayestic Card";
  }

  const response = await fetchWithTimeoutAndRetry(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`LLM provider error (${response.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }

  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const text = parseOpenAiContent(message?.content);
  if (!text) {
    throw new Error("LLM response is empty");
  }

  return {
    text,
    raw: data,
    provider,
    endpoint,
    model: input.model
  };
}

async function callAnthropic(input: LlmRequest, endpoint: string): Promise<LlmResult> {
  const systemPrompt = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");

  const messages = input.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    }));

  const payload: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens,
    temperature: input.temperature,
    messages
  };

  if (systemPrompt.length > 0) {
    payload.system = systemPrompt;
  }

  const response = await fetchWithTimeoutAndRetry(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(payload)
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`LLM provider error (${response.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }

  const text = parseAnthropicContent(data.content);
  if (!text) {
    throw new Error("LLM response is empty");
  }

  return {
    text,
    raw: data,
    provider: "anthropic",
    endpoint,
    model: input.model
  };
}

export async function requestLlmCompletion(input: LlmRequest): Promise<LlmResult> {
  if (!input.apiKey || input.apiKey.trim().length < 10) {
    throw new Error("Missing or invalid API key");
  }

  const resolved = await resolveAndValidateLlmEndpoint(input.provider, input.endpoint);

  if (resolved.provider === "anthropic") {
    return callAnthropic(input, resolved.endpoint);
  }

  return callOpenAiCompatible(input, resolved.provider, resolved.endpoint);
}
