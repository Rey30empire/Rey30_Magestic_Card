import { randomUUID } from "node:crypto";
import { Router } from "express";
import { creatorApplySchema, creatorRedeemInviteSchema } from "../schemas/acs.schemas";
import { auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { requirePermission } from "../middleware/authorization";
import { addUserPermissions, assignRoleToUser, getUserPermissions, getUserRoles } from "../services/rbac";
import { parseJsonSafe } from "../utils/json";

type CreatorApplicationRow = {
  id: string;
  user_id: string;
  status: "pending" | "approved" | "rejected" | "suspended";
  message: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
};

type InviteCodeRow = {
  id: string;
  code: string;
  role_key: string;
  permission_grants: string;
  max_uses: number;
  used_count: number;
  status: string;
  expires_at: string | null;
};

const applySchema = creatorApplySchema;
const redeemSchema = creatorRedeemInviteSchema;

export const creatorsRouter = Router();

creatorsRouter.post("/apply", authRequired, requirePermission("creator.apply"), async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const existing = await get<CreatorApplicationRow>("SELECT * FROM creator_applications WHERE user_id = ?", [req.user!.id]);
  const now = new Date().toISOString();

  if (existing && existing.status === "pending") {
    res.status(409).json({ error: "Application is already pending", applicationId: existing.id });
    return;
  }

  if (existing) {
    await run(
      `
        UPDATE creator_applications
        SET status = 'pending',
            message = ?,
            review_note = NULL,
            reviewed_by = NULL,
            updated_at = ?
        WHERE id = ?
      `,
      [parsed.data.message ?? null, now, existing.id]
    );

    await auditLog(req.user!.id, "creators.apply.update", { applicationId: existing.id });

    res.json({
      applicationId: existing.id,
      status: "pending"
    });
    return;
  }

  const id = randomUUID();
  await run(
    `
      INSERT INTO creator_applications (id, user_id, status, message, reviewed_by, review_note, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, NULL, NULL, ?, ?)
    `,
    [id, req.user!.id, parsed.data.message ?? null, now, now]
  );

  await assignRoleToUser(req.user!.id, "creator", req.user!.id);
  await auditLog(req.user!.id, "creators.apply.create", { applicationId: id });

  res.status(201).json({
    applicationId: id,
    status: "pending"
  });
});

creatorsRouter.get("/status", authRequired, async (req, res) => {
  const application = await get<CreatorApplicationRow>(
    `
      SELECT id, user_id, status, message, review_note, created_at, updated_at
      FROM creator_applications
      WHERE user_id = ?
    `,
    [req.user!.id]
  );

  const roles = await getUserRoles(req.user!.id, req.user!.role);
  const permissions = await getUserPermissions(req.user!.id, req.user!.role);

  res.json({
    application: application
      ? {
          id: application.id,
          status: application.status,
          message: application.message,
          reviewNote: application.review_note,
          createdAt: application.created_at,
          updatedAt: application.updated_at
        }
      : null,
    roles,
    permissions
  });
});

creatorsRouter.post("/redeem-invite", authRequired, requirePermission("creator.redeem_invite"), async (req, res) => {
  const parsed = redeemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const invite = await get<InviteCodeRow>(
    `
      SELECT id, code, role_key, permission_grants, max_uses, used_count, status, expires_at
      FROM invite_codes
      WHERE code = ?
    `,
    [parsed.data.code]
  );

  if (!invite) {
    res.status(404).json({ error: "Invite code not found" });
    return;
  }

  if (invite.status !== "active") {
    res.status(409).json({
      error: "Invite code is not active",
      status: invite.status
    });
    return;
  }

  const now = new Date();
  if (invite.expires_at && new Date(invite.expires_at).getTime() < now.getTime()) {
    res.status(410).json({ error: "Invite code expired" });
    return;
  }

  if (invite.used_count >= invite.max_uses) {
    res.status(409).json({ error: "Invite code reached max uses" });
    return;
  }

  const grants = parseJsonSafe<string[]>(invite.permission_grants, []);
  try {
    await run("BEGIN TRANSACTION");

    await assignRoleToUser(req.user!.id, invite.role_key, req.user!.id);

    if (grants.length > 0) {
      await addUserPermissions(req.user!.id, grants, req.user!.id);
    }

    const nextUsedCount = invite.used_count + 1;
    const updateInvite = await run(
      `
        UPDATE invite_codes
        SET used_count = ?,
            status = CASE WHEN ? >= max_uses THEN 'used' ELSE status END,
            updated_at = ?
        WHERE id = ?
          AND status = 'active'
          AND used_count < max_uses
      `,
      [nextUsedCount, nextUsedCount, now.toISOString(), invite.id]
    );

    if (updateInvite.changes === 0) {
      throw new Error("Invite code reached max uses");
    }

    await run(
      `
        UPDATE creator_applications
        SET status = 'approved',
            review_note = 'Approved via invite code redemption',
            updated_at = ?
        WHERE user_id = ?
      `,
      [now.toISOString(), req.user!.id]
    );

    await run("COMMIT");
  } catch (error) {
    await run("ROLLBACK");
    const message = error instanceof Error ? error.message : "Failed to redeem invite";
    if (message === "Invite code reached max uses") {
      res.status(409).json({ error: message });
      return;
    }

    res.status(500).json({ error: message });
    return;
  }

  await auditLog(req.user!.id, "creators.redeem-invite", {
    inviteId: invite.id,
    roleGranted: invite.role_key,
    permissionGrants: grants
  });

  const roles = await getUserRoles(req.user!.id, req.user!.role);
  const permissions = await getUserPermissions(req.user!.id, req.user!.role);

  res.json({
    ok: true,
    roles,
    permissions
  });
});
