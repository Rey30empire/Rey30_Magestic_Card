import { NextFunction, Request, Response } from "express";
import { CLIENT_PLATFORMS, ClientPlatform } from "../types/platform";

function normalizePlatform(raw: unknown): ClientPlatform {
  if (typeof raw !== "string") {
    return "web";
  }

  const lower = raw.toLowerCase();
  if (CLIENT_PLATFORMS.includes(lower as ClientPlatform)) {
    return lower as ClientPlatform;
  }

  return "web";
}

export function detectClientPlatform(req: Request, _res: Response, next: NextFunction): void {
  req.clientPlatform = normalizePlatform(req.header("x-client-platform"));
  next();
}

export function requirePlatform(required: ClientPlatform) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const current = req.clientPlatform ?? "web";

    if (current !== required) {
      res.status(403).json({
        error: `This endpoint requires ${required} platform`,
        currentPlatform: current,
        requiredPlatform: required
      });
      return;
    }

    next();
  };
}
