import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { hydrateUserAccess } from "../services/rbac";
import { RoleKey } from "../types/rbac";

type JwtPayload = {
  sub: string;
  username: string;
  role: RoleKey | string;
  iat?: number;
  exp?: number;
};

export function signToken(user: { id: string; username: string; role: RoleKey | string }): string {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role
    },
    env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

export function authRequired(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const token = authHeader.replace("Bearer ", "").trim();

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    void (async () => {
      const access = await hydrateUserAccess(payload.sub, payload.role);
      req.user = {
        id: payload.sub,
        username: payload.username,
        role: access.primaryRole,
        roles: access.roles,
        permissions: access.permissions
      };

      next();
    })().catch((err: unknown) => {
      console.error("auth hydrate error", err);
      res.status(500).json({ error: "Failed to hydrate user access" });
    });
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
