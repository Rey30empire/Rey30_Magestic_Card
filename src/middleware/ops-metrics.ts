import { NextFunction, Request, Response } from "express";
import { recordHttpOutcome } from "../services/ops-metrics";

function buildPathname(req: Request): string {
  return `${req.baseUrl || ""}${req.path}`;
}

export function collectOpsMetrics(req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    recordHttpOutcome(buildPathname(req), res.statusCode);
  });

  next();
}
