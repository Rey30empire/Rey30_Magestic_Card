import { del, get, set } from "idb-keyval";
import type { Project } from "../../engine/scenegraph/types";
import { migrateProject } from "./migrations";
import type { EditorAiHistory } from "../state/types";
import { createEmptyAiHistory } from "../state/types";
import { createId } from "../../lib/ids";

const AUTOSAVE_KEY = "reycad_project_autosave";
const AUTOSAVE_KIND = "reycad_editor_autosave_v2";
const VERSION_INDEX_KEY = "reycad_project_versions_index_v1";
const VERSION_PAYLOAD_PREFIX = "reycad_project_version_payload_";
const MAX_PROJECT_VERSIONS = 100;

type AutosavePayload = {
  kind: typeof AUTOSAVE_KIND;
  project: Project;
  aiHistory: EditorAiHistory;
};

type AutosaveSnapshot = {
  project: Project;
  aiHistory: EditorAiHistory;
};

export type ProjectVersionMeta = {
  id: string;
  label: string;
  createdAt: string;
  projectVersion: number;
};

type ProjectVersionPayload = {
  kind: "reycad_project_version_v1";
  meta: ProjectVersionMeta;
  project: Project;
};

function normalizeAiHistory(input: unknown): EditorAiHistory {
  const fallback = createEmptyAiHistory();
  if (!input || typeof input !== "object") {
    return fallback;
  }
  const value = input as Partial<EditorAiHistory>;
  return {
    undoBlocks: Array.isArray(value.undoBlocks) ? value.undoBlocks : [],
    redoBlocks: Array.isArray(value.redoBlocks) ? value.redoBlocks : []
  };
}

function isAutosavePayload(input: unknown): input is AutosavePayload {
  if (!input || typeof input !== "object") {
    return false;
  }
  const value = input as Partial<AutosavePayload>;
  return value.kind === AUTOSAVE_KIND && typeof value.project === "object" && value.project !== null;
}

export async function saveProjectAutosave(project: Project, aiHistory?: EditorAiHistory): Promise<void> {
  const payload: AutosavePayload = {
    kind: AUTOSAVE_KIND,
    project,
    aiHistory: normalizeAiHistory(aiHistory)
  };
  await set(AUTOSAVE_KEY, payload);
}

export async function loadProjectAutosave(): Promise<AutosaveSnapshot | null> {
  const raw = await get<unknown>(AUTOSAVE_KEY);
  if (!raw) {
    return null;
  }

  if (isAutosavePayload(raw)) {
    return {
      project: migrateProject(raw.project),
      aiHistory: normalizeAiHistory(raw.aiHistory)
    };
  }

  return {
    project: migrateProject(raw as Project),
    aiHistory: createEmptyAiHistory()
  };
}

function normalizeVersionIndex(raw: unknown): ProjectVersionMeta[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item): item is ProjectVersionMeta => Boolean(item && typeof item === "object"))
    .map((item) => {
      const value = item as Partial<ProjectVersionMeta>;
      return {
        id: typeof value.id === "string" ? value.id : createId("version"),
        label: typeof value.label === "string" && value.label.trim().length > 0 ? value.label : "Checkpoint",
        createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
        projectVersion: typeof value.projectVersion === "number" ? value.projectVersion : 1
      };
    });
}

function versionPayloadKey(id: string): string {
  return `${VERSION_PAYLOAD_PREFIX}${id}`;
}

export async function listProjectVersions(): Promise<ProjectVersionMeta[]> {
  const raw = await get<unknown>(VERSION_INDEX_KEY);
  return normalizeVersionIndex(raw).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createProjectVersion(project: Project, label?: string): Promise<ProjectVersionMeta> {
  const currentIndex = await listProjectVersions();
  const createdAt = new Date().toISOString();
  const meta: ProjectVersionMeta = {
    id: createId("version"),
    label: label && label.trim().length > 0 ? label.trim() : `Checkpoint ${createdAt}`,
    createdAt,
    projectVersion: project.version
  };

  const payload: ProjectVersionPayload = {
    kind: "reycad_project_version_v1",
    meta,
    project
  };

  await set(versionPayloadKey(meta.id), payload);

  const nextIndex = [meta, ...currentIndex].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const overflow = nextIndex.slice(MAX_PROJECT_VERSIONS);
  const trimmed = nextIndex.slice(0, MAX_PROJECT_VERSIONS);
  await set(VERSION_INDEX_KEY, trimmed);

  for (const stale of overflow) {
    await del(versionPayloadKey(stale.id));
  }

  return meta;
}

export async function loadProjectVersion(versionId: string): Promise<Project | null> {
  const raw = await get<unknown>(versionPayloadKey(versionId));
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const payload = raw as Partial<ProjectVersionPayload>;
  if (payload.kind !== "reycad_project_version_v1" || !payload.project) {
    return null;
  }

  return migrateProject(payload.project as Project);
}

export async function deleteProjectVersion(versionId: string): Promise<void> {
  const currentIndex = await listProjectVersions();
  const nextIndex = currentIndex.filter((item) => item.id !== versionId);
  await set(VERSION_INDEX_KEY, nextIndex);
  await del(versionPayloadKey(versionId));
}

export function downloadProject(project: Project, fileName = "reycad-project.json"): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export async function parseProjectFromFile(file: File): Promise<Project> {
  const text = await file.text();
  const parsed = JSON.parse(text) as Project;
  return migrateProject(parsed);
}
