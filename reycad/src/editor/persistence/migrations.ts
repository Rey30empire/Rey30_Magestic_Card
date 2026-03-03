import { createProject } from "../../engine/scenegraph/factory";
import type { PhysicsConstraint, Project, TextureAsset } from "../../engine/scenegraph/types";

export const CURRENT_PROJECT_VERSION = 3;

function normalizeRuntimeMode(input: unknown): "static" | "arena" {
  return input === "arena" ? "arena" : "static";
}

function normalizeConstraint(input: unknown): PhysicsConstraint | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = input as Partial<PhysicsConstraint>;
  if (typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }
  if (value.type !== "distance") {
    return null;
  }
  if (typeof value.a !== "string" || value.a.length === 0) {
    return null;
  }
  if (typeof value.b !== "string" || value.b.length === 0) {
    return null;
  }

  const restLength = Number.isFinite(value.restLength) ? Math.max(0.001, value.restLength as number) : 1;
  const stiffness = Number.isFinite(value.stiffness) ? Math.max(0, Math.min(1, value.stiffness as number)) : 0.6;
  const damping = Number.isFinite(value.damping) ? Math.max(0, Math.min(1, value.damping as number)) : 0.1;

  return {
    id: value.id,
    type: "distance",
    a: value.a,
    b: value.b,
    restLength,
    stiffness,
    damping,
    enabled: value.enabled !== false
  };
}

function normalizeConstraints(input: unknown): PhysicsConstraint[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const result: PhysicsConstraint[] = [];
  for (const item of input) {
    const next = normalizeConstraint(item);
    if (next) {
      result.push(next);
    }
  }
  return result;
}

function normalizeTextureAsset(input: unknown): TextureAsset | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const value = input as Partial<TextureAsset>;
  if (typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    return null;
  }
  if (typeof value.mimeType !== "string" || value.mimeType.length === 0) {
    return null;
  }
  if (typeof value.dataUrl !== "string" || value.dataUrl.length === 0) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    dataUrl: value.dataUrl,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    width: Number.isFinite(value.width) ? (value.width as number) : undefined,
    height: Number.isFinite(value.height) ? (value.height as number) : undefined
  };
}

function normalizeTextures(input: unknown): Record<string, TextureAsset> {
  if (!input || typeof input !== "object") {
    return {};
  }
  const result: Record<string, TextureAsset> = {};
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    const normalized = normalizeTextureAsset(raw);
    if (!normalized) {
      continue;
    }
    result[id] = normalized;
  }
  return result;
}

function mergeWithFallback(project: Project): Project {
  const fallback = createProject();
  return {
    ...fallback,
    ...project,
    textures: normalizeTextures((project as { textures?: unknown }).textures),
    grid: {
      ...fallback.grid,
      ...project.grid
    },
    physics: {
      ...fallback.physics,
      ...(project.physics ?? {}),
      runtimeMode: normalizeRuntimeMode((project.physics as { runtimeMode?: unknown } | undefined)?.runtimeMode),
      constraints: normalizeConstraints((project.physics as { constraints?: unknown } | undefined)?.constraints)
    }
  };
}

export function migrateProject(project: Project): Project {
  if (project.version === CURRENT_PROJECT_VERSION) {
    return mergeWithFallback(project);
  }

  return {
    ...mergeWithFallback(project),
    version: CURRENT_PROJECT_VERSION
  };
}
