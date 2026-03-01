export const ROLE_KEYS = ["user", "creator", "approvedCreator", "moderator", "admin"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const PERMISSION_KEYS = [
  "agents.manage",
  "agents.connect",
  "agents.tools.assign",
  "creator.apply",
  "creator.redeem_invite",
  "dev_tools.access",
  "memory.manage",
  "permissions.assign",
  "publish.agent_template",
  "pro.balance_tools",
  "pro.import",
  "rules.manage.agent",
  "rules.manage.global",
  "rules.manage.project",
  "skills.create",
  "skills.tests.run",
  "training.cancel",
  "training.create",
  "training.view",
  "admin.training.manage",
  "admin.audit.read",
  "admin.creators.review",
  "admin.invites.manage"
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const ROLE_DEFAULT_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  user: ["agents.manage", "agents.connect", "memory.manage", "training.create", "training.view", "training.cancel", "creator.apply", "creator.redeem_invite", "rules.manage.agent"],
  creator: ["agents.manage", "agents.connect", "memory.manage", "training.create", "training.view", "training.cancel", "creator.apply", "creator.redeem_invite", "rules.manage.agent"],
  approvedCreator: [
    "agents.manage",
    "agents.connect",
    "agents.tools.assign",
    "memory.manage",
    "training.create",
    "training.view",
    "training.cancel",
    "creator.apply",
    "creator.redeem_invite",
    "publish.agent_template",
    "pro.import",
    "pro.balance_tools",
    "skills.create",
    "skills.tests.run",
    "dev_tools.access",
    "rules.manage.agent"
  ],
  moderator: ["agents.manage", "memory.manage", "training.view", "rules.manage.agent"],
  admin: [...PERMISSION_KEYS]
};
