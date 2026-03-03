type ReyMeshyMetricOutcome = "ok" | "error";

type ReyMeshyMetricEvent = {
  atMs: number;
  outcome: ReyMeshyMetricOutcome;
  latencyMs: number;
  inputBytes: number;
  inputVertices: number;
  inputTriangles: number;
  outputTriangles: number | null;
  errorCode?: string;
};

type ReyMeshyAggregate = {
  requests: number;
  ok: number;
  failed: number;
  avgLatencyMs: number;
  avgInputBytes: number;
  avgInputTriangles: number;
};

const events: ReyMeshyMetricEvent[] = [];
const MAX_EVENTS = 5000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const totals = {
  requests: 0,
  ok: 0,
  failed: 0,
  latencyMsTotal: 0,
  inputBytesTotal: 0,
  inputTrianglesTotal: 0
};

let lastEvent: ReyMeshyMetricEvent | null = null;

function clampWindowMinutes(input: number): number {
  return Math.max(1, Math.min(180, Math.trunc(input)));
}

function toAverage(total: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Number((total / count).toFixed(2));
}

function pruneEvents(nowMs: number): void {
  const minAllowed = nowMs - MAX_AGE_MS;
  while (events.length > 0 && events[0].atMs < minAllowed) {
    events.shift();
  }
  while (events.length > MAX_EVENTS) {
    events.shift();
  }
}

function summarize(input: ReyMeshyMetricEvent[]): ReyMeshyAggregate {
  if (input.length === 0) {
    return {
      requests: 0,
      ok: 0,
      failed: 0,
      avgLatencyMs: 0,
      avgInputBytes: 0,
      avgInputTriangles: 0
    };
  }

  let ok = 0;
  let failed = 0;
  let latencyMsTotal = 0;
  let inputBytesTotal = 0;
  let inputTrianglesTotal = 0;

  for (const event of input) {
    if (event.outcome === "ok") {
      ok += 1;
    } else {
      failed += 1;
    }
    latencyMsTotal += event.latencyMs;
    inputBytesTotal += event.inputBytes;
    inputTrianglesTotal += event.inputTriangles;
  }

  return {
    requests: input.length,
    ok,
    failed,
    avgLatencyMs: toAverage(latencyMsTotal, input.length),
    avgInputBytes: toAverage(inputBytesTotal, input.length),
    avgInputTriangles: toAverage(inputTrianglesTotal, input.length)
  };
}

export function recordReyMeshyCleanupMetric(input: {
  outcome: ReyMeshyMetricOutcome;
  latencyMs: number;
  inputBytes: number;
  inputVertices: number;
  inputTriangles: number;
  outputTriangles: number | null;
  errorCode?: string;
}): void {
  const nowMs = Date.now();
  pruneEvents(nowMs);

  const event: ReyMeshyMetricEvent = {
    atMs: nowMs,
    outcome: input.outcome,
    latencyMs: Math.max(0, Math.trunc(input.latencyMs)),
    inputBytes: Math.max(0, Math.trunc(input.inputBytes)),
    inputVertices: Math.max(0, Math.trunc(input.inputVertices)),
    inputTriangles: Math.max(0, Math.trunc(input.inputTriangles)),
    outputTriangles: typeof input.outputTriangles === "number" && Number.isFinite(input.outputTriangles)
      ? Math.max(0, Math.trunc(input.outputTriangles))
      : null,
    errorCode: typeof input.errorCode === "string" && input.errorCode.length > 0 ? input.errorCode : undefined
  };

  events.push(event);
  pruneEvents(nowMs);
  lastEvent = event;

  totals.requests += 1;
  if (event.outcome === "ok") {
    totals.ok += 1;
  } else {
    totals.failed += 1;
  }
  totals.latencyMsTotal += event.latencyMs;
  totals.inputBytesTotal += event.inputBytes;
  totals.inputTrianglesTotal += event.inputTriangles;
}

export function getReyMeshyCleanupMetricsSnapshot(windowMinutes = 15): {
  timestamp: string;
  totals: ReyMeshyAggregate;
  window: ReyMeshyAggregate & { minutes: number };
  last: {
    at: string | null;
    outcome: ReyMeshyMetricOutcome | null;
    latencyMs: number | null;
    inputBytes: number | null;
    inputVertices: number | null;
    inputTriangles: number | null;
    outputTriangles: number | null;
    errorCode: string | null;
  };
} {
  const nowMs = Date.now();
  const minutes = clampWindowMinutes(windowMinutes);
  pruneEvents(nowMs);

  const windowStart = nowMs - minutes * 60_000;
  const windowEvents = events.filter((event) => event.atMs >= windowStart);

  return {
    timestamp: new Date(nowMs).toISOString(),
    totals: {
      requests: totals.requests,
      ok: totals.ok,
      failed: totals.failed,
      avgLatencyMs: toAverage(totals.latencyMsTotal, totals.requests),
      avgInputBytes: toAverage(totals.inputBytesTotal, totals.requests),
      avgInputTriangles: toAverage(totals.inputTrianglesTotal, totals.requests)
    },
    window: {
      minutes,
      ...summarize(windowEvents)
    },
    last: {
      at: lastEvent ? new Date(lastEvent.atMs).toISOString() : null,
      outcome: lastEvent?.outcome ?? null,
      latencyMs: lastEvent?.latencyMs ?? null,
      inputBytes: lastEvent?.inputBytes ?? null,
      inputVertices: lastEvent?.inputVertices ?? null,
      inputTriangles: lastEvent?.inputTriangles ?? null,
      outputTriangles: lastEvent?.outputTriangles ?? null,
      errorCode: lastEvent?.errorCode ?? null
    }
  };
}
