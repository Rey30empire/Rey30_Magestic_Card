import { randomUUID } from "node:crypto";
import { all, get, run } from "../db/sqlite";
import { PERMISSION_KEYS, PermissionKey, ROLE_KEYS, RoleKey } from "../types/rbac";

type RoleRow = { id: string; key: string };
type PermissionRow = { id: string; key: string };
type UserRoleRow = { key: string };
type UserPermissionRow = { key: string };
type LegacyRoleRow = { role: string };

const ROLE_PRIORITY: string[] = ["admin", "approvedCreator", "moderator", "creator", "user"];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeRole(role: string): string {
  if (ROLE_KEYS.includes(role as RoleKey)) {
    return role;
  }

  return role === "admin" ? "admin" : "user";
}

export function selectPrimaryRole(roles: string[]): string {
  const normalized = unique(roles.map(normalizeRole));

  for (const candidate of ROLE_PRIORITY) {
    if (normalized.includes(candidate)) {
      return candidate;
    }
  }

  return "user";
}

async function getRole(roleKey: string): Promise<RoleRow | undefined> {
  return get<RoleRow>("SELECT id, key FROM roles WHERE key = ?", [normalizeRole(roleKey)]);
}

async function getPermission(permissionKey: string): Promise<PermissionRow | undefined> {
  return get<PermissionRow>("SELECT id, key FROM permissions WHERE key = ?", [permissionKey]);
}

async function getLegacyRole(userId: string): Promise<string> {
  const row = await get<LegacyRoleRow>("SELECT role FROM users WHERE id = ?", [userId]);
  return row ? normalizeRole(row.role) : "user";
}

export async function syncLegacyRoleColumn(userId: string): Promise<void> {
  const roles = await all<UserRoleRow>(
    `
      SELECT r.key
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
    `,
    [userId]
  );

  const nextRole = selectPrimaryRole(roles.map((r) => r.key));
  await run("UPDATE users SET role = ? WHERE id = ?", [nextRole, userId]);
}

export async function ensureUserRoleAssignment(userId: string, preferredRole?: string): Promise<void> {
  const existingRoles = await all<UserRoleRow>(
    `
      SELECT r.key
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
    `,
    [userId]
  );

  if (existingRoles.length > 0) {
    return;
  }

  const fallbackRole = normalizeRole(preferredRole ?? (await getLegacyRole(userId)));
  await assignRoleToUser(userId, fallbackRole, null);
}

export async function assignRoleToUser(userId: string, roleKey: string, assignedBy: string | null): Promise<void> {
  const role = await getRole(roleKey);
  if (!role) {
    throw new Error(`Role not found: ${roleKey}`);
  }

  const existing = await get<{ id: string }>("SELECT id FROM user_roles WHERE user_id = ? AND role_id = ?", [userId, role.id]);
  if (existing) {
    return;
  }

  await run(
    `
      INSERT INTO user_roles (id, user_id, role_id, assigned_by, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    [randomUUID(), userId, role.id, assignedBy, new Date().toISOString()]
  );

  await syncLegacyRoleColumn(userId);
}

export async function removeRoleFromUser(userId: string, roleKey: string): Promise<void> {
  const role = await getRole(roleKey);
  if (!role) {
    return;
  }

  await run("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?", [userId, role.id]);
  await syncLegacyRoleColumn(userId);
}

export async function setUserPermissionOverrides(
  userId: string,
  permissionKeys: string[],
  assignedBy: string | null
): Promise<void> {
  const safeKeys = unique(permissionKeys).filter((key) => PERMISSION_KEYS.includes(key as PermissionKey));

  await run("DELETE FROM user_permissions WHERE user_id = ?", [userId]);

  const now = new Date().toISOString();
  for (const key of safeKeys) {
    const permission = await getPermission(key);
    if (!permission) {
      continue;
    }

    await run(
      `
        INSERT INTO user_permissions (id, user_id, permission_id, assigned_by, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      [randomUUID(), userId, permission.id, assignedBy, now]
    );
  }
}

export async function addUserPermissions(userId: string, permissionKeys: string[], assignedBy: string | null): Promise<void> {
  const now = new Date().toISOString();

  for (const key of unique(permissionKeys)) {
    if (!PERMISSION_KEYS.includes(key as PermissionKey)) {
      continue;
    }

    const permission = await getPermission(key);
    if (!permission) {
      continue;
    }

    const existing = await get<{ id: string }>("SELECT id FROM user_permissions WHERE user_id = ? AND permission_id = ?", [userId, permission.id]);
    if (existing) {
      continue;
    }

    await run(
      `
        INSERT INTO user_permissions (id, user_id, permission_id, assigned_by, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      [randomUUID(), userId, permission.id, assignedBy, now]
    );
  }
}

export async function getUserRoles(userId: string, fallbackRole?: string): Promise<string[]> {
  const rows = await all<UserRoleRow>(
    `
      SELECT r.key
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
    `,
    [userId]
  );

  const roles = rows.map((r) => r.key);

  if (roles.length === 0) {
    const fallback = normalizeRole(fallbackRole ?? (await getLegacyRole(userId)));
    return [fallback];
  }

  return unique(roles.map(normalizeRole));
}

export async function getUserPermissions(userId: string, fallbackRole?: string): Promise<string[]> {
  const inherited = await all<UserPermissionRow>(
    `
      SELECT DISTINCT p.key
      FROM user_roles ur
      INNER JOIN role_permissions rp ON rp.role_id = ur.role_id
      INNER JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = ?
    `,
    [userId]
  );

  const direct = await all<UserPermissionRow>(
    `
      SELECT DISTINCT p.key
      FROM user_permissions up
      INNER JOIN permissions p ON p.id = up.permission_id
      WHERE up.user_id = ?
    `,
    [userId]
  );

  const merged = unique([...inherited.map((r) => r.key), ...direct.map((r) => r.key)]);
  if (merged.length > 0) {
    return merged;
  }

  const roles = await getUserRoles(userId, fallbackRole);
  const fallback = await all<UserPermissionRow>(
    `
      SELECT DISTINCT p.key
      FROM roles r
      INNER JOIN role_permissions rp ON rp.role_id = r.id
      INNER JOIN permissions p ON p.id = rp.permission_id
      WHERE r.key IN (${roles.map(() => "?").join(",")})
    `,
    roles
  );

  return unique(fallback.map((r) => r.key));
}

export async function hydrateUserAccess(userId: string, fallbackRole?: string): Promise<{ roles: string[]; permissions: string[]; primaryRole: string }> {
  await ensureUserRoleAssignment(userId, fallbackRole);
  const roles = await getUserRoles(userId, fallbackRole);
  const permissions = await getUserPermissions(userId, fallbackRole);

  return {
    roles,
    permissions,
    primaryRole: selectPrimaryRole(roles)
  };
}

export async function userHasRole(userId: string, role: string, fallbackRole?: string): Promise<boolean> {
  const roles = await getUserRoles(userId, fallbackRole);
  return roles.includes(normalizeRole(role));
}

export async function userHasPermission(userId: string, permission: string, fallbackRole?: string): Promise<boolean> {
  const permissions = await getUserPermissions(userId, fallbackRole);
  return permissions.includes(permission);
}
