import { NextFunction, Request, Response } from "express";
import { hydrateUserAccess } from "../services/rbac";

async function ensureHydrated(req: Request): Promise<void> {
  if (!req.user) {
    return;
  }

  if (req.user.roles && req.user.permissions && req.user.roles.length > 0) {
    return;
  }

  const access = await hydrateUserAccess(req.user.id, req.user.role);
  req.user.role = access.primaryRole;
  req.user.roles = access.roles;
  req.user.permissions = access.permissions;
}

export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    await ensureHydrated(req);

    const userRoles = req.user.roles ?? [req.user.role];
    if (userRoles.includes("admin") || roles.some((role) => userRoles.includes(role))) {
      next();
      return;
    }

    res.status(403).json({ error: "Insufficient role", requiredRoles: roles });
  };
}

export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    await ensureHydrated(req);

    const permissions = req.user.permissions ?? [];
    if ((req.user.roles ?? []).includes("admin") || permissions.includes(permission)) {
      next();
      return;
    }

    res.status(403).json({ error: "Missing permission", permission });
  };
}

export function requireAnyPermission(...permissions: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    await ensureHydrated(req);

    const userPermissions = req.user.permissions ?? [];
    if ((req.user.roles ?? []).includes("admin") || permissions.some((permission) => userPermissions.includes(permission))) {
      next();
      return;
    }

    res.status(403).json({ error: "Missing required permissions", permissions });
  };
}
