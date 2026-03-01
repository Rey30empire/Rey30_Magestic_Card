import { NextFunction, Request, Response } from "express";
import { getActiveAbuseBlock } from "../services/abuse-detection";

export function requireNoAbuseBlock() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user?.id) {
      next();
      return;
    }

    const block = await getActiveAbuseBlock(req.user.id);
    if (!block) {
      next();
      return;
    }

    const retryAfterMs = Math.max(0, Date.parse(block.blockedUntil) - Date.now());
    res.status(429).json({
      error: "Temporarily blocked due to abuse risk",
      blockedUntil: block.blockedUntil,
      retryAfterMs,
      incidentId: block.incidentId,
      reason: block.reason
    });
  };
}
