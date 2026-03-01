import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRateLimitPath, sensitiveRateLimit } from "../../src/middleware/rate-limit";

test("normalizeRateLimitPath normalizes dynamic numeric and uuid segments", () => {
  const normalized = normalizeRateLimitPath("/api/training/jobs/123e4567-e89b-12d3-a456-426614174000/cancel/999");
  assert.equal(normalized, "/api/training/jobs/:uuid/cancel/:id");
});

test("normalizeRateLimitPath normalizes hex ids", () => {
  const normalized = normalizeRateLimitPath("/api/cards/507f1f77bcf86cd799439011/details");
  assert.equal(normalized, "/api/cards/:hexid/details");
});

type MockResult = {
  nextCalled: boolean;
  statusCode: number;
  payload: Record<string, unknown> | null;
};

function runSensitiveMiddleware(
  middleware: ReturnType<typeof sensitiveRateLimit>,
  reqInput: {
    userId?: string;
    authorization?: string;
    method?: string;
    baseUrl?: string;
    path?: string;
  }
): MockResult {
  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  let nextCalled = false;

  const headers: Record<string, string | undefined> = {
    authorization: reqInput.authorization
  };

  const req = {
    method: reqInput.method ?? "POST",
    baseUrl: reqInput.baseUrl ?? "/api/training",
    path: reqInput.path ?? "/jobs",
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    user: reqInput.userId ? { id: reqInput.userId } : undefined,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    }
  } as never;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: Record<string, unknown>) {
      payload = value;
      return this;
    }
  } as never;

  middleware(req, res, () => {
    nextCalled = true;
  });

  return {
    nextCalled,
    statusCode,
    payload
  };
}

test("sensitiveRateLimit enforces per-user threshold on sensitive route", () => {
  const middleware = sensitiveRateLimit({
    windowMs: 60_000,
    maxPerUser: 2,
    maxPerToken: 100,
    maxBuckets: 1000
  });

  const auth = "Bearer unit-test-token-user";
  const first = runSensitiveMiddleware(middleware, { userId: "u-user-limit", authorization: auth });
  const second = runSensitiveMiddleware(middleware, { userId: "u-user-limit", authorization: auth });
  const third = runSensitiveMiddleware(middleware, { userId: "u-user-limit", authorization: auth });

  assert.equal(first.nextCalled, true);
  assert.equal(second.nextCalled, true);
  assert.equal(third.nextCalled, false);
  assert.equal(third.statusCode, 429);
  assert.equal(third.payload?.limitScope, "user");
});

test("sensitiveRateLimit enforces per-token threshold when user context is unavailable", () => {
  const middleware = sensitiveRateLimit({
    windowMs: 60_000,
    maxPerUser: 100,
    maxPerToken: 2,
    maxBuckets: 1000
  });

  const auth = "Bearer unit-test-token-only";
  const first = runSensitiveMiddleware(middleware, { authorization: auth });
  const second = runSensitiveMiddleware(middleware, { authorization: auth });
  const third = runSensitiveMiddleware(middleware, { authorization: auth });

  assert.equal(first.nextCalled, true);
  assert.equal(second.nextCalled, true);
  assert.equal(third.nextCalled, false);
  assert.equal(third.statusCode, 429);
  assert.equal(third.payload?.limitScope, "token");
});
