import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express, { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { all, auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { paginationQuerySchema } from "../schemas/acs.schemas";
import { parseJsonSafe } from "../utils/json";

const assetTypeSchema = z.enum(["model", "material", "rig", "anim", "prefab", "terrain", "scene", "pack"]);
const assetSourceSchema = z.enum(["local", "import", "web", "marketplace"]);
const includeFilesQuerySchema = z.object({
  includeFiles: z.enum(["0", "1", "true", "false"]).optional().default("0")
});
const assetIdParamSchema = z.object({
  id: z.string().uuid()
});
const projectIdParamSchema = z.object({
  projectId: z.string().uuid()
});
const assetFileParamSchema = z.object({
  id: z.string().uuid(),
  fileId: z.string().uuid()
});

const uploadAssetQuerySchema = z.object({
  assetId: z.string().uuid(),
  role: z.string().trim().min(1).max(80).default("file")
});

const vaultFileSchema = z.object({
  path: z.string().trim().min(1).max(400),
  role: z.string().trim().min(1).max(80),
  mimeType: z.string().trim().min(1).max(160).optional(),
  sizeBytes: z.number().int().min(0).max(100_000_000_000).default(0),
  hash: z.string().trim().min(8).max(256).optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

const createAssetSchema = z.object({
  type: assetTypeSchema,
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().min(2).max(4000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(60).default([]),
  author: z.string().trim().min(1).max(120).optional(),
  license: z.string().trim().min(1).max(120).optional(),
  source: assetSourceSchema.default("import"),
  stats: z.record(z.string(), z.unknown()).default({}),
  variants: z.record(z.string(), z.unknown()).default({}),
  dependencies: z.array(z.string().trim().min(1).max(120)).max(120).default([]),
  thumbnailPath: z.string().trim().min(1).max(500).optional(),
  dedupeHash: z.string().trim().min(8).max(256).optional(),
  files: z.array(vaultFileSchema).max(500).default([])
});

const listAssetsQuerySchema = paginationQuerySchema.merge(
  z.object({
    type: assetTypeSchema.optional(),
    source: assetSourceSchema.optional(),
    q: z.string().trim().min(1).max(120).optional(),
    tag: z.string().trim().min(1).max(40).optional(),
    userId: z.string().uuid().optional()
  })
);

const linkAssetSchema = z.object({
  projectId: z.string().uuid(),
  overrides: z.record(z.string(), z.unknown()).default({}),
  embedMode: z.enum(["reference", "embed"]).default("reference")
});

type AssetItemRow = {
  id: string;
  owner_user_id: string;
  type: string;
  name: string;
  description: string | null;
  tags_json: string;
  author: string | null;
  license: string | null;
  source: string;
  stats_json: string;
  variants_json: string;
  dependencies_json: string;
  thumbnail_path: string | null;
  dedupe_hash: string | null;
  created_at: string;
  updated_at: string;
  files_count?: number;
};

type AssetFileRow = {
  id: string;
  asset_id: string;
  file_path: string;
  file_role: string;
  mime_type: string | null;
  size_bytes: number;
  file_hash: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type ProjectRow = {
  id: string;
  owner_user_id: string;
};

type ProjectAssetLinkRow = AssetItemRow & {
  link_id: string;
  project_id: string;
  asset_id: string;
  overrides_json: string;
  embed_mode: "reference" | "embed";
  link_created_at: string;
  link_updated_at: string;
};

const vaultRootDir = path.resolve(env.VAULT_STORAGE_DIR);
const allowedVaultExtensions = new Set<string>(
  env.VAULT_ALLOWED_EXTENSIONS.map((extension) => extension.trim().toLowerCase()).filter((extension) => extension.length > 0)
);

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function sanitizeFileName(rawFileName: string): string {
  const normalized = rawFileName.trim();
  const base = path.basename(normalized).replace(/[^a-zA-Z0-9._-]/g, "_");
  const collapsed = base.replace(/_+/g, "_").replace(/\.+/g, ".");
  if (collapsed.length === 0 || collapsed === "." || collapsed === "..") {
    return "upload.bin";
  }

  return collapsed.slice(0, 180);
}

function resolveAllowedExtension(fileName: string): string {
  return path.extname(fileName).trim().toLowerCase();
}

function isAllowedVaultExtension(extension: string): boolean {
  if (allowedVaultExtensions.has("*")) {
    return true;
  }

  return allowedVaultExtensions.has(extension);
}

function extractHeaderString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  return undefined;
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
        .map((tag) => tag.toLowerCase())
    )
  );
}

function mapAssetFile(row: AssetFileRow): Record<string, unknown> {
  return {
    id: row.id,
    assetId: row.asset_id,
    path: row.file_path,
    role: row.file_role,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes) || 0,
    hash: row.file_hash,
    metadata: parseJsonSafe<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAsset(
  row: AssetItemRow,
  options: {
    files?: Record<string, unknown>[];
  } = {}
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    id: row.id,
    ownerUserId: row.owner_user_id,
    type: row.type,
    name: row.name,
    description: row.description,
    tags: parseJsonSafe<string[]>(row.tags_json, []),
    author: row.author,
    license: row.license,
    source: row.source,
    stats: parseJsonSafe<Record<string, unknown>>(row.stats_json, {}),
    variants: parseJsonSafe<Record<string, unknown>>(row.variants_json, {}),
    dependencies: parseJsonSafe<string[]>(row.dependencies_json, []),
    thumbnailPath: row.thumbnail_path,
    dedupeHash: row.dedupe_hash,
    filesCount: Number(row.files_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

  if (options.files) {
    mapped.files = options.files;
  }

  return mapped;
}

async function fetchAssetFilesByIds(assetIds: string[]): Promise<Map<string, Record<string, unknown>[]>> {
  if (assetIds.length === 0) {
    return new Map<string, Record<string, unknown>[]>();
  }

  const placeholders = assetIds.map(() => "?").join(", ");
  const rows = await all<AssetFileRow>(
    `
      SELECT id, asset_id, file_path, file_role, mime_type, size_bytes, file_hash, metadata_json, created_at, updated_at
      FROM asset_vault_files
      WHERE asset_id IN (${placeholders})
      ORDER BY created_at ASC
    `,
    assetIds
  );

  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const existing = grouped.get(row.asset_id) ?? [];
    existing.push(mapAssetFile(row));
    grouped.set(row.asset_id, existing);
  }

  return grouped;
}

async function getProjectForUser(projectId: string, userId: string, isAdmin: boolean): Promise<ProjectRow | undefined> {
  if (isAdmin) {
    return get<ProjectRow>("SELECT id, owner_user_id FROM projects WHERE id = ?", [projectId]);
  }

  return get<ProjectRow>("SELECT id, owner_user_id FROM projects WHERE id = ? AND owner_user_id = ?", [projectId, userId]);
}

export const assetVaultRouter = Router();

assetVaultRouter.use(authRequired);

assetVaultRouter.post(
  "/upload",
  express.raw({ type: "*/*", limit: Math.max(1, env.VAULT_UPLOAD_MAX_BYTES) }),
  async (req, res) => {
    const parsed = uploadAssetQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
      return;
    }

    const fileNameHeader = extractHeaderString(req.headers["x-file-name"]);
    const requestedFileName = fileNameHeader ?? "upload.bin";
    const fileName = sanitizeFileName(requestedFileName);
    const extension = resolveAllowedExtension(fileName);

    if (!extension || !isAllowedVaultExtension(extension)) {
      res.status(400).json({
        error: "File extension is not allowed",
        details: {
          extension,
          allowed: env.VAULT_ALLOWED_EXTENSIONS
        }
      });
      return;
    }

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (body.length === 0) {
      res.status(400).json({ error: "Empty upload payload" });
      return;
    }
    if (body.length > env.VAULT_UPLOAD_MAX_BYTES) {
      res.status(413).json({
        error: "Payload exceeds vault upload max size",
        details: {
          maxBytes: env.VAULT_UPLOAD_MAX_BYTES
        }
      });
      return;
    }

    const isAdmin = (req.user!.roles ?? []).includes("admin");
    const asset = isAdmin
      ? await get<{ id: string; owner_user_id: string }>("SELECT id, owner_user_id FROM asset_vault_items WHERE id = ?", [
          parsed.data.assetId
        ])
      : await get<{ id: string; owner_user_id: string }>(
          "SELECT id, owner_user_id FROM asset_vault_items WHERE id = ? AND owner_user_id = ?",
          [parsed.data.assetId, req.user!.id]
        );
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    const sha256 = createHash("sha256").update(body).digest("hex");
    const existingByHash = await get<AssetFileRow>(
      `
        SELECT id, asset_id, file_path, file_role, mime_type, size_bytes, file_hash, metadata_json, created_at, updated_at
        FROM asset_vault_files
        WHERE asset_id = ? AND file_hash = ?
        LIMIT 1
      `,
      [asset.id, sha256]
    );
    if (existingByHash) {
      res.status(200).json({
        uploaded: false,
        deduped: true,
        file: mapAssetFile(existingByHash)
      });
      return;
    }

    const now = new Date().toISOString();
    const fileId = randomUUID();
    const contentType = extractHeaderString(req.headers["x-file-mime"]) ?? extractHeaderString(req.headers["content-type"]) ?? null;

    const diskDir = path.join(vaultRootDir, asset.owner_user_id, asset.id, "files");
    await fs.mkdir(diskDir, { recursive: true });

    const diskFileName = `${Date.now()}-${fileId}-${fileName}`;
    const absoluteFilePath = path.join(diskDir, diskFileName);
    await fs.writeFile(absoluteFilePath, body);

    const relativePath = toPosixPath(path.relative(vaultRootDir, absoluteFilePath));

    await run(
      `
        INSERT INTO asset_vault_files (
          id,
          asset_id,
          file_path,
          file_role,
          mime_type,
          size_bytes,
          file_hash,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [fileId, asset.id, relativePath, parsed.data.role, contentType, body.length, sha256, "{}", now, now]
    );
    await run("UPDATE asset_vault_items SET updated_at = ? WHERE id = ?", [now, asset.id]);

    await auditLog(req.user!.id, "asset_vault.file.upload", {
      assetId: asset.id,
      fileId,
      bytes: body.length,
      role: parsed.data.role
    });

    const uploaded = await get<AssetFileRow>(
      `
        SELECT id, asset_id, file_path, file_role, mime_type, size_bytes, file_hash, metadata_json, created_at, updated_at
        FROM asset_vault_files
        WHERE id = ?
      `,
      [fileId]
    );

    res.status(201).json({
      uploaded: true,
      deduped: false,
      file: uploaded ? mapAssetFile(uploaded) : undefined
    });
  }
);

assetVaultRouter.get("/assets", async (req, res) => {
  const parsed = listAssetsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (!isAdmin) {
    where.push("a.owner_user_id = ?");
    params.push(req.user!.id);
  } else if (parsed.data.userId) {
    where.push("a.owner_user_id = ?");
    params.push(parsed.data.userId);
  }

  if (parsed.data.type) {
    where.push("a.type = ?");
    params.push(parsed.data.type);
  }

  if (parsed.data.source) {
    where.push("a.source = ?");
    params.push(parsed.data.source);
  }

  if (parsed.data.q) {
    where.push("(a.name LIKE ? OR COALESCE(a.description, '') LIKE ? OR a.tags_json LIKE ?)");
    const term = `%${parsed.data.q}%`;
    params.push(term, term, term);
  }

  if (parsed.data.tag) {
    where.push("a.tags_json LIKE ?");
    params.push(`%\"${parsed.data.tag.toLowerCase()}\"%`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await all<AssetItemRow>(
    `
      SELECT
        a.id,
        a.owner_user_id,
        a.type,
        a.name,
        a.description,
        a.tags_json,
        a.author,
        a.license,
        a.source,
        a.stats_json,
        a.variants_json,
        a.dependencies_json,
        a.thumbnail_path,
        a.dedupe_hash,
        a.created_at,
        a.updated_at,
        (
          SELECT COUNT(1)
          FROM asset_vault_files f
          WHERE f.asset_id = a.id
        ) AS files_count
      FROM asset_vault_items a
      ${whereSql}
      ORDER BY a.updated_at DESC
      LIMIT ?
      OFFSET ?
    `,
    [...params, parsed.data.limit, parsed.data.offset]
  );

  res.json({
    items: rows.map((row) => mapAsset(row))
  });
});

assetVaultRouter.post("/assets", async (req, res) => {
  const parsed = createAssetSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const dedupeHash = parsed.data.dedupeHash?.toLowerCase() ?? null;
  if (dedupeHash) {
    const existing = await get<{ id: string }>(
      `
        SELECT id
        FROM asset_vault_items
        WHERE owner_user_id = ? AND dedupe_hash = ?
      `,
      [req.user!.id, dedupeHash]
    );

    if (existing) {
      res.status(200).json({
        id: existing.id,
        deduped: true,
        created: false
      });
      return;
    }
  }

  const now = new Date().toISOString();
  const assetId = randomUUID();
  const tags = normalizeTags(parsed.data.tags);

  await run(
    `
      INSERT INTO asset_vault_items (
        id,
        owner_user_id,
        type,
        name,
        description,
        tags_json,
        author,
        license,
        source,
        stats_json,
        variants_json,
        dependencies_json,
        thumbnail_path,
        dedupe_hash,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      assetId,
      req.user!.id,
      parsed.data.type,
      parsed.data.name,
      parsed.data.description ?? null,
      JSON.stringify(tags),
      parsed.data.author ?? null,
      parsed.data.license ?? null,
      parsed.data.source,
      JSON.stringify(parsed.data.stats),
      JSON.stringify(parsed.data.variants),
      JSON.stringify(parsed.data.dependencies),
      parsed.data.thumbnailPath ?? null,
      dedupeHash,
      now,
      now
    ]
  );

  for (const file of parsed.data.files) {
    await run(
      `
        INSERT INTO asset_vault_files (
          id,
          asset_id,
          file_path,
          file_role,
          mime_type,
          size_bytes,
          file_hash,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        assetId,
        file.path,
        file.role,
        file.mimeType ?? null,
        file.sizeBytes,
        file.hash?.toLowerCase() ?? null,
        JSON.stringify(file.metadata),
        now,
        now
      ]
    );
  }

  await auditLog(req.user!.id, "asset_vault.asset.create", {
    assetId,
    type: parsed.data.type,
    source: parsed.data.source,
    files: parsed.data.files.length
  });

  res.status(201).json({
    id: assetId,
    deduped: false,
    created: true
  });
});

assetVaultRouter.get("/assets/:id", async (req, res) => {
  const paramsParsed = assetIdParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid asset id", details: paramsParsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const row = isAdmin
    ? await get<AssetItemRow>(
        `
          SELECT
            id,
            owner_user_id,
            type,
            name,
            description,
            tags_json,
            author,
            license,
            source,
            stats_json,
            variants_json,
            dependencies_json,
            thumbnail_path,
            dedupe_hash,
            created_at,
            updated_at,
            (
              SELECT COUNT(1)
              FROM asset_vault_files f
              WHERE f.asset_id = asset_vault_items.id
            ) AS files_count
          FROM asset_vault_items
          WHERE id = ?
        `,
        [paramsParsed.data.id]
      )
    : await get<AssetItemRow>(
        `
          SELECT
            id,
            owner_user_id,
            type,
            name,
            description,
            tags_json,
            author,
            license,
            source,
            stats_json,
            variants_json,
            dependencies_json,
            thumbnail_path,
            dedupe_hash,
            created_at,
            updated_at,
            (
              SELECT COUNT(1)
              FROM asset_vault_files f
              WHERE f.asset_id = asset_vault_items.id
            ) AS files_count
          FROM asset_vault_items
          WHERE id = ? AND owner_user_id = ?
        `,
        [paramsParsed.data.id, req.user!.id]
      );

  if (!row) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  const files = await all<AssetFileRow>(
    `
      SELECT id, asset_id, file_path, file_role, mime_type, size_bytes, file_hash, metadata_json, created_at, updated_at
      FROM asset_vault_files
      WHERE asset_id = ?
      ORDER BY created_at ASC
    `,
    [row.id]
  );

  res.json({
    asset: mapAsset(row, { files: files.map(mapAssetFile) })
  });
});

assetVaultRouter.get("/assets/:id/files/:fileId/download", async (req, res) => {
  const paramsParsed = assetFileParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid params", details: paramsParsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const asset = isAdmin
    ? await get<{ id: string }>("SELECT id FROM asset_vault_items WHERE id = ?", [paramsParsed.data.id])
    : await get<{ id: string }>("SELECT id FROM asset_vault_items WHERE id = ? AND owner_user_id = ?", [
        paramsParsed.data.id,
        req.user!.id
      ]);
  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  const file = await get<AssetFileRow>(
    `
      SELECT id, asset_id, file_path, file_role, mime_type, size_bytes, file_hash, metadata_json, created_at, updated_at
      FROM asset_vault_files
      WHERE id = ? AND asset_id = ?
    `,
    [paramsParsed.data.fileId, asset.id]
  );
  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const absolutePath = path.resolve(path.join(vaultRootDir, file.file_path));
  const storageRootWithSep = `${vaultRootDir}${path.sep}`;
  if (!absolutePath.startsWith(storageRootWithSep) && absolutePath !== vaultRootDir) {
    res.status(400).json({ error: "Invalid file path" });
    return;
  }

  try {
    await fs.access(absolutePath);
  } catch {
    res.status(404).json({ error: "File not found on disk" });
    return;
  }

  const safeName = sanitizeFileName(path.basename(file.file_path));
  if (file.mime_type) {
    res.setHeader("Content-Type", file.mime_type);
  } else {
    res.setHeader("Content-Type", "application/octet-stream");
  }
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.sendFile(absolutePath);
});

assetVaultRouter.post("/assets/:id/link", async (req, res) => {
  const paramsParsed = assetIdParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid asset id", details: paramsParsed.error.flatten() });
    return;
  }

  const parsed = linkAssetSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const asset = isAdmin
    ? await get<{ id: string }>("SELECT id FROM asset_vault_items WHERE id = ?", [paramsParsed.data.id])
    : await get<{ id: string }>("SELECT id FROM asset_vault_items WHERE id = ? AND owner_user_id = ?", [
        paramsParsed.data.id,
        req.user!.id
      ]);
  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  const project = await getProjectForUser(parsed.data.projectId, req.user!.id, isAdmin);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const now = new Date().toISOString();
  const existing = await get<{ id: string }>("SELECT id FROM project_asset_links WHERE project_id = ? AND asset_id = ?", [
    project.id,
    asset.id
  ]);

  if (existing) {
    await run(
      `
        UPDATE project_asset_links
        SET overrides_json = ?, embed_mode = ?, updated_at = ?
        WHERE id = ?
      `,
      [JSON.stringify(parsed.data.overrides), parsed.data.embedMode, now, existing.id]
    );

    await auditLog(req.user!.id, "asset_vault.asset.link", {
      linkId: existing.id,
      assetId: asset.id,
      projectId: project.id,
      mode: "update"
    });

    res.status(200).json({
      id: existing.id,
      projectId: project.id,
      assetId: asset.id,
      embedMode: parsed.data.embedMode,
      overrides: parsed.data.overrides,
      created: false
    });
    return;
  }

  const linkId = randomUUID();
  await run(
    `
      INSERT INTO project_asset_links (id, project_id, asset_id, linked_by, overrides_json, embed_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [linkId, project.id, asset.id, req.user!.id, JSON.stringify(parsed.data.overrides), parsed.data.embedMode, now, now]
  );

  await auditLog(req.user!.id, "asset_vault.asset.link", {
    linkId,
    assetId: asset.id,
    projectId: project.id,
    mode: "create"
  });

  res.status(201).json({
    id: linkId,
    projectId: project.id,
    assetId: asset.id,
    embedMode: parsed.data.embedMode,
    overrides: parsed.data.overrides,
    created: true
  });
});

assetVaultRouter.get("/projects/:projectId/assets", async (req, res) => {
  const paramsParsed = projectIdParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid project id", details: paramsParsed.error.flatten() });
    return;
  }

  const queryParsed = includeFilesQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.status(400).json({ error: "Invalid query", details: queryParsed.error.flatten() });
    return;
  }

  const includeFiles = queryParsed.data.includeFiles === "1" || queryParsed.data.includeFiles === "true";
  const isAdmin = (req.user!.roles ?? []).includes("admin");
  const project = await getProjectForUser(paramsParsed.data.projectId, req.user!.id, isAdmin);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const rows = await all<ProjectAssetLinkRow>(
    `
      SELECT
        l.id AS link_id,
        l.project_id,
        l.asset_id,
        l.overrides_json,
        l.embed_mode,
        l.created_at AS link_created_at,
        l.updated_at AS link_updated_at,
        a.id,
        a.owner_user_id,
        a.type,
        a.name,
        a.description,
        a.tags_json,
        a.author,
        a.license,
        a.source,
        a.stats_json,
        a.variants_json,
        a.dependencies_json,
        a.thumbnail_path,
        a.dedupe_hash,
        a.created_at,
        a.updated_at,
        (
          SELECT COUNT(1)
          FROM asset_vault_files f
          WHERE f.asset_id = a.id
        ) AS files_count
      FROM project_asset_links l
      INNER JOIN asset_vault_items a ON a.id = l.asset_id
      WHERE l.project_id = ?
      ORDER BY l.updated_at DESC
    `,
    [project.id]
  );

  const filesByAssetId = includeFiles ? await fetchAssetFilesByIds(rows.map((row) => row.id)) : new Map<string, Record<string, unknown>[]>();

  res.json({
    items: rows.map((row) => ({
      link: {
        id: row.link_id,
        projectId: row.project_id,
        assetId: row.asset_id,
        embedMode: row.embed_mode,
        overrides: parseJsonSafe<Record<string, unknown>>(row.overrides_json, {}),
        createdAt: row.link_created_at,
        updatedAt: row.link_updated_at
      },
      asset: mapAsset(row, includeFiles ? { files: filesByAssetId.get(row.id) ?? [] } : {})
    }))
  });
});
