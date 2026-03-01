import { NextFunction, Request, Response } from "express";
import { endSpan, normalizeTraceId, runWithTraceContext, startSpan } from "../services/ops-tracing";

function buildPathname(req: Request): string {
  return `${req.baseUrl || ""}${req.path}`;
}

export function collectOpsTracing(req: Request, res: Response, next: NextFunction): void {
  const traceId = normalizeTraceId(req.header("x-trace-id"), req.requestId);
  req.traceId = traceId;
  res.setHeader("x-trace-id", traceId);

  const pathname = buildPathname(req);
  const span = startSpan({
    name: `${req.method} ${pathname || "/"}`,
    kind: "request",
    traceId,
    parentSpanId: null,
    requestId: req.requestId,
    attributes: {
      method: req.method,
      path: pathname || "/",
      clientPlatform: req.clientPlatform ?? "web",
      userId: req.user?.id ?? null
    }
  });

  res.on("finish", () => {
    endSpan(span, {
      status: res.statusCode >= 500 ? "error" : "ok",
      attributes: {
        statusCode: res.statusCode,
        userId: req.user?.id ?? null
      }
    });
  });

  runWithTraceContext(
    {
      traceId,
      activeSpanId: span.spanId,
      requestId: req.requestId
    },
    () => next()
  );
}
