import { createHash } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { recordAbuseRiskEvent } from "../services/abuse-detection";

type Bucket = {
  count: number;
  resetAt: number;
  lastSeenAt: number;
};

const buckets = new Map<string, Bucket>();
const sensitiveUserBuckets = new Map<string, Bucket>();
const sensitiveTokenBuckets = new Map<string, Bucket>();
const UUID_SEGMENT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const HEX_ID_SEGMENT = /\b[0-9a-f]{24,64}\b/gi;
const NUMERIC_SEGMENT = /\b\d+\b/g;
const CLEANUP_EVERY_REQUESTS = 200;
let requestsSinceCleanup = 0;

export function normalizeRateLimitPath(pathValue: string): string {
  return pathValue.replace(UUID_SEGMENT, ":uuid").replace(HEX_ID_SEGMENT, ":hexid").replace(NUMERIC_SEGMENT, ":id");
}

function buildKey(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const normalizedPath = normalizeRateLimitPath(`${req.baseUrl || ""}${req.path}`);
  return `${ip}:${req.method}:${normalizedPath}`;
}

function cleanupExpiredBuckets(bucketMap: Map<string, Bucket>, now: number): void {
  for (const [key, bucket] of bucketMap.entries()) {
    if (bucket.resetAt <= now) {
      bucketMap.delete(key);
    }
  }
}

function evictOldestBuckets(bucketMap: Map<string, Bucket>, targetSize: number): void {
  while (bucketMap.size > targetSize) {
    let oldestKey: string | null = null;
    let oldestSeen = Number.POSITIVE_INFINITY;

    for (const [key, bucket] of bucketMap.entries()) {
      if (bucket.lastSeenAt < oldestSeen) {
        oldestSeen = bucket.lastSeenAt;
        oldestKey = key;
      }
    }

    if (!oldestKey) {
      return;
    }

    bucketMap.delete(oldestKey);
  }
}

function consumeBucket(input: {
  bucketMap: Map<string, Bucket>;
  key: string;
  now: number;
  windowMs: number;
  max: number;
  maxBuckets: number;
}): { allowed: boolean; retryAfterMs: number } {
  const { bucketMap, key, now, windowMs, max, maxBuckets } = input;
  const current = bucketMap.get(key);

  if (!current || current.resetAt <= now) {
    if (!current && bucketMap.size >= maxBuckets) {
      cleanupExpiredBuckets(bucketMap, now);
    }

    if (!current && bucketMap.size >= maxBuckets) {
      evictOldestBuckets(bucketMap, maxBuckets - 1);
    }

    bucketMap.set(key, { count: 1, resetAt: now + windowMs, lastSeenAt: now });
    return {
      allowed: true,
      retryAfterMs: 0
    };
  }

  if (current.count >= max) {
    return {
      allowed: false,
      retryAfterMs: Math.max(current.resetAt - now, 0)
    };
  }

  current.count += 1;
  current.lastSeenAt = now;
  bucketMap.set(key, current);
  return {
    allowed: true,
    retryAfterMs: 0
  };
}

function readBearerToken(req: Request): string | null {
  const headerRaw = (typeof req.header === "function" ? req.header("authorization") : req.headers.authorization) ?? "";
  const header = typeof headerRaw === "string" ? headerRaw.trim() : Array.isArray(headerRaw) ? headerRaw[0] ?? "" : "";
  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

function safeRecordSensitiveLimitEvent(input: Parameters<typeof recordAbuseRiskEvent>[0], context: string): void {
  void recordAbuseRiskEvent(input).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("DB is not initialized")) {
      return;
    }

    console.error(`[abuse-risk] failed to record ${context} sensitive rate-limit event`, error);
  });
}

export function rateLimit(options?: { windowMs?: number; max?: number; maxBuckets?: number }) {
  const windowMs = options?.windowMs ?? 60_000;
  const max = options?.max ?? 120;
  const maxBuckets = Math.max(100, options?.maxBuckets ?? 50_000);

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    requestsSinceCleanup += 1;
    if (requestsSinceCleanup % CLEANUP_EVERY_REQUESTS === 0) {
      cleanupExpiredBuckets(buckets, now);
      cleanupExpiredBuckets(sensitiveUserBuckets, now);
      cleanupExpiredBuckets(sensitiveTokenBuckets, now);
    }

    const key = buildKey(req);
    const consumed = consumeBucket({
      bucketMap: buckets,
      key,
      now,
      windowMs,
      max,
      maxBuckets
    });
    if (!consumed.allowed) {
      res.status(429).json({
        error: "Too many requests",
        retryAfterMs: consumed.retryAfterMs
      });
      return;
    }

    next();
  };
}

export function sensitiveRateLimit(options?: {
  windowMs?: number;
  maxPerUser?: number;
  maxPerToken?: number;
  maxBuckets?: number;
}) {
  const windowMs = options?.windowMs ?? 60_000;
  const maxPerUser = Math.max(1, options?.maxPerUser ?? 40);
  const maxPerToken = Math.max(1, options?.maxPerToken ?? 80);
  const maxBuckets = Math.max(100, options?.maxBuckets ?? 50_000);

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    requestsSinceCleanup += 1;
    if (requestsSinceCleanup % CLEANUP_EVERY_REQUESTS === 0) {
      cleanupExpiredBuckets(sensitiveUserBuckets, now);
      cleanupExpiredBuckets(sensitiveTokenBuckets, now);
    }

    const normalizedPath = normalizeRateLimitPath(`${req.baseUrl || ""}${req.path}`);
    const baseKey = `${req.method}:${normalizedPath}`;
    const userId = req.user?.id;
    const token = readBearerToken(req);

    if (userId) {
      const consumed = consumeBucket({
        bucketMap: sensitiveUserBuckets,
        key: `u:${userId}:${baseKey}`,
        now,
        windowMs,
        max: maxPerUser,
        maxBuckets
      });
      if (!consumed.allowed) {
        if (userId) {
          safeRecordSensitiveLimitEvent({
            userId,
            source: "rate-limit",
            eventKey: "rate-limit.sensitive.user",
            metadata: {
              method: req.method,
              path: normalizedPath,
              retryAfterMs: consumed.retryAfterMs
            },
            requestId: req.requestId ?? null,
            traceId: req.traceId ?? null
          }, "user");
        }

        res.status(429).json({
          error: "Too many sensitive requests",
          limitScope: "user",
          retryAfterMs: consumed.retryAfterMs
        });
        return;
      }
    }

    if (token) {
      const consumed = consumeBucket({
        bucketMap: sensitiveTokenBuckets,
        key: `t:${tokenFingerprint(token)}:${baseKey}`,
        now,
        windowMs,
        max: maxPerToken,
        maxBuckets
      });
      if (!consumed.allowed) {
        if (userId) {
          safeRecordSensitiveLimitEvent({
            userId,
            source: "rate-limit",
            eventKey: "rate-limit.sensitive.token",
            metadata: {
              method: req.method,
              path: normalizedPath,
              retryAfterMs: consumed.retryAfterMs
            },
            requestId: req.requestId ?? null,
            traceId: req.traceId ?? null
          }, "token");
        }

        res.status(429).json({
          error: "Too many sensitive requests",
          limitScope: "token",
          retryAfterMs: consumed.retryAfterMs
        });
        return;
      }
    }

    next();
  };
}
