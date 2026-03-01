import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sqlite3 from "sqlite3";
import { env } from "../config/env";
import { PERMISSION_KEYS, ROLE_DEFAULT_PERMISSIONS, ROLE_KEYS, RoleKey } from "../types/rbac";
import { mirrorAuditLog } from "./postgres";
import { withSpan } from "../services/ops-tracing";

type SqlValue = string | number | null;

type RoleRow = {
  id: string;
};

type UserRoleRow = {
  id: string;
  role: string;
};

type ActiveListingRow = {
  id: string;
  card_id: string;
};

type VersioningRow = {
  version: number;
};

const sqlite = sqlite3.verbose();
let db: sqlite3.Database | null = null;

function ensureDbDir(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (dir === ".") {
    return;
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeLegacyRole(role: string): RoleKey {
  if (ROLE_KEYS.includes(role as RoleKey)) {
    return role as RoleKey;
  }

  return role === "admin" ? "admin" : "user";
}

async function seedRbacCatalog(): Promise<void> {
  const now = new Date().toISOString();

  for (const roleKey of ROLE_KEYS) {
    await run(
      `
        INSERT OR IGNORE INTO roles (id, key, description, created_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?)
      `,
      [roleKey, `${roleKey} role`, now]
    );
  }

  for (const permissionKey of PERMISSION_KEYS) {
    await run(
      `
        INSERT OR IGNORE INTO permissions (id, key, description, created_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?)
      `,
      [permissionKey, permissionKey, now]
    );
  }

  for (const roleKey of ROLE_KEYS) {
    const role = await get<RoleRow>("SELECT id FROM roles WHERE key = ?", [roleKey]);
    if (!role) {
      continue;
    }

    for (const permissionKey of ROLE_DEFAULT_PERMISSIONS[roleKey]) {
      const permission = await get<RoleRow>("SELECT id FROM permissions WHERE key = ?", [permissionKey]);
      if (!permission) {
        continue;
      }

      await run(
        `
          INSERT OR IGNORE INTO role_permissions (id, role_id, permission_id, created_at)
          VALUES (lower(hex(randomblob(16))), ?, ?, ?)
        `,
        [role.id, permission.id, now]
      );
    }
  }
}

async function ensureLegacyUsersHaveRoleRows(): Promise<void> {
  const users = await all<UserRoleRow>("SELECT id, role FROM users");
  const now = new Date().toISOString();

  for (const user of users) {
    const targetRole = normalizeLegacyRole(user.role);
    const role = await get<RoleRow>("SELECT id FROM roles WHERE key = ?", [targetRole]);
    if (!role) {
      continue;
    }

    const existing = await get<{ id: string }>("SELECT id FROM user_roles WHERE user_id = ? AND role_id = ?", [
      user.id,
      role.id
    ]);

    if (existing) {
      continue;
    }

    await run(
      `
        INSERT INTO user_roles (id, user_id, role_id, assigned_by, created_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, NULL, ?)
      `,
      [user.id, role.id, now]
    );
  }
}

async function normalizeActiveMarketplaceListings(): Promise<void> {
  const activeRows = await all<ActiveListingRow>(
    `
      SELECT id, card_id
      FROM market_listings
      WHERE status = 'active'
      ORDER BY created_at ASC, id ASC
    `
  );

  const seenCardIds = new Set<string>();
  for (const row of activeRows) {
    if (!seenCardIds.has(row.card_id)) {
      seenCardIds.add(row.card_id);
      continue;
    }

    await run("UPDATE market_listings SET status = 'cancelled' WHERE id = ? AND status = 'active'", [row.id]);
  }
}

async function ensureCardsVersioningColumns(): Promise<void> {
  const statusColumn = await get<{ name: string }>("SELECT name FROM pragma_table_info('cards') WHERE name = 'status'");
  if (!statusColumn) {
    await run("ALTER TABLE cards ADD COLUMN status TEXT NOT NULL DEFAULT 'published'");
  }

  const versionColumn = await get<{ name: string }>("SELECT name FROM pragma_table_info('cards') WHERE name = 'version'");
  if (!versionColumn) {
    await run("ALTER TABLE cards ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  }

  const updatedAtColumn = await get<{ name: string }>("SELECT name FROM pragma_table_info('cards') WHERE name = 'updated_at'");
  if (!updatedAtColumn) {
    await run("ALTER TABLE cards ADD COLUMN updated_at TEXT");
  }

  await run("UPDATE cards SET updated_at = created_at WHERE updated_at IS NULL");

  const existingVersions = await all<{ card_id: string; created_at: string }>(
    `
      SELECT c.id as card_id, c.created_at
      FROM cards c
      LEFT JOIN card_versions v ON v.card_id = c.id
      WHERE v.id IS NULL
    `
  ).catch(() => []);

  if (existingVersions.length > 0) {
    for (const card of existingVersions) {
      const snapshot = await get<Record<string, unknown>>(
        `
          SELECT
            id,
            owner_user_id,
            name,
            card_hash,
            r33_signature,
            rarity,
            class,
            abilities,
            summon_cost,
            energy,
            attack,
            defense,
            speed,
            model_3d_url,
            metadata,
            status,
            version,
            created_at,
            updated_at
          FROM cards
          WHERE id = ?
        `,
        [card.card_id]
      );

      if (!snapshot) {
        continue;
      }

      const currentVersion = (snapshot.version as number | undefined) ?? 1;
      await run(
        `
          INSERT INTO card_versions (id, card_id, version, snapshot, change_note, created_by, created_at)
          VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, NULL, ?)
        `,
        [card.card_id, currentVersion, JSON.stringify(snapshot), "legacy bootstrap", card.created_at]
      );
    }
  }
}

async function ensureUserAiConfigColumns(): Promise<void> {
  const permissionsColumn = await get<{ name: string }>(
    "SELECT name FROM pragma_table_info('user_ai_configs') WHERE name = 'permissions_json'"
  ).catch(() => undefined);

  if (!permissionsColumn) {
    await run("ALTER TABLE user_ai_configs ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}'");
  }
}

async function ensureSkillsEnvironmentColumns(): Promise<void> {
  const environmentColumn = await get<{ name: string }>(
    "SELECT name FROM pragma_table_info('skills_catalog') WHERE name = 'environment'"
  ).catch(() => undefined);
  if (!environmentColumn) {
    await run("ALTER TABLE skills_catalog ADD COLUMN environment TEXT NOT NULL DEFAULT 'prod'");
  }
}

async function ensureAgentMarketplaceGovernanceColumns(): Promise<void> {
  const columnsToEnsure = [
    { name: "template_key", sql: "ALTER TABLE agent_marketplace_templates ADD COLUMN template_key TEXT" },
    { name: "version", sql: "ALTER TABLE agent_marketplace_templates ADD COLUMN version INTEGER NOT NULL DEFAULT 1" },
    { name: "parent_template_id", sql: "ALTER TABLE agent_marketplace_templates ADD COLUMN parent_template_id TEXT" },
    { name: "compatibility_min", sql: "ALTER TABLE agent_marketplace_templates ADD COLUMN compatibility_min TEXT NOT NULL DEFAULT '1.0.0'" },
    { name: "compatibility_max", sql: "ALTER TABLE agent_marketplace_templates ADD COLUMN compatibility_max TEXT" },
    { name: "quality_score", sql: "ALTER TABLE agent_marketplace_templates ADD COLUMN quality_score INTEGER NOT NULL DEFAULT 0" },
    { name: "quality_report", sql: "ALTER TABLE agent_marketplace_templates ADD COLUMN quality_report TEXT NOT NULL DEFAULT '{}'" },
    { name: "moderated_by", sql: "ALTER TABLE agent_marketplace_templates ADD COLUMN moderated_by TEXT" },
    { name: "moderated_at", sql: "ALTER TABLE agent_marketplace_templates ADD COLUMN moderated_at TEXT" },
    { name: "moderation_note", sql: "ALTER TABLE agent_marketplace_templates ADD COLUMN moderation_note TEXT" }
  ];

  for (const column of columnsToEnsure) {
    const existing = await get<{ name: string }>(
      "SELECT name FROM pragma_table_info('agent_marketplace_templates') WHERE name = ?",
      [column.name]
    ).catch(() => undefined);
    if (!existing) {
      await run(column.sql);
    }
  }

  await run("UPDATE agent_marketplace_templates SET template_key = id WHERE template_key IS NULL OR trim(template_key) = ''");
  await run("UPDATE agent_marketplace_templates SET compatibility_min = '1.0.0' WHERE compatibility_min IS NULL OR trim(compatibility_min) = ''");
  await run("UPDATE agent_marketplace_templates SET quality_report = '{}' WHERE quality_report IS NULL OR trim(quality_report) = ''");
}

async function ensureAuditLogHashColumns(): Promise<void> {
  const prevHashColumn = await get<{ name: string }>("SELECT name FROM pragma_table_info('audit_logs') WHERE name = 'prev_hash'").catch(
    () => undefined
  );
  if (!prevHashColumn) {
    await run("ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT");
  }

  const entryHashColumn = await get<{ name: string }>("SELECT name FROM pragma_table_info('audit_logs') WHERE name = 'entry_hash'").catch(
    () => undefined
  );
  if (!entryHashColumn) {
    await run("ALTER TABLE audit_logs ADD COLUMN entry_hash TEXT");
  }
}

export async function initDb(): Promise<void> {
  if (db) {
    return;
  }

  ensureDbDir(env.DB_PATH);
  db = new sqlite.Database(env.DB_PATH);
  db.configure("busyTimeout", 5000);

  await run("PRAGMA journal_mode = WAL;");
  await run("PRAGMA foreign_keys = ON;");

  const schemaStatements = [
    `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        creative_points INTEGER NOT NULL DEFAULT 10,
        elo INTEGER NOT NULL DEFAULT 1000,
        created_at TEXT NOT NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        card_hash TEXT NOT NULL UNIQUE,
        r33_signature TEXT,
        rarity TEXT NOT NULL,
        class TEXT NOT NULL,
        abilities TEXT NOT NULL,
        summon_cost INTEGER NOT NULL,
        energy INTEGER NOT NULL,
        attack INTEGER NOT NULL,
        defense INTEGER NOT NULL,
        speed INTEGER NOT NULL,
        model_3d_url TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS card_drafts (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        source_card_id TEXT,
        payload TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        validation_errors TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        published_card_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(source_card_id) REFERENCES cards(id) ON DELETE SET NULL,
        FOREIGN KEY(published_card_id) REFERENCES cards(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS card_versions (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        change_note TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(card_id, version),
        FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE,
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS inventory (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        source TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        acquired_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS market_listings (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        seller_user_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'card',
        price_credits INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE,
        FOREIGN KEY(seller_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS licenses (
        id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL,
        buyer_user_id TEXT NOT NULL,
        license_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(listing_id) REFERENCES market_listings(id) ON DELETE CASCADE,
        FOREIGN KEY(buyer_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS duel_history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        ai_level TEXT NOT NULL,
        result TEXT NOT NULL,
        elo_delta INTEGER NOT NULL,
        creative_points_reward INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        sender_user_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(sender_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        action TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        prev_hash TEXT,
        entry_hash TEXT
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS permissions (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS role_permissions (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        permission_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(role_id, permission_id),
        FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE,
        FOREIGN KEY(permission_id) REFERENCES permissions(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS user_roles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        assigned_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, role_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE,
        FOREIGN KEY(assigned_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS user_permissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        permission_id TEXT NOT NULL,
        assigned_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, permission_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
        FOREIGN KEY(assigned_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS creator_applications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        message TEXT,
        reviewed_by TEXT,
        review_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(reviewed_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS invite_codes (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        role_key TEXT NOT NULL,
        permission_grants TEXT NOT NULL,
        max_uses INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        project_id TEXT,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        detail TEXT,
        personality TEXT,
        lore TEXT,
        memory_scope TEXT NOT NULL DEFAULT 'private',
        status TEXT NOT NULL DEFAULT 'disconnected',
        provider TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS vault_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        label TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_connections (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        keys_ref TEXT,
        config TEXT NOT NULL,
        status TEXT NOT NULL,
        connected_at TEXT,
        disconnected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY(keys_ref) REFERENCES vault_entries(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_config_versions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        reason TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(agent_id, version),
        FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS user_ai_configs (
        user_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        temperature REAL NOT NULL DEFAULT 0.2,
        max_tokens INTEGER NOT NULL DEFAULT 512,
        permissions_json TEXT NOT NULL DEFAULT '{}',
        keys_ref TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(keys_ref) REFERENCES vault_entries(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS global_rules (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        enforcement TEXT NOT NULL,
        priority INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS project_rules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        enforcement TEXT NOT NULL,
        priority INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_rules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        enforcement TEXT NOT NULL,
        priority INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS skills_catalog (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        output_schema TEXT NOT NULL,
        required_tools TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        environment TEXT NOT NULL DEFAULT 'prod',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(name, version),
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_tests (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        name TEXT NOT NULL,
        input_payload TEXT NOT NULL,
        expected_output TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        last_run_at TEXT,
        last_result TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(skill_id) REFERENCES skills_catalog(id) ON DELETE CASCADE,
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_skills (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_version TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY(skill_id) REFERENCES skills_catalog(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_tools (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        tool_key TEXT NOT NULL,
        allowed INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, tool_key),
        FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS rag_memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS training_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT,
        idempotency_key TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        config TEXT NOT NULL,
        platform TEXT NOT NULL,
        logs TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS ops_http_minute_metrics (
        minute_key INTEGER PRIMARY KEY,
        bucket_started_at TEXT NOT NULL,
        total_requests INTEGER NOT NULL DEFAULT 0,
        cards_conflict_409 INTEGER NOT NULL DEFAULT 0,
        marketplace_conflict_409 INTEGER NOT NULL DEFAULT 0,
        rate_limited_429 INTEGER NOT NULL DEFAULT 0,
        client_errors_4xx INTEGER NOT NULL DEFAULT 0,
        server_errors_5xx INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS abuse_risk_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event_key TEXT NOT NULL,
        score INTEGER NOT NULL,
        metadata TEXT NOT NULL,
        request_id TEXT,
        trace_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS abuse_user_blocks (
        user_id TEXT PRIMARY KEY,
        blocked_until TEXT NOT NULL,
        incident_id TEXT,
        reason TEXT NOT NULL,
        score INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS abuse_incidents (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        source TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        score INTEGER NOT NULL,
        threshold INTEGER NOT NULL,
        events_count INTEGER NOT NULL,
        first_event_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL,
        block_until TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_note TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(resolved_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_sandbox_tests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_marketplace_templates (
        id TEXT PRIMARY KEY,
        creator_user_id TEXT NOT NULL,
        source_agent_id TEXT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        tags TEXT NOT NULL,
        template_payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        template_key TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        parent_template_id TEXT,
        compatibility_min TEXT NOT NULL DEFAULT '1.0.0',
        compatibility_max TEXT,
        quality_score INTEGER NOT NULL DEFAULT 0,
        quality_report TEXT NOT NULL DEFAULT '{}',
        moderated_by TEXT,
        moderated_at TEXT,
        moderation_note TEXT,
        imports_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(creator_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(source_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
        FOREIGN KEY(parent_template_id) REFERENCES agent_marketplace_templates(id) ON DELETE SET NULL,
        FOREIGN KEY(moderated_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_tool_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        user_id TEXT NOT NULL,
        tool_key TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_message TEXT,
        request_id TEXT,
        trace_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE SET NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_promotions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        from_environment TEXT NOT NULL,
        to_environment TEXT NOT NULL,
        gate_status TEXT NOT NULL,
        gate_report TEXT NOT NULL,
        note TEXT,
        promoted_by TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(skill_id) REFERENCES skills_catalog(id) ON DELETE CASCADE,
        FOREIGN KEY(promoted_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `
  ];

  const indexStatements = [
    "CREATE INDEX IF NOT EXISTS idx_cards_owner_created ON cards(owner_user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_cards_owner_status_updated ON cards(owner_user_id, status, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_card_drafts_owner_updated ON card_drafts(owner_user_id, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_card_drafts_owner_status_updated ON card_drafts(owner_user_id, status, updated_at DESC);",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_card_drafts_owner_fingerprint_active ON card_drafts(owner_user_id, fingerprint) WHERE status IN ('draft', 'validated');",
    "CREATE INDEX IF NOT EXISTS idx_card_versions_card_version ON card_versions(card_id, version DESC);",
    "CREATE INDEX IF NOT EXISTS idx_inventory_user_active ON inventory(user_id, active);",
    "CREATE INDEX IF NOT EXISTS idx_market_listings_seller_created ON market_listings(seller_user_id, created_at DESC);",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_market_listings_active_card_unique ON market_listings(card_id) WHERE status = 'active';",
    "CREATE INDEX IF NOT EXISTS idx_licenses_buyer_created ON licenses(buyer_user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_duel_history_user_created ON duel_history(user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created ON chat_messages(channel, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs(user_id, created_at DESC);",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_entry_hash_unique ON audit_logs(entry_hash) WHERE entry_hash IS NOT NULL;",
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_prev_hash ON audit_logs(prev_hash);",
    "CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);",
    "CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);",
    "CREATE INDEX IF NOT EXISTS idx_creator_applications_status_updated ON creator_applications(status, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_invite_codes_status_created ON invite_codes(status, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_agents_owner_updated ON agents(owner_user_id, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_agent_config_versions_agent_version ON agent_config_versions(agent_id, version DESC);",
    "CREATE INDEX IF NOT EXISTS idx_agent_rules_agent_level ON agent_rules(agent_id, level, priority DESC);",
    "CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agent_id);",
    "CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id);",
    "CREATE INDEX IF NOT EXISTS idx_skills_catalog_name_version ON skills_catalog(name, version);",
    "CREATE INDEX IF NOT EXISTS idx_skills_catalog_environment_updated ON skills_catalog(environment, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_skill_tests_skill_updated ON skill_tests(skill_id, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_skill_promotions_skill_created ON skill_promotions(skill_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_global_rules_priority ON global_rules(priority DESC, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_project_rules_project_priority ON project_rules(project_id, priority DESC);",
    "CREATE INDEX IF NOT EXISTS idx_rag_memories_user_scope_created ON rag_memories(user_id, scope, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_rag_memories_project_created ON rag_memories(project_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_rag_memories_agent_created ON rag_memories(agent_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_training_jobs_user_created ON training_jobs(user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_training_jobs_status_updated ON training_jobs(status, updated_at DESC);",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_training_jobs_user_idempotency ON training_jobs(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;",
    "CREATE INDEX IF NOT EXISTS idx_ops_http_minute_metrics_updated ON ops_http_minute_metrics(updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_abuse_risk_events_user_created ON abuse_risk_events(user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_abuse_risk_events_source_created ON abuse_risk_events(source, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_abuse_user_blocks_until ON abuse_user_blocks(blocked_until DESC);",
    "CREATE INDEX IF NOT EXISTS idx_abuse_incidents_status_updated ON abuse_incidents(status, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_abuse_incidents_user_updated ON abuse_incidents(user_id, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_sandbox_agent_created ON agent_sandbox_tests(agent_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_agent_templates_creator_created ON agent_marketplace_templates(creator_user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_agent_templates_status_created ON agent_marketplace_templates(status, created_at DESC);",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_templates_key_version ON agent_marketplace_templates(template_key, version) WHERE template_key IS NOT NULL;",
    "CREATE INDEX IF NOT EXISTS idx_agent_tool_runs_agent_created ON agent_tool_runs(agent_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_agent_tool_runs_user_created ON agent_tool_runs(user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_agent_tool_runs_status_created ON agent_tool_runs(status, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_vault_entries_user_created ON vault_entries(user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_projects_owner_updated ON projects(owner_user_id, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_user_ai_configs_updated ON user_ai_configs(updated_at DESC);"
  ];

  for (const statement of schemaStatements) {
    await run(statement);
  }

  const hasTrainingIdempotencyColumn = await get<{ name: string }>(
    "SELECT name FROM pragma_table_info('training_jobs') WHERE name = 'idempotency_key'"
  );
  if (!hasTrainingIdempotencyColumn) {
    await run("ALTER TABLE training_jobs ADD COLUMN idempotency_key TEXT");
  }

  await ensureCardsVersioningColumns();
  await ensureUserAiConfigColumns();
  await ensureSkillsEnvironmentColumns();
  await ensureAgentMarketplaceGovernanceColumns();
  await ensureAuditLogHashColumns();
  await normalizeActiveMarketplaceListings();

  for (const statement of indexStatements) {
    await run(statement);
  }

  await seedRbacCatalog();
  await ensureLegacyUsersHaveRoleRows();
}

function getDb(): sqlite3.Database {
  if (!db) {
    throw new Error("DB is not initialized. Call initDb() first.");
  }

  return db;
}

function summarizeSql(sql: string): { operation: string; table: string } {
  const normalized = sql.replace(/\s+/g, " ").trim();
  const operationMatch = normalized.match(/^([A-Za-z]+)/);
  const operation = operationMatch ? operationMatch[1].toUpperCase() : "UNKNOWN";

  const tableMatch =
    normalized.match(/\bFROM\s+([A-Za-z0-9_]+)/i) ||
    normalized.match(/\bINTO\s+([A-Za-z0-9_]+)/i) ||
    normalized.match(/\bUPDATE\s+([A-Za-z0-9_]+)/i) ||
    normalized.match(/\bTABLE\s+([A-Za-z0-9_]+)/i);

  return {
    operation,
    table: tableMatch ? tableMatch[1] : "unknown"
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function run(sql: string, params: SqlValue[] = []): Promise<{ lastID: number; changes: number }> {
  const summary = summarizeSql(sql);
  return withSpan(
    {
      name: "db.run",
      kind: "db",
      attributes: {
        operation: summary.operation,
        table: summary.table,
        paramCount: params.length
      }
    },
    () =>
      new Promise((resolve, reject) => {
        getDb().run(sql, params, function onRun(err) {
          if (err) {
            reject(err);
            return;
          }

          resolve({ lastID: this.lastID, changes: this.changes });
        });
      })
  );
}

export function get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
  const summary = summarizeSql(sql);
  return withSpan(
    {
      name: "db.get",
      kind: "db",
      attributes: {
        operation: summary.operation,
        table: summary.table,
        paramCount: params.length
      }
    },
    () =>
      new Promise<T | undefined>((resolve, reject) => {
        getDb().get(sql, params, (err, row) => {
          if (err) {
            reject(err);
            return;
          }

          resolve(row as T | undefined);
        });
      })
  );
}

export function all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
  const summary = summarizeSql(sql);
  return withSpan(
    {
      name: "db.all",
      kind: "db",
      attributes: {
        operation: summary.operation,
        table: summary.table,
        paramCount: params.length
      }
    },
    () =>
      new Promise<T[]>((resolve, reject) => {
        getDb().all(sql, params, (err, rows) => {
          if (err) {
            reject(err);
            return;
          }

          resolve(rows as T[]);
        });
      })
  );
}

export async function auditLog(userId: string | null, action: string, payload: unknown): Promise<void> {
  const createdAt = new Date().toISOString();
  const payloadJson = JSON.stringify(payload);
  const previous = await get<{ entry_hash: string | null }>(
    `
      SELECT entry_hash
      FROM audit_logs
      ORDER BY id DESC
      LIMIT 1
    `
  );
  const prevHash = previous?.entry_hash && previous.entry_hash.length > 0 ? previous.entry_hash : "GENESIS";
  const entryHash = sha256Hex(`${createdAt}|${userId ?? ""}|${action}|${payloadJson}|${prevHash}`);

  await run(
    `
      INSERT INTO audit_logs (user_id, action, payload, created_at, prev_hash, entry_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [userId, action, payloadJson, createdAt, prevHash, entryHash]
  );

  try {
    await mirrorAuditLog({
      userId,
      action,
      payload,
      createdAt
    });
  } catch (error) {
    console.error("[postgres-mirror] audit log mirror failed", error);
  }
}
