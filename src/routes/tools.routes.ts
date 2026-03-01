import { Router } from "express";
import { authRequired } from "../middleware/auth";
import { listSupportedTools } from "../services/tools-registry";

export const toolsRouter = Router();

toolsRouter.get("/", authRequired, (req, res) => {
  const userPermissions = new Set(req.user?.permissions ?? []);
  const isAdmin = (req.user?.roles ?? []).includes("admin");

  const items = listSupportedTools().map((tool) => ({
    key: tool.key,
    name: tool.name,
    description: tool.description,
    requiredPermission: tool.requiredPermission,
    enabledForUser: isAdmin || userPermissions.has(tool.requiredPermission)
  }));

  res.json({ items });
});
