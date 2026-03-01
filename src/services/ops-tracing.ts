import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";

export type TraceSpanKind = "request" | "db" | "queue" | "service";
export type TraceSpanStatus = "ok" | "error";
type TraceAttrValue = string | number | boolean | null;
type TraceAttributes = Record<string, TraceAttrValue>;

type TraceSpanStored = {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  kind: TraceSpanKind;
  status: TraceSpanStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  attributes: TraceAttributes;
  errorMessage: string | null;
  requestId: string | null;
  endedAtMs: number;
};

export type TraceSpan = Omit<TraceSpanStored, "endedAtMs">;

type TraceSpanHandle = {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  kind: TraceSpanKind;
  startedAt: string;
  startedAtMs: number;
  attributes: TraceAttributes;
  requestId: string | null;
};

export type TraceContext = {
  traceId: string;
  activeSpanId?: string;
  requestId?: string;
};

const traceStorage = new AsyncLocalStorage<TraceContext>();
const spans: TraceSpanStored[] = [];
const MAX_SPANS = Math.max(500, Math.trunc(env.OPS_TRACE_MAX_SPANS));

function nowMs(): number {
  return Date.now();
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function trimTraceId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return randomUUID();
  }
  if (trimmed.length > 120) {
    return trimmed.slice(0, 120);
  }
  return trimmed;
}

export function createTraceId(): string {
  return randomUUID();
}

export function normalizeTraceId(raw: string | undefined, fallback?: string): string {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return trimTraceId(raw);
  }
  if (fallback && fallback.trim().length > 0) {
    return trimTraceId(fallback);
  }
  return createTraceId();
}

export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

function pushSpan(span: TraceSpanStored): void {
  spans.push(span);
  if (spans.length > MAX_SPANS) {
    spans.splice(0, spans.length - MAX_SPANS);
  }
}

export function startSpan(input: {
  name: string;
  kind: TraceSpanKind;
  traceId?: string;
  parentSpanId?: string | null;
  attributes?: TraceAttributes;
  requestId?: string;
}): TraceSpanHandle {
  const store = getTraceContext();
  const traceId = normalizeTraceId(input.traceId, store?.traceId);
  const parentSpanId = input.parentSpanId === undefined ? (store?.activeSpanId ?? null) : input.parentSpanId;
  const startedAtMs = nowMs();

  return {
    spanId: randomUUID(),
    traceId,
    parentSpanId,
    name: input.name,
    kind: input.kind,
    startedAt: toIso(startedAtMs),
    startedAtMs,
    attributes: { ...(input.attributes ?? {}) },
    requestId: input.requestId ?? store?.requestId ?? null
  };
}

export function endSpan(
  handle: TraceSpanHandle,
  input?: {
    status?: TraceSpanStatus;
    attributes?: TraceAttributes;
    error?: unknown;
  }
): TraceSpan {
  const endedAtMs = nowMs();
  const status = input?.status ?? (input?.error ? "error" : "ok");
  const errorMessage = input?.error ? (input.error instanceof Error ? input.error.message : String(input.error)) : null;

  const stored: TraceSpanStored = {
    spanId: handle.spanId,
    traceId: handle.traceId,
    parentSpanId: handle.parentSpanId,
    name: handle.name,
    kind: handle.kind,
    status,
    startedAt: handle.startedAt,
    endedAt: toIso(endedAtMs),
    durationMs: Math.max(0, endedAtMs - handle.startedAtMs),
    attributes: {
      ...handle.attributes,
      ...(input?.attributes ?? {})
    },
    errorMessage,
    requestId: handle.requestId,
    endedAtMs
  };

  pushSpan(stored);

  const { endedAtMs: _drop, ...publicSpan } = stored;
  return publicSpan;
}

export async function withSpan<T>(
  input: {
    name: string;
    kind: TraceSpanKind;
    attributes?: TraceAttributes;
  },
  fn: () => Promise<T> | T
): Promise<T> {
  const parent = getTraceContext();
  const handle = startSpan({
    name: input.name,
    kind: input.kind,
    traceId: parent?.traceId,
    parentSpanId: parent?.activeSpanId ?? null,
    attributes: input.attributes,
    requestId: parent?.requestId
  });

  const context: TraceContext = {
    traceId: handle.traceId,
    activeSpanId: handle.spanId,
    requestId: handle.requestId ?? undefined
  };

  return runWithTraceContext(context, async () => {
    try {
      const result = await fn();
      endSpan(handle, { status: "ok" });
      return result;
    } catch (error) {
      endSpan(handle, { status: "error", error });
      throw error;
    }
  });
}

export function listTraceSpans(input?: {
  minutes?: number;
  limit?: number;
  traceId?: string;
  kinds?: TraceSpanKind[];
}): TraceSpan[] {
  const minutes = Math.max(1, Math.min(360, Math.trunc(input?.minutes ?? 15)));
  const limit = Math.max(1, Math.min(2000, Math.trunc(input?.limit ?? 200)));
  const minEndedAtMs = nowMs() - minutes * 60_000;
  const traceIdFilter = input?.traceId ? trimTraceId(input.traceId) : null;
  const kindsFilter = input?.kinds && input.kinds.length > 0 ? new Set(input.kinds) : null;

  const items: TraceSpan[] = [];
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const row = spans[index];
    if (row.endedAtMs < minEndedAtMs) {
      break;
    }

    if (traceIdFilter && row.traceId !== traceIdFilter) {
      continue;
    }
    if (kindsFilter && !kindsFilter.has(row.kind)) {
      continue;
    }

    const { endedAtMs: _drop, ...publicSpan } = row;
    items.push(publicSpan);
    if (items.length >= limit) {
      break;
    }
  }

  return items;
}

export function exportTraceSpans(input?: {
  minutes?: number;
  limit?: number;
  traceId?: string;
  kinds?: TraceSpanKind[];
}): { items: TraceSpan[]; ndjson: string } {
  const items = listTraceSpans(input);
  const ndjson = items.map((item) => JSON.stringify(item)).join("\n");
  return { items, ndjson };
}
