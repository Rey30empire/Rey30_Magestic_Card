import { randomUUID } from "node:crypto";
import { NextFunction, Request, Response } from "express";

const MAX_REQUEST_ID_LENGTH = 120;

function normalizeRequestId(raw: string | undefined): string {
  if (!raw) {
    return randomUUID();
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REQUEST_ID_LENGTH) {
    return randomUUID();
  }

  return trimmed;
}

export function attachRequestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = normalizeRequestId(req.header("x-request-id"));
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}
