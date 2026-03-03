import { BufferGeometry, Float32BufferAttribute, Group, Mesh, Scene } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { createPrimitiveNode } from "../scenegraph/factory";
import type {
  BooleanOp,
  MannequinType,
  MaterialDef,
  Node,
  NodeCollider,
  NodeRigidBody,
  PhysicsConstraint,
  PrimitiveType,
  Project,
  TextureAsset,
  Transform
} from "../scenegraph/types";
import { useEditorStore } from "../../editor/state/editorStore";
import {
  addNodeCommand,
  deleteNodesCommand,
  removeMaterialCommand,
  removeTextureAssetCommand,
  setNodeColliderCommand,
  setPhysicsConstraintsCommand,
  setNodeRigidBodyCommand,
  setPhysicsSettingsCommand,
  setGridCommand,
  setMaterialBatchCommand,
  setMaterialCommand,
  toggleHoleCommand,
  upsertTextureAssetCommand,
  upsertMaterialCommand,
  updateParamsCommand,
  updateTransformCommand
} from "../../editor/commands/basicCommands";
import { addBooleanOpCommand, duplicateCommand, groupCommand, removeBooleanOpCommand, ungroupCommand } from "../../editor/commands/advancedCommands";
import { evaluateProject } from "../scenegraph/evaluator";
import type { RenderPrimitive } from "../scenegraph/evaluator";
import { buildGeometryFromPrimitive } from "../rendering/geometry";
import { solveBooleanTasks } from "../scenegraph/csgSolve";
import templates from "../../assets/templates/templates.json";
import { createId } from "../../lib/ids";
import { physicsRuntime } from "../runtime/physicsRuntime";
import { createProjectVersion } from "../../editor/persistence/storage";

const FRONT_TOKEN_KEY = "rey30_frontend_token";
const REYMESHY_PREF_KEY = "app.reymeshy.enabled";
const REYMESHY_HISTORY_KEY = "reycad.reymeshy.history.v1";
const REYMESHY_HISTORY_MAX_ENTRIES = 240;
const REYMESHY_JOB_POLL_INTERVAL_MS = 450;
const REYMESHY_JOB_POLL_TIMEOUT_MS = 45_000;

type ReyMeshyMeshData = {
  vertices: number[];
  indices: number[];
  uvs: number[];
};

type ReyMeshyCleanupResponse = {
  ok: true;
  summary: {
    inputTriangles: number;
    outputTriangles: number;
    remeshedTriangles: number;
  };
};

type ReyMeshyCleanupJobStatus = "queued" | "running" | "succeeded" | "failed";

type ReyMeshyCleanupJobView = {
  id: string;
  status: ReyMeshyCleanupJobStatus;
  input?: {
    triangles?: number;
  };
  output?: {
    outputTriangles?: number | null;
    remeshedTriangles?: number | null;
  };
  error?: {
    code?: string | null;
    message?: string | null;
  };
};

export type ReyMeshyCleanupReport = {
  nodeId: string;
  inputTriangles: number;
  outputTriangles: number;
  remeshedTriangles: number;
  patchApplied: boolean;
  patch: Record<string, unknown> | null;
};

export type ReyMeshyBatchCleanupReport = {
  requested: number;
  ok: number;
  failed: number;
  entries: Array<
    | { nodeId: string; ok: true; report: ReyMeshyCleanupReport }
    | { nodeId: string; ok: false; error: string }
  >;
};

export type ReyMeshyHistoryEntry = {
  id: string;
  nodeId: string;
  nodeType: Node["type"];
  at: string;
  status: "ok" | "error";
  inputTriangles: number | null;
  outputTriangles: number | null;
  remeshedTriangles: number | null;
  patchApplied: boolean;
  patch: Record<string, unknown> | null;
  message?: string;
};

type MaterialPatch = Omit<Partial<MaterialDef>, "pbr"> & {
  pbr?: Partial<NonNullable<MaterialDef["pbr"]>>;
};

export type BenchmarkScenePreset = "indoor" | "outdoor" | "large-world";
export type BenchmarkSceneSummary = {
  preset: BenchmarkScenePreset;
  groupId: string;
  nodeCount: number;
};

export interface EngineAPI {
  createPrimitive: (type: PrimitiveType, params?: Partial<Record<string, unknown>>, transform?: Partial<Transform>, materialId?: string) => string;
  createGroup: (childrenIds: string[], mode: "solid" | "hole" | "mixed") => string;
  setNodeTransform: (nodeId: string, transformPatch: Partial<Transform>) => void;
  setNodeParams: (nodeId: string, paramsPatch: Record<string, unknown>) => void;
  cleanupNodeWithReyMeshy: (nodeId: string) => Promise<ReyMeshyCleanupReport>;
  cleanupSelectionWithReyMeshy: (nodeIds?: string[]) => Promise<ReyMeshyBatchCleanupReport>;
  listReyMeshyHistory: (nodeId?: string, limit?: number) => ReyMeshyHistoryEntry[];
  clearReyMeshyHistory: (nodeId?: string) => number;
  setNodeMaterial: (nodeId: string, materialId?: string) => void;
  setNodeMaterialBatch: (nodeIds: string[], materialId?: string) => void;
  deleteNodes: (nodeIds: string[]) => void;
  duplicateNodes: (nodeIds: string[]) => string[];
  group: (nodeIds: string[]) => string;
  ungroup: (groupId: string) => string[];
  toggleHole: (nodeId: string) => void;
  addBooleanOp: (op: "union" | "subtract" | "intersect", aId: string, bId: string) => string;
  removeBooleanOp: (opId: string, groupId: string) => void;
  insertTemplate: (templateId: string, targetParentId?: string) => string[];
  frameSelection: (nodeIds: string[]) => void;
  exportSTL: (selectionIds?: string[]) => Promise<Blob>;
  exportGLB: (selectionIds?: string[]) => Promise<Blob>;
  getSelection: () => string[];
  setSelection: (ids: string[]) => void;
  setGrid: (patch: Partial<Project["grid"]>) => void;
  setNodeRigidBody: (nodeId: string, patch: Partial<Omit<NodeRigidBody, "enabled">> & { enabled?: boolean }) => void;
  setNodeCollider: (nodeId: string, patch: Partial<Omit<NodeCollider, "enabled">> & { enabled?: boolean }) => void;
  setPhysicsSettings: (patch: Partial<Project["physics"]>) => void;
  getPhysicsSettings: () => Project["physics"];
  addPhysicsConstraint: (constraint: Omit<PhysicsConstraint, "id"> & { id?: string }) => string;
  updatePhysicsConstraint: (constraintId: string, patch: Partial<Omit<PhysicsConstraint, "id">>) => void;
  removePhysicsConstraint: (constraintId: string) => void;
  listPhysicsConstraints: () => PhysicsConstraint[];
  raycastPhysics: (
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance?: number
  ) => { entityId: string; distance: number; point: [number, number, number] } | null;
  getPhysicsEvents: (
    limit?: number
  ) => Array<{ a: string; b: string; type: "enter" | "stay" | "exit"; point: [number, number, number]; at: string }>;
  clearPhysicsEvents: () => void;
  applyPhysicsImpulse: (nodeId: string, impulse: [number, number, number]) => boolean;
  createTextureAsset: (name: string, dataUrl: string, mimeType?: string, width?: number, height?: number) => string;
  deleteTextureAsset: (textureId: string) => void;
  listTextureAssets: () => TextureAsset[];
  loadMannequin: (kind: MannequinType) => string;
  applyTextureToSelection: (textureId: string) => number;
  recolorSelection: (colorHex: string) => number;
  applyPatternToSelection: (pattern: "stripes" | "camo" | "pulse") => number;
  saveSelectionVariant: (name: string) => Promise<string>;
  generateArena: () => string;
  generateBenchmarkScene: (preset?: BenchmarkScenePreset) => BenchmarkSceneSummary;
  setupBattleScene: () => { arenaId: string; actorAId: string; actorBId: string };
  playBattleClash: (impulse?: number) => boolean;
  stopBattleScene: () => void;
  getBattleSceneState: () => { arenaId: string; actorAId: string; actorBId: string } | null;
  createMaterial: (kind: MaterialDef["kind"], seed?: Partial<MaterialDef>) => string;
  updateMaterial: (materialId: string, patch: MaterialPatch) => void;
  deleteMaterial: (materialId: string, fallbackMaterialId?: string) => void;
  getProjectSnapshot: () => Project;
  listTemplates: () => Array<{ id: string; name: string; tags: string[] }>;
  listMaterials: () => Array<{ id: string; name: string; kind: MaterialDef["kind"]; color?: string; pbr?: MaterialDef["pbr"] }>;
}

function patchTransform(base: Transform, patch: Partial<Transform>): Transform {
  return {
    position: patch.position ?? base.position,
    rotation: patch.rotation ?? base.rotation,
    scale: patch.scale ?? base.scale
  };
}

function defaultRigidBody(): NodeRigidBody {
  return {
    enabled: true,
    mode: "dynamic",
    mass: 1,
    gravityScale: 1,
    lockRotation: true,
    linearVelocity: [0, 0, 0]
  };
}

function patchRigidBody(
  current: NodeRigidBody | undefined,
  patch: Partial<Omit<NodeRigidBody, "enabled">> & { enabled?: boolean }
): NodeRigidBody | undefined {
  if (patch.enabled === false) {
    return undefined;
  }
  const base = current ?? defaultRigidBody();
  return {
    ...base,
    ...patch,
    enabled: true,
    linearVelocity: patch.linearVelocity ?? base.linearVelocity
  };
}

function defaultCollider(): NodeCollider {
  return {
    enabled: true,
    shape: "box",
    isTrigger: false,
    size: [1, 1, 1],
    radius: 0.5,
    height: 1
  };
}

function patchCollider(
  current: NodeCollider | undefined,
  patch: Partial<Omit<NodeCollider, "enabled">> & { enabled?: boolean }
): NodeCollider | undefined {
  if (patch.enabled === false) {
    return undefined;
  }
  const base = current ?? defaultCollider();
  return {
    ...base,
    ...patch,
    enabled: true,
    size: patch.size ?? base.size
  };
}

function buildExportScene(selectionIds?: string[]): Scene {
  const state = useEditorStore.getState();
  const scene = new Scene();
  const evaluated = evaluateProject(state.data.project);
  const items = selectionIds && selectionIds.length > 0 ? evaluated.items.filter((item) => selectionIds.includes(item.nodeId)) : evaluated.items;
  for (const item of items) {
    const geometry = buildGeometryFromPrimitive(item);
    const materialDef = state.data.project.materials[item.materialId ?? ""];
    const color = materialDef?.color ?? materialDef?.pbr?.baseColor ?? "#aaaaaa";
    const mesh = new Mesh(geometry);
    mesh.position.set(...item.transform.position);
    mesh.rotation.set(...item.transform.rotation);
    mesh.scale.set(...item.transform.scale);
    mesh.name = item.nodeId;
    mesh.userData.color = color;
    scene.add(mesh);
  }

  const csgTasks =
    selectionIds && selectionIds.length > 0
      ? evaluated.booleanTasks.filter((task) => selectionIds.includes(task.groupId))
      : evaluated.booleanTasks;
  const solved = solveBooleanTasks(csgTasks);
  for (const result of solved) {
    if (!result.geometry) {
      continue;
    }
    const groupNode = state.data.project.nodes[result.groupId];
    const materialDef = groupNode?.materialId ? state.data.project.materials[groupNode.materialId] : undefined;
    const color = materialDef?.color ?? materialDef?.pbr?.baseColor ?? "#a9adb3";
    const mesh = new Mesh(result.geometry);
    mesh.name = result.groupId;
    mesh.userData.color = color;
    scene.add(mesh);
  }
  return scene;
}

function cloneMaterial(material: MaterialDef): MaterialDef {
  return JSON.parse(JSON.stringify(material)) as MaterialDef;
}

function createMaterialName(kind: MaterialDef["kind"], currentCount: number): string {
  return kind === "solidColor" ? `Solid ${currentCount + 1}` : `PBR ${currentCount + 1}`;
}

function createDefaultPbr(): NonNullable<MaterialDef["pbr"]> {
  return {
    metalness: 0.2,
    roughness: 0.6,
    baseColor: "#cccccc",
    emissiveColor: "#000000",
    emissiveIntensity: 0,
    transmission: 0,
    ior: 1.45,
    baseColorMapId: undefined,
    normalMapId: undefined,
    aoMapId: undefined,
    roughnessMapId: undefined,
    metalnessMapId: undefined,
    emissiveMapId: undefined
  };
}

function normalizeMapId(value: string | undefined, fallback: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeConstraintPatch(
  current: PhysicsConstraint,
  patch: Partial<Omit<PhysicsConstraint, "id">>
): PhysicsConstraint {
  return {
    ...current,
    type: "distance",
    a: typeof patch.a === "string" && patch.a.length > 0 ? patch.a : current.a,
    b: typeof patch.b === "string" && patch.b.length > 0 ? patch.b : current.b,
    restLength: Number.isFinite(patch.restLength) ? Math.max(0.001, patch.restLength as number) : current.restLength,
    stiffness: Number.isFinite(patch.stiffness) ? clamp01(patch.stiffness as number, current.stiffness) : current.stiffness,
    damping: Number.isFinite(patch.damping) ? clamp01(patch.damping as number, current.damping) : current.damping,
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled
  };
}

function createConstraintValue(seed: Omit<PhysicsConstraint, "id"> & { id?: string }): PhysicsConstraint {
  return {
    id: typeof seed.id === "string" && seed.id.length > 0 ? seed.id : createId("constraint"),
    type: "distance",
    a: seed.a,
    b: seed.b,
    restLength: Number.isFinite(seed.restLength) ? Math.max(0.001, seed.restLength) : 10,
    stiffness: clamp01(seed.stiffness, 0.6),
    damping: clamp01(seed.damping, 0.1),
    enabled: seed.enabled !== false
  };
}

function normalizeColorHex(value: string, fallback = "#cccccc"): string {
  const trimmed = value.trim().toLowerCase();
  const hex3 = /^#[0-9a-f]{3}$/i;
  const hex6 = /^#[0-9a-f]{6}$/i;
  if (hex6.test(trimmed)) {
    return trimmed;
  }
  if (hex3.test(trimmed)) {
    const a = trimmed[1];
    const b = trimmed[2];
    const c = trimmed[3];
    return `#${a}${a}${b}${b}${c}${c}`;
  }
  return fallback;
}

function sanitizeTextureDataUrl(dataUrl: string): string | null {
  const trimmed = dataUrl.trim();
  if (!trimmed.startsWith("data:image/")) {
    return null;
  }
  return trimmed;
}

function isReyMeshyEnabledInApp(): boolean {
  const raw = localStorage.getItem(REYMESHY_PREF_KEY);
  if (raw === null) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

function normalizeReyMeshyHistoryEntry(value: unknown): ReyMeshyHistoryEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    return null;
  }
  if (typeof raw.nodeId !== "string" || raw.nodeId.length === 0) {
    return null;
  }
  if (raw.nodeType !== "group" && raw.nodeType !== "primitive" && raw.nodeType !== "import") {
    return null;
  }
  if (typeof raw.at !== "string" || raw.at.length === 0) {
    return null;
  }
  if (raw.status !== "ok" && raw.status !== "error") {
    return null;
  }

  const parseNullableNumber = (entry: unknown): number | null => {
    if (entry === null || entry === undefined) {
      return null;
    }
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      return null;
    }
    return entry;
  };

  const patch = raw.patch;
  const parsedPatch = patch && typeof patch === "object" && !Array.isArray(patch) ? (patch as Record<string, unknown>) : null;

  return {
    id: raw.id,
    nodeId: raw.nodeId,
    nodeType: raw.nodeType,
    at: raw.at,
    status: raw.status,
    inputTriangles: parseNullableNumber(raw.inputTriangles),
    outputTriangles: parseNullableNumber(raw.outputTriangles),
    remeshedTriangles: parseNullableNumber(raw.remeshedTriangles),
    patchApplied: raw.patchApplied === true,
    patch: parsedPatch,
    message: typeof raw.message === "string" && raw.message.length > 0 ? raw.message : undefined
  };
}

function readReyMeshyHistoryStorage(): ReyMeshyHistoryEntry[] {
  try {
    const raw = localStorage.getItem(REYMESHY_HISTORY_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: ReyMeshyHistoryEntry[] = [];
    for (const candidate of parsed) {
      const normalized = normalizeReyMeshyHistoryEntry(candidate);
      if (normalized) {
        out.push(normalized);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeReyMeshyHistoryStorage(entries: ReyMeshyHistoryEntry[]): void {
  localStorage.setItem(REYMESHY_HISTORY_KEY, JSON.stringify(entries));
}

function pushReyMeshyHistoryEntry(entry: ReyMeshyHistoryEntry): void {
  const current = readReyMeshyHistoryStorage();
  const next = [entry, ...current].slice(0, REYMESHY_HISTORY_MAX_ENTRIES);
  writeReyMeshyHistoryStorage(next);
}

function toRenderPrimitive(node: Extract<Node, { type: "primitive" }>): RenderPrimitive {
  return {
    nodeId: node.id,
    primitive: node.primitive,
    params: node.params,
    materialId: node.materialId,
    transform: node.transform,
    mode: node.mode === "hole" ? "hole" : "solid"
  } as RenderPrimitive;
}

function isNodeWithinSubtree(project: Project, nodeId: string, rootId: string): boolean {
  let cursor = project.nodes[nodeId];
  while (cursor) {
    if (cursor.id === rootId) {
      return true;
    }
    if (!cursor.parentId) {
      return false;
    }
    cursor = project.nodes[cursor.parentId];
  }
  return false;
}

function appendGeometryToMeshData(geometry: BufferGeometry, meshData: ReyMeshyMeshData): void {
  const nonIndexed = geometry.toNonIndexed();
  const positions = nonIndexed.getAttribute("position");
  if (!positions || positions.itemSize < 3) {
    nonIndexed.dispose();
    return;
  }

  const vertexCount = positions.count - (positions.count % 3);
  if (vertexCount < 3) {
    nonIndexed.dispose();
    return;
  }

  const baseIndex = meshData.vertices.length / 3;
  for (let index = 0; index < vertexCount; index += 1) {
    meshData.vertices.push(positions.getX(index), positions.getY(index), positions.getZ(index));
    meshData.indices.push(baseIndex + index);
  }

  nonIndexed.dispose();
}

function buildGroupMergedGeometry(groupId: string): BufferGeometry | null {
  const state = useEditorStore.getState();
  const project = state.data.project;
  const evaluated = evaluateProject(project);

  const meshData: ReyMeshyMeshData = {
    vertices: [],
    indices: [],
    uvs: []
  };

  for (const item of evaluated.items) {
    if (!isNodeWithinSubtree(project, item.nodeId, groupId)) {
      continue;
    }
    const geometry = buildGeometryFromPrimitive(item);
    const mesh = new Mesh(geometry);
    mesh.position.set(...item.transform.position);
    mesh.rotation.set(...item.transform.rotation);
    mesh.scale.set(...item.transform.scale);
    mesh.updateMatrixWorld(true);
    geometry.applyMatrix4(mesh.matrixWorld);
    appendGeometryToMeshData(geometry, meshData);
    geometry.dispose();
  }

  const nestedTasks = evaluated.booleanTasks.filter((task) => task.groupId !== groupId && isNodeWithinSubtree(project, task.groupId, groupId));
  if (nestedTasks.length > 0) {
    const nestedSolved = solveBooleanTasks(nestedTasks);
    for (const result of nestedSolved) {
      if (!result.geometry) {
        continue;
      }
      appendGeometryToMeshData(result.geometry, meshData);
      result.geometry.dispose();
    }
  }

  if (meshData.indices.length < 3 || meshData.vertices.length < 9) {
    return null;
  }

  const merged = new BufferGeometry();
  merged.setAttribute("position", new Float32BufferAttribute(meshData.vertices, 3));
  merged.setIndex(meshData.indices);
  merged.computeVertexNormals();
  return merged;
}

function buildCleanupGeometry(nodeId: string): BufferGeometry | null {
  const state = useEditorStore.getState();
  const node = state.data.project.nodes[nodeId];
  if (!node) {
    return null;
  }

  if (node.type === "primitive") {
    return buildGeometryFromPrimitive(toRenderPrimitive(node));
  }

  if (node.type === "group") {
    const evaluated = evaluateProject(state.data.project);
    const task = evaluated.booleanTasks.find((candidate) => candidate.groupId === nodeId);
    if (task) {
      const solved = solveBooleanTasks([task]);
      return solved[0]?.geometry ?? null;
    }
    return buildGroupMergedGeometry(nodeId);
  }

  return null;
}

function parseNumberList(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      return null;
    }
    out.push(entry);
  }
  return out;
}

function parseIndexList(value: unknown): number[] | null {
  const parsed = parseNumberList(value);
  if (!parsed) {
    return null;
  }
  const out: number[] = [];
  for (const entry of parsed) {
    if (!Number.isInteger(entry) || entry < 0) {
      return null;
    }
    out.push(entry);
  }
  return out;
}

function normalizeMeshDataPayload(payload: unknown): ReyMeshyMeshData | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const root = payload as Record<string, unknown>;
  const candidateRaw = root.mesh;
  const candidate =
    candidateRaw && typeof candidateRaw === "object"
      ? (candidateRaw as Record<string, unknown>)
      : (root as Record<string, unknown>);

  const vertices = parseNumberList(candidate.vertices);
  const indices = parseIndexList(candidate.indices);
  const uvs = candidate.uvs === undefined ? [] : parseNumberList(candidate.uvs);
  if (!vertices || !indices || !uvs) {
    return null;
  }

  if (vertices.length < 9 || vertices.length % 3 !== 0) {
    return null;
  }
  if (indices.length < 3 || indices.length % 3 !== 0) {
    return null;
  }
  const vertexCount = vertices.length / 3;
  for (const index of indices) {
    if (index >= vertexCount) {
      return null;
    }
  }
  if (uvs.length > 0 && uvs.length !== vertexCount * 2) {
    return null;
  }

  return { vertices, indices, uvs };
}

function decodeJsonDataUrl(source: string): string | null {
  const base64Prefix = "data:application/json;base64,";
  if (source.startsWith(base64Prefix)) {
    if (typeof atob !== "function") {
      throw new Error("Browser runtime does not support base64 decode for import source.");
    }
    return atob(source.slice(base64Prefix.length));
  }

  const plainPrefix = "data:application/json,";
  if (source.startsWith(plainPrefix)) {
    return decodeURIComponent(source.slice(plainPrefix.length));
  }

  return null;
}

async function resolveImportMeshData(source: string): Promise<ReyMeshyMeshData> {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new Error("Import source is empty.");
  }

  const inlineJson = decodeJsonDataUrl(trimmed) ?? (trimmed.startsWith("{") ? trimmed : null);
  if (inlineJson) {
    let payload: unknown;
    try {
      payload = JSON.parse(inlineJson);
    } catch {
      throw new Error("Import source JSON is invalid.");
    }
    const mesh = normalizeMeshDataPayload(payload);
    if (!mesh) {
      throw new Error("Import source JSON must include mesh vertices/indices.");
    }
    return mesh;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("/")) {
    const response = await fetch(trimmed, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Import source fetch failed with HTTP ${response.status}.`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      throw new Error("Import source endpoint did not return valid JSON.");
    }
    const mesh = normalizeMeshDataPayload(payload);
    if (!mesh) {
      throw new Error("Import source endpoint JSON must include mesh vertices/indices.");
    }
    return mesh;
  }

  throw new Error("Import source format not supported. Use JSON mesh, data URL JSON, or JSON endpoint.");
}

function geometryToReyMeshData(geometry: BufferGeometry): ReyMeshyMeshData {
  const nonIndexed = geometry.toNonIndexed();
  const positions = nonIndexed.getAttribute("position");
  if (!positions || positions.itemSize < 3) {
    nonIndexed.dispose();
    throw new Error("Geometry has no valid position attribute for ReyMeshy.");
  }

  const vertexCount = positions.count - (positions.count % 3);
  if (vertexCount < 3) {
    nonIndexed.dispose();
    throw new Error("Geometry has not enough vertices to build triangles.");
  }

  const vertices: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index < vertexCount; index += 1) {
    vertices.push(positions.getX(index), positions.getY(index), positions.getZ(index));
    indices.push(index);
  }

  const uvAttr = nonIndexed.getAttribute("uv");
  const uvs: number[] = [];
  if (uvAttr && uvAttr.itemSize >= 2 && uvAttr.count >= vertexCount) {
    for (let index = 0; index < vertexCount; index += 1) {
      uvs.push(uvAttr.getX(index), uvAttr.getY(index));
    }
  }

  nonIndexed.dispose();
  return { vertices, indices, uvs };
}

function normalizeSegment(value: unknown, fallback: number, min: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, numeric);
}

function computeReducedSegments(current: number, ratio: number, min: number): number {
  const normalized = Math.max(min, Math.floor(current));
  const scaled = Math.round(normalized * Math.sqrt(Math.max(0.05, Math.min(1, ratio))));
  return Math.max(min, Math.min(normalized, scaled));
}

function buildReyMeshyParamPatch(node: Node, inputTriangles: number, outputTriangles: number): Record<string, unknown> | null {
  if (node.type !== "primitive") {
    return null;
  }

  if (!Number.isFinite(inputTriangles) || inputTriangles <= 0 || !Number.isFinite(outputTriangles) || outputTriangles >= inputTriangles) {
    return null;
  }

  const ratio = outputTriangles / inputTriangles;
  if (node.primitive === "cylinder" || node.primitive === "cone") {
    const current = normalizeSegment((node.params as Record<string, unknown>).radialSegments, 24, 8);
    const next = computeReducedSegments(current, ratio, 8);
    return next < current ? { radialSegments: next } : null;
  }

  if (node.primitive === "sphere") {
    const params = node.params as Record<string, unknown>;
    const currentWidth = normalizeSegment(params.widthSegments, 24, 8);
    const currentHeight = normalizeSegment(params.heightSegments, 16, 6);
    const nextWidth = computeReducedSegments(currentWidth, ratio, 8);
    const nextHeight = computeReducedSegments(currentHeight, ratio, 6);
    const patch: Record<string, unknown> = {};
    if (nextWidth < currentWidth) {
      patch.widthSegments = nextWidth;
    }
    if (nextHeight < currentHeight) {
      patch.heightSegments = nextHeight;
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }

  if (node.primitive === "terrain") {
    const current = normalizeSegment((node.params as Record<string, unknown>).segments, 48, 8);
    const next = computeReducedSegments(current, ratio, 8);
    return next < current ? { segments: next } : null;
  }

  return null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseReyMeshyCleanupResponse(payload: unknown): ReyMeshyCleanupResponse {
  const parsed = payload as Partial<ReyMeshyCleanupResponse> | null;
  if (!parsed || parsed.ok !== true || !parsed.summary) {
    throw new Error("Invalid response from /api/reymeshy/cleanup");
  }
  const inputTriangles = finiteNumberOrNull(parsed.summary.inputTriangles);
  const outputTriangles = finiteNumberOrNull(parsed.summary.outputTriangles);
  const remeshedTriangles = finiteNumberOrNull(parsed.summary.remeshedTriangles);
  if (inputTriangles === null || outputTriangles === null || remeshedTriangles === null) {
    throw new Error("Incomplete summary from /api/reymeshy/cleanup");
  }
  return {
    ok: true,
    summary: {
      inputTriangles,
      outputTriangles,
      remeshedTriangles
    }
  };
}

function parseReyMeshyCleanupJobCreateResponse(payload: unknown): string {
  const parsed = payload as { ok?: unknown; job?: ReyMeshyCleanupJobView } | null;
  if (!parsed || parsed.ok !== true || !parsed.job || typeof parsed.job.id !== "string" || parsed.job.id.length === 0) {
    throw new Error("Invalid response from /api/reymeshy/jobs");
  }
  return parsed.job.id;
}

function parseReyMeshyCleanupJobStatusResponse(payload: unknown): ReyMeshyCleanupJobView {
  const parsed = payload as { ok?: unknown; job?: ReyMeshyCleanupJobView } | null;
  if (!parsed || parsed.ok !== true || !parsed.job || typeof parsed.job.id !== "string" || parsed.job.id.length === 0) {
    throw new Error("Invalid response from /api/reymeshy/jobs/:id");
  }
  const status = parsed.job.status;
  if (status !== "queued" && status !== "running" && status !== "succeeded" && status !== "failed") {
    throw new Error("Invalid ReyMeshy job status");
  }
  return parsed.job;
}

function mapReyMeshyJobFailure(errorCode: string | null | undefined, message: string | null | undefined): string {
  const normalizedCode = typeof errorCode === "string" ? errorCode.trim().toLowerCase() : "";
  const normalizedMessage = typeof message === "string" ? message.trim() : "";
  if (normalizedCode === "sidecar_timeout" || normalizedMessage.toLowerCase().includes("timeout")) {
    return "ReyMeshy timeout: la tarea tardo demasiado y fue cancelada.";
  }
  if (normalizedMessage.length > 0) {
    return `ReyMeshy fallo: ${normalizedMessage}`;
  }
  return "ReyMeshy sidecar no disponible en este momento.";
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mapReyMeshyHttpError(status: number, body: { error?: string; details?: string }): string {
  if (status === 400) {
    return "Mesh invalido para cleanup. Revisa la geometria seleccionada.";
  }
  if (status === 401) {
    return "Sesion expirada. Inicia sesion en /app y vuelve a intentar.";
  }
  if (status === 403) {
    return "No tienes permisos para ejecutar ReyMeshy cleanup.";
  }
  if (status === 429) {
    return "Demasiadas solicitudes de cleanup. Espera unos segundos y reintenta.";
  }
  if (status === 503) {
    const details = (body.details ?? "").toLowerCase();
    if (details.includes("vram")) {
      return "ReyMeshy pausado por VRAM Sentinel. Libera memoria GPU y reintenta.";
    }
    return "ReyMeshy esta desactivado en el servidor.";
  }
  if (status === 502) {
    if ((body.details ?? "").toLowerCase().includes("timeout")) {
      return "ReyMeshy timeout: la tarea tardo demasiado y fue cancelada.";
    }
    return "ReyMeshy sidecar no disponible en este momento.";
  }

  const composed = [body.error, body.details].filter(Boolean).join(": ");
  return composed || `ReyMeshy request failed with HTTP ${status}`;
}

async function callReyMeshyCleanupSync(mesh: ReyMeshyMeshData): Promise<ReyMeshyCleanupResponse> {
  const token = localStorage.getItem(FRONT_TOKEN_KEY) ?? "";
  if (!token) {
    throw new Error("Sesion no disponible. Inicia sesion en /app.");
  }

  const response = await fetch("/api/reymeshy/cleanup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-client-platform": "web"
    },
    body: JSON.stringify({ mesh })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; details?: string };
    throw new Error(mapReyMeshyHttpError(response.status, body));
  }

  return parseReyMeshyCleanupResponse(payload);
}

async function startReyMeshyCleanupJob(mesh: ReyMeshyMeshData): Promise<string | null> {
  const token = localStorage.getItem(FRONT_TOKEN_KEY) ?? "";
  if (!token) {
    throw new Error("Sesion no disponible. Inicia sesion en /app.");
  }

  const response = await fetch("/api/reymeshy/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-client-platform": "web"
    },
    body: JSON.stringify({ mesh })
  });

  const payload = await response.json().catch(() => null);
  if (response.status === 404 || response.status === 405) {
    return null;
  }
  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; details?: string };
    throw new Error(mapReyMeshyHttpError(response.status, body));
  }

  return parseReyMeshyCleanupJobCreateResponse(payload);
}

async function pollReyMeshyCleanupJob(jobId: string): Promise<ReyMeshyCleanupResponse> {
  const token = localStorage.getItem(FRONT_TOKEN_KEY) ?? "";
  if (!token) {
    throw new Error("Sesion no disponible. Inicia sesion en /app.");
  }

  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < REYMESHY_JOB_POLL_TIMEOUT_MS) {
    const response = await fetch(`/api/reymeshy/jobs/${encodeURIComponent(jobId)}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-client-platform": "web"
      }
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const body = (payload ?? {}) as { error?: string; details?: string };
      throw new Error(mapReyMeshyHttpError(response.status, body));
    }

    const job = parseReyMeshyCleanupJobStatusResponse(payload);
    if (job.status === "succeeded") {
      const inputTriangles = finiteNumberOrNull(job.input?.triangles);
      const outputTriangles = finiteNumberOrNull(job.output?.outputTriangles);
      const remeshedTriangles = finiteNumberOrNull(job.output?.remeshedTriangles);
      if (inputTriangles === null || outputTriangles === null || remeshedTriangles === null) {
        throw new Error("Incomplete summary from /api/reymeshy/jobs/:id");
      }

      return {
        ok: true,
        summary: {
          inputTriangles,
          outputTriangles,
          remeshedTriangles
        }
      };
    }

    if (job.status === "failed") {
      throw new Error(mapReyMeshyJobFailure(job.error?.code, job.error?.message));
    }

    await waitFor(REYMESHY_JOB_POLL_INTERVAL_MS);
  }

  throw new Error("ReyMeshy timeout: la tarea tardo demasiado y fue cancelada.");
}

async function callReyMeshyCleanup(mesh: ReyMeshyMeshData): Promise<ReyMeshyCleanupResponse> {
  const jobId = await startReyMeshyCleanupJob(mesh);
  if (jobId) {
    return pollReyMeshyCleanupJob(jobId);
  }
  return callReyMeshyCleanupSync(mesh);
}

type BattleSceneState = { arenaId: string; actorAId: string; actorBId: string };
let battleSceneState: BattleSceneState | null = null;

export const engineApi: EngineAPI = {
  createPrimitive(type, params, transform, materialId) {
    const state = useEditorStore.getState();
    const node = createPrimitiveNode(type);
    node.materialId = materialId;
    if (params) {
      node.params = {
        ...node.params,
        ...params
      } as never;
    }
    if (transform) {
      node.transform = patchTransform(node.transform, transform);
    }

    state.executeCommand(addNodeCommand(node, state.data.project.rootId));
    return node.id;
  },

  createGroup(childrenIds, mode) {
    useEditorStore.getState().executeCommand(groupCommand(childrenIds, mode));
    return useEditorStore.getState().data.selection[0] ?? "";
  },

  setNodeTransform(nodeId, transformPatch) {
    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node) {
      return;
    }
    const next = patchTransform(node.transform, transformPatch);
    state.executeCommand(updateTransformCommand(nodeId, node.transform, next));
  },

  setNodeParams(nodeId, paramsPatch) {
    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node || node.type !== "primitive") {
      return;
    }
    state.executeCommand(updateParamsCommand(nodeId, node.params, { ...node.params, ...paramsPatch } as never));
  },

  async cleanupNodeWithReyMeshy(nodeId) {
    if (!isReyMeshyEnabledInApp()) {
      throw new Error("ReyMeshy is disabled in app settings. Enable the toggle first.");
    }

    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node) {
      throw new Error("Selected node not found.");
    }

    try {
      let meshInput: ReyMeshyMeshData;
      if (node.type === "import") {
        meshInput = await resolveImportMeshData(node.source);
      } else {
        const geometry = buildCleanupGeometry(nodeId);
        if (!geometry) {
          throw new Error("Select a primitive/group with geometry or a valid import node to run ReyMeshy cleanup.");
        }
        try {
          meshInput = geometryToReyMeshData(geometry);
        } finally {
          geometry.dispose();
        }
      }

      const response = await callReyMeshyCleanup(meshInput);
      const patch = buildReyMeshyParamPatch(node, response.summary.inputTriangles, response.summary.outputTriangles);
      if (patch) {
        engineApi.setNodeParams(nodeId, patch);
      }

      const report: ReyMeshyCleanupReport = {
        nodeId,
        inputTriangles: response.summary.inputTriangles,
        outputTriangles: response.summary.outputTriangles,
        remeshedTriangles: response.summary.remeshedTriangles,
        patchApplied: Boolean(patch),
        patch
      };

      const patchMessage = report.patchApplied ? ` patch=${JSON.stringify(report.patch)}` : "";
      state.addLog(`[reymeshy] ${nodeId} tris ${report.inputTriangles} -> ${report.outputTriangles}.${patchMessage}`);
      pushReyMeshyHistoryEntry({
        id: createId("rmesh"),
        nodeId,
        nodeType: node.type,
        at: new Date().toISOString(),
        status: "ok",
        inputTriangles: report.inputTriangles,
        outputTriangles: report.outputTriangles,
        remeshedTriangles: report.remeshedTriangles,
        patchApplied: report.patchApplied,
        patch: report.patch
      });
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushReyMeshyHistoryEntry({
        id: createId("rmesh"),
        nodeId,
        nodeType: node.type,
        at: new Date().toISOString(),
        status: "error",
        inputTriangles: null,
        outputTriangles: null,
        remeshedTriangles: null,
        patchApplied: false,
        patch: null,
        message
      });
      state.addLog(`[reymeshy] ${nodeId} failed: ${message}`);
      throw error;
    }
  },

  async cleanupSelectionWithReyMeshy(nodeIds) {
    const state = useEditorStore.getState();
    const source = nodeIds && nodeIds.length > 0 ? nodeIds : state.data.selection;
    const uniqueTargets = Array.from(new Set(source))
      .filter((id) => Boolean(state.data.project.nodes[id]))
      .filter((id) => id !== state.data.project.rootId);

    const entries: ReyMeshyBatchCleanupReport["entries"] = [];
    for (const nodeId of uniqueTargets) {
      try {
        const report = await engineApi.cleanupNodeWithReyMeshy(nodeId);
        entries.push({
          nodeId,
          ok: true,
          report
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entries.push({
          nodeId,
          ok: false,
          error: message
        });
      }
    }

    const ok = entries.filter((entry) => entry.ok).length;
    const failed = entries.length - ok;
    state.addLog(`[reymeshy] batch cleanup requested=${uniqueTargets.length} ok=${ok} failed=${failed}`);

    return {
      requested: uniqueTargets.length,
      ok,
      failed,
      entries
    };
  },

  listReyMeshyHistory(nodeId, limit = 12) {
    const max = Number.isFinite(limit) ? Math.max(1, Math.min(120, Math.floor(limit))) : 12;
    const all = readReyMeshyHistoryStorage();
    const filtered = typeof nodeId === "string" && nodeId.length > 0 ? all.filter((entry) => entry.nodeId === nodeId) : all;
    return filtered.slice(0, max).map((entry) => ({
      ...entry,
      patch: entry.patch ? { ...entry.patch } : null
    }));
  },

  clearReyMeshyHistory(nodeId) {
    const all = readReyMeshyHistoryStorage();
    if (all.length === 0) {
      return 0;
    }

    if (typeof nodeId !== "string" || nodeId.length === 0) {
      localStorage.removeItem(REYMESHY_HISTORY_KEY);
      return all.length;
    }

    const next = all.filter((entry) => entry.nodeId !== nodeId);
    const removed = all.length - next.length;
    if (removed > 0) {
      writeReyMeshyHistoryStorage(next);
    }
    return removed;
  },

  setNodeMaterial(nodeId, materialId) {
    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node) {
      return;
    }
    state.executeCommand(setMaterialCommand(nodeId, node.materialId, materialId));
  },

  setNodeMaterialBatch(nodeIds, materialId) {
    const state = useEditorStore.getState();
    const uniqueNodeIds = Array.from(new Set(nodeIds)).filter((nodeId) => Boolean(state.data.project.nodes[nodeId]));
    if (uniqueNodeIds.length === 0) {
      return;
    }
    state.executeCommand(setMaterialBatchCommand(uniqueNodeIds, materialId));
  },

  deleteNodes(nodeIds) {
    if (nodeIds.length === 0) {
      return;
    }
    useEditorStore.getState().executeCommand(deleteNodesCommand(nodeIds));
  },

  duplicateNodes(nodeIds) {
    if (nodeIds.length === 0) {
      return [];
    }
    const state = useEditorStore.getState();
    state.executeCommand(duplicateCommand(nodeIds));
    return useEditorStore.getState().data.selection;
  },

  group(nodeIds) {
    useEditorStore.getState().executeCommand(groupCommand(nodeIds, "mixed"));
    return useEditorStore.getState().data.selection[0] ?? "";
  },

  ungroup(groupId) {
    const state = useEditorStore.getState();
    const groupNode = state.data.project.nodes[groupId];
    if (!groupNode || groupNode.type !== "group") {
      return [];
    }
    state.executeCommand(ungroupCommand(groupId));
    return useEditorStore.getState().data.selection;
  },

  toggleHole(nodeId) {
    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node || node.type === "import") {
      return;
    }
    const before: "solid" | "hole" = node.mode === "hole" ? "hole" : "solid";
    const after = before === "solid" ? "hole" : "solid";
    state.executeCommand(toggleHoleCommand(nodeId, before, after));
  },

  addBooleanOp(op, aId, bId) {
    const state = useEditorStore.getState();
    const a = state.data.project.nodes[aId];
    if (!a || !a.parentId) {
      return "";
    }
    const opId = createId("bool");
    const value: BooleanOp = { id: opId, op, a: aId, b: bId };
    state.executeCommand(addBooleanOpCommand(a.parentId, value));
    return opId;
  },

  removeBooleanOp(opId, groupId) {
    useEditorStore.getState().executeCommand(removeBooleanOpCommand(groupId, opId));
  },

  insertTemplate(templateId, targetParentId) {
    const state = useEditorStore.getState();
    const template = (templates as Array<{ id: string; node: { primitive: PrimitiveType; params: Record<string, unknown> } }>).find(
      (item) => item.id === templateId
    );
    if (!template) {
      return [];
    }
    const node = createPrimitiveNode(template.node.primitive);
    node.params = { ...node.params, ...template.node.params } as never;
    state.executeCommand(addNodeCommand(node, targetParentId ?? state.data.project.rootId));
    return [node.id];
  },

  frameSelection(nodeIds) {
    const state = useEditorStore.getState();
    state.requestFrameSelection(nodeIds);
    state.addLog(`Frame request: ${nodeIds.join(", ")}`);
  },

  async exportSTL(selectionIds) {
    const scene = buildExportScene(selectionIds);
    const exporter = new STLExporter();
    const content = exporter.parse(scene as unknown as Group, { binary: false }) as string;
    return new Blob([content], { type: "model/stl" });
  },

  async exportGLB(selectionIds) {
    const scene = buildExportScene(selectionIds);
    const exporter = new GLTFExporter();
    return await new Promise<Blob>((resolve, reject) => {
      exporter.parse(
        scene,
        (data) => {
          if (data instanceof ArrayBuffer) {
            resolve(new Blob([data], { type: "model/gltf-binary" }));
            return;
          }
          resolve(new Blob([JSON.stringify(data, null, 2)], { type: "application/gltf+json" }));
        },
        (error) => reject(error),
        {
          binary: true
        }
      );
    });
  },

  getSelection() {
    return [...useEditorStore.getState().data.selection];
  },

  setSelection(ids) {
    useEditorStore.getState().setSelection(ids);
  },

  setGrid(patch) {
    const state = useEditorStore.getState();
    const before = state.data.project.grid;
    const after: Project["grid"] = {
      size: patch.size ?? before.size,
      snap: patch.snap ?? before.snap,
      angleSnap: patch.angleSnap ?? before.angleSnap
    };
    state.executeCommand(setGridCommand(before, after));
  },

  setNodeRigidBody(nodeId, patch) {
    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node || node.type === "import") {
      return;
    }
    const before = node.rigidBody ? structuredClone(node.rigidBody) : undefined;
    const after = patchRigidBody(node.rigidBody, patch);
    state.executeCommand(setNodeRigidBodyCommand(nodeId, before, after));
  },

  setNodeCollider(nodeId, patch) {
    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node || node.type === "import") {
      return;
    }
    const before = node.collider ? structuredClone(node.collider) : undefined;
    const after = patchCollider(node.collider, patch);
    state.executeCommand(setNodeColliderCommand(nodeId, before, after));
  },

  setPhysicsSettings(patch) {
    const state = useEditorStore.getState();
    const before = state.data.project.physics;
    const after: Project["physics"] = {
      enabled: patch.enabled ?? before.enabled,
      simulate: patch.simulate ?? before.simulate,
      runtimeMode: patch.runtimeMode ?? before.runtimeMode,
      backend: patch.backend ?? before.backend,
      gravity: patch.gravity ?? before.gravity,
      floorY: patch.floorY ?? before.floorY,
      constraints: [...before.constraints]
    };
    state.executeCommand(setPhysicsSettingsCommand(before, after));
  },

  getPhysicsSettings() {
    return structuredClone(useEditorStore.getState().data.project.physics);
  },

  addPhysicsConstraint(constraint) {
    const state = useEditorStore.getState();
    const before = [...state.data.project.physics.constraints];
    const value = createConstraintValue(constraint);
    const after = [...before, value];
    state.executeCommand(setPhysicsConstraintsCommand(before, after));
    return value.id;
  },

  updatePhysicsConstraint(constraintId, patch) {
    const state = useEditorStore.getState();
    const before = [...state.data.project.physics.constraints];
    const index = before.findIndex((item) => item.id === constraintId);
    if (index < 0) {
      return;
    }

    const nextValue = normalizeConstraintPatch(before[index], patch);
    const after = [...before];
    after[index] = nextValue;
    state.executeCommand(setPhysicsConstraintsCommand(before, after));
  },

  removePhysicsConstraint(constraintId) {
    const state = useEditorStore.getState();
    const before = [...state.data.project.physics.constraints];
    const after = before.filter((item) => item.id !== constraintId);
    if (after.length === before.length) {
      return;
    }
    state.executeCommand(setPhysicsConstraintsCommand(before, after));
  },

  listPhysicsConstraints() {
    return structuredClone(useEditorStore.getState().data.project.physics.constraints);
  },

  raycastPhysics(origin, direction, maxDistance) {
    const project = useEditorStore.getState().data.project;
    const hit = physicsRuntime.raycast(project, origin, direction, maxDistance);
    if (!hit) {
      return null;
    }
    return {
      entityId: hit.entityId,
      distance: hit.distance,
      point: hit.point as [number, number, number]
    };
  },

  getPhysicsEvents(limit) {
    return physicsRuntime.getRecentEvents(limit);
  },

  clearPhysicsEvents() {
    physicsRuntime.clearEvents();
  },

  applyPhysicsImpulse(nodeId, impulse) {
    const state = useEditorStore.getState();
    const node = state.data.project.nodes[nodeId];
    if (!node || node.type === "import" || !node.rigidBody?.enabled) {
      return false;
    }

    const normalized: [number, number, number] = [
      Number.isFinite(impulse[0]) ? impulse[0] : 0,
      Number.isFinite(impulse[1]) ? impulse[1] : 0,
      Number.isFinite(impulse[2]) ? impulse[2] : 0
    ];

    return physicsRuntime.applyImpulse(state.data.project, nodeId, normalized, {
      onLog: state.addLog
    });
  },

  createTextureAsset(name, dataUrl, mimeType = "image/png", width, height) {
    const normalizedDataUrl = sanitizeTextureDataUrl(dataUrl);
    if (!normalizedDataUrl) {
      return "";
    }
    const trimmedName = name.trim();
    const id = createId("tex");
    const next: TextureAsset = {
      id,
      name: trimmedName.length > 0 ? trimmedName : `Texture ${new Date().toLocaleTimeString()}`,
      mimeType,
      dataUrl: normalizedDataUrl,
      createdAt: new Date().toISOString(),
      width: Number.isFinite(width) ? width : undefined,
      height: Number.isFinite(height) ? height : undefined
    };
    useEditorStore.getState().executeCommand(upsertTextureAssetCommand(id, undefined, next));
    return id;
  },

  deleteTextureAsset(textureId) {
    const state = useEditorStore.getState();
    const before = state.data.project.textures[textureId];
    if (!before) {
      return;
    }
    state.executeCommand(removeTextureAssetCommand(textureId, before));
  },

  listTextureAssets() {
    return Object.values(useEditorStore.getState().data.project.textures).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  loadMannequin(kind) {
    const partIds: string[] = [];
    const part = (
      primitive: PrimitiveType,
      params: Partial<Record<string, unknown>>,
      position: [number, number, number],
      scale: [number, number, number] = [1, 1, 1],
      materialId = "pbr_plastic_matte"
    ): string => {
      const id = engineApi.createPrimitive(primitive, params, { position, scale }, materialId);
      partIds.push(id);
      return id;
    };

    if (kind === "humanoid") {
      part("cylinder", { rTop: 7, rBottom: 8, h: 34, radialSegments: 24 }, [0, 20, 0], [1, 1, 1], "pbr_plastic_matte");
      part("sphere", { r: 8, widthSegments: 24, heightSegments: 16 }, [0, 42, 0], [1, 1, 1], "pbr_plastic_glossy");
      part("cylinder", { rTop: 3, rBottom: 3, h: 26, radialSegments: 18 }, [-8, 20, 0], [1, 1, 1], "pbr_plastic_matte");
      part("cylinder", { rTop: 3, rBottom: 3, h: 26, radialSegments: 18 }, [8, 20, 0], [1, 1, 1], "pbr_plastic_matte");
      part("cylinder", { rTop: 3.5, rBottom: 3.5, h: 24, radialSegments: 18 }, [-4, 4, 0], [1, 1, 1], "pbr_rubber");
      part("cylinder", { rTop: 3.5, rBottom: 3.5, h: 24, radialSegments: 18 }, [4, 4, 0], [1, 1, 1], "pbr_rubber");
    } else if (kind === "creature") {
      part("sphere", { r: 14, widthSegments: 24, heightSegments: 16 }, [0, 16, 0], [1.4, 1, 1], "pbr_wood");
      part("sphere", { r: 8, widthSegments: 24, heightSegments: 16 }, [0, 30, 8], [1, 1, 1], "pbr_wood");
      part("cone", { r: 4, h: 12, radialSegments: 16 }, [0, 38, 12], [1, 1, 1], "pbr_metal");
      part("cone", { r: 3, h: 10, radialSegments: 16 }, [-10, 8, 0], [1, 1, 1], "pbr_rubber");
      part("cone", { r: 3, h: 10, radialSegments: 16 }, [10, 8, 0], [1, 1, 1], "pbr_rubber");
    } else if (kind === "pet") {
      part("sphere", { r: 10, widthSegments: 24, heightSegments: 16 }, [0, 14, 0], [1.2, 1, 1.4], "pbr_plastic_glossy");
      part("sphere", { r: 7, widthSegments: 24, heightSegments: 16 }, [0, 24, 10], [1, 1, 1], "pbr_plastic_glossy");
      part("cone", { r: 2, h: 14, radialSegments: 16 }, [0, 16, -14], [1, 1, 1], "pbr_plastic_matte");
      part("cylinder", { rTop: 2, rBottom: 2, h: 10, radialSegments: 12 }, [-6, 5, 0], [1, 1, 1], "pbr_rubber");
      part("cylinder", { rTop: 2, rBottom: 2, h: 10, radialSegments: 12 }, [6, 5, 0], [1, 1, 1], "pbr_rubber");
    } else {
      part("box", { w: 40, h: 2, d: 58 }, [0, 12, 0], [1, 1, 1], "pbr_metal");
      part("box", { w: 32, h: 1, d: 48 }, [0, 13.5, 0], [1, 1, 1], "pbr_glassish");
      part("cylinder", { rTop: 2, rBottom: 2, h: 22, radialSegments: 16 }, [0, 1, 0], [1, 1, 1], "pbr_metal");
    }

    if (partIds.length === 0) {
      return "";
    }

    const groupId = engineApi.createGroup(partIds, "solid");
    engineApi.frameSelection([groupId]);
    useEditorStore.getState().addLog(`[mannequin] loaded ${kind}`);
    return groupId;
  },

  applyTextureToSelection(textureId) {
    const state = useEditorStore.getState();
    const texture = state.data.project.textures[textureId];
    if (!texture) {
      return 0;
    }

    let affected = 0;
    for (const nodeId of state.data.selection) {
      const node = useEditorStore.getState().data.project.nodes[nodeId];
      if (!node || node.type === "import") {
        continue;
      }
      const currentMaterial = node.materialId ? useEditorStore.getState().data.project.materials[node.materialId] : undefined;
      if (currentMaterial?.kind === "pbr") {
        engineApi.updateMaterial(currentMaterial.id, {
          pbr: {
            ...(currentMaterial.pbr ?? createDefaultPbr()),
            baseColorMapId: texture.id
          }
        });
      } else {
        const baseColor = currentMaterial?.kind === "solidColor" ? currentMaterial.color ?? "#cccccc" : "#cccccc";
        const materialId = engineApi.createMaterial("pbr", {
          name: `${node.name} Skin`,
          pbr: {
            ...createDefaultPbr(),
            baseColor,
            baseColorMapId: texture.id
          }
        });
        engineApi.setNodeMaterial(nodeId, materialId);
      }
      affected += 1;
    }
    return affected;
  },

  recolorSelection(colorHex) {
    const color = normalizeColorHex(colorHex);
    const selection = [...useEditorStore.getState().data.selection];
    let affected = 0;
    for (const nodeId of selection) {
      const node = useEditorStore.getState().data.project.nodes[nodeId];
      if (!node || node.type === "import") {
        continue;
      }
      const currentMaterial = node.materialId ? useEditorStore.getState().data.project.materials[node.materialId] : undefined;
      if (currentMaterial?.kind === "pbr") {
        engineApi.updateMaterial(currentMaterial.id, {
          pbr: {
            ...(currentMaterial.pbr ?? createDefaultPbr()),
            baseColor: color
          }
        });
      } else if (currentMaterial?.kind === "solidColor") {
        engineApi.updateMaterial(currentMaterial.id, { color });
      } else {
        const materialId = engineApi.createMaterial("solidColor", {
          name: `${node.name} Color`,
          color
        });
        engineApi.setNodeMaterial(nodeId, materialId);
      }
      affected += 1;
    }
    return affected;
  },

  applyPatternToSelection(pattern) {
    const selection = [...useEditorStore.getState().data.selection];
    const paletteByPattern: Record<"stripes" | "camo" | "pulse", string[]> = {
      stripes: ["#e5e5e5", "#4d4d4d"],
      camo: ["#5a6b48", "#77895f", "#3a4a30"],
      pulse: ["#7bb8ff", "#96ffd0", "#ffe680"]
    };
    const palette = paletteByPattern[pattern];
    let affected = 0;

    for (let index = 0; index < selection.length; index += 1) {
      const nodeId = selection[index];
      const node = useEditorStore.getState().data.project.nodes[nodeId];
      if (!node || node.type === "import") {
        continue;
      }
      const color = palette[index % palette.length];
      const currentMaterial = node.materialId ? useEditorStore.getState().data.project.materials[node.materialId] : undefined;
      if (currentMaterial?.kind === "pbr") {
        engineApi.updateMaterial(currentMaterial.id, {
          pbr: {
            ...(currentMaterial.pbr ?? createDefaultPbr()),
            baseColor: color,
            roughness: pattern === "pulse" ? 0.2 : 0.65
          }
        });
      } else if (currentMaterial?.kind === "solidColor") {
        engineApi.updateMaterial(currentMaterial.id, { color });
      } else {
        const materialId = engineApi.createMaterial("solidColor", {
          name: `${node.name} Pattern`,
          color
        });
        engineApi.setNodeMaterial(nodeId, materialId);
      }
      affected += 1;
    }
    return affected;
  },

  async saveSelectionVariant(name) {
    const label = name.trim().length > 0 ? `mannequin variant: ${name.trim()}` : "mannequin variant";
    const created = await createProjectVersion(useEditorStore.getState().data.project, label);
    useEditorStore.getState().addLog(`[mannequin] variant saved ${created.id}`);
    return created.id;
  },

  generateArena() {
    const floorId = engineApi.createPrimitive(
      "terrain",
      { w: 320, d: 320, segments: 56, heightSeed: 512, heightScale: 1.6 },
      { position: [0, -6, 0] },
      "solid_sand"
    );
    const platformId = engineApi.createPrimitive(
      "cylinder",
      { rTop: 90, rBottom: 98, h: 10, radialSegments: 48 },
      { position: [0, -1, 0] },
      "pbr_metal"
    );
    const ringOuterId = engineApi.createPrimitive(
      "cylinder",
      { rTop: 116, rBottom: 116, h: 22, radialSegments: 48 },
      { position: [0, 8, 0] },
      "pbr_metal"
    );
    const ringInnerId = engineApi.createPrimitive(
      "cylinder",
      { rTop: 104, rBottom: 104, h: 24, radialSegments: 48 },
      { position: [0, 8, 0] },
      "pbr_metal"
    );
    const ringGroupId = engineApi.createGroup([ringOuterId, ringInnerId], "solid");
    engineApi.addBooleanOp("subtract", ringOuterId, ringInnerId);

    const pillarIds = [
      engineApi.createPrimitive("cylinder", { rTop: 5, rBottom: 5, h: 28, radialSegments: 24 }, { position: [85, 10, 85] }, "pbr_wood"),
      engineApi.createPrimitive("cylinder", { rTop: 5, rBottom: 5, h: 28, radialSegments: 24 }, { position: [-85, 10, 85] }, "pbr_wood"),
      engineApi.createPrimitive("cylinder", { rTop: 5, rBottom: 5, h: 28, radialSegments: 24 }, { position: [85, 10, -85] }, "pbr_wood"),
      engineApi.createPrimitive("cylinder", { rTop: 5, rBottom: 5, h: 28, radialSegments: 24 }, { position: [-85, 10, -85] }, "pbr_wood")
    ];

    const arenaGroupId = engineApi.createGroup([floorId, platformId, ringGroupId, ...pillarIds], "mixed");
    engineApi.setPhysicsSettings({
      enabled: true,
      simulate: false,
      runtimeMode: "static",
      floorY: -1
    });
    engineApi.frameSelection([arenaGroupId]);
    useEditorStore.getState().addLog("[arena] generated arena preset");
    return arenaGroupId;
  },

  generateBenchmarkScene(preset = "outdoor") {
    const state = useEditorStore.getState();
    const root = state.data.project.nodes[state.data.project.rootId];
    if (root && root.type === "group" && root.children.length > 0) {
      state.executeCommand(deleteNodesCommand([...root.children]));
    }
    battleSceneState = null;

    const presets: Record<
      BenchmarkScenePreset,
      {
        rows: number;
        cols: number;
        spacing: number;
        floorSize: number;
      }
    > = {
      indoor: { rows: 8, cols: 8, spacing: 18, floorSize: 220 },
      outdoor: { rows: 12, cols: 12, spacing: 26, floorSize: 420 },
      "large-world": { rows: 18, cols: 18, spacing: 32, floorSize: 820 }
    };
    const selectedPreset: BenchmarkScenePreset = preset in presets ? preset : "outdoor";
    const config = presets[selectedPreset];

    const nodeIds: string[] = [];
    const floorId = engineApi.createPrimitive(
      "terrain",
      {
        w: config.floorSize,
        d: config.floorSize,
        segments: Math.min(64, 24 + config.rows),
        heightSeed: 1444,
        heightScale: selectedPreset === "indoor" ? 0.4 : selectedPreset === "outdoor" ? 1.2 : 2.8
      },
      { position: [0, -6, 0] },
      "solid_sand"
    );
    nodeIds.push(floorId);

    const primitiveCycle: PrimitiveType[] = ["box", "cylinder", "sphere", "cone"];
    const materialCycle = ["pbr_metal", "pbr_plastic_matte", "pbr_wood", "solid_steel"];
    const offsetX = ((config.cols - 1) * config.spacing) / 2;
    const offsetZ = ((config.rows - 1) * config.spacing) / 2;

    for (let row = 0; row < config.rows; row += 1) {
      for (let col = 0; col < config.cols; col += 1) {
        const index = row * config.cols + col;
        const primitive = primitiveCycle[index % primitiveCycle.length];
        const x = col * config.spacing - offsetX;
        const z = row * config.spacing - offsetZ;
        const wave = Math.sin(row * 0.45) * Math.cos(col * 0.33);
        const y = 8 + wave * (selectedPreset === "large-world" ? 4 : 2.2);
        const materialId = materialCycle[index % materialCycle.length];

        if (primitive === "box") {
          nodeIds.push(
            engineApi.createPrimitive(
              "box",
              { w: 10 + (index % 4) * 2, h: 10 + (index % 5), d: 10 + (index % 3) * 3 },
              { position: [x, y, z] },
              materialId
            )
          );
          continue;
        }
        if (primitive === "cylinder") {
          nodeIds.push(
            engineApi.createPrimitive(
              "cylinder",
              {
                rTop: 4 + (index % 3),
                rBottom: 4 + ((index + 1) % 3),
                h: 12 + (index % 6),
                radialSegments: 18
              },
              { position: [x, y, z] },
              materialId
            )
          );
          continue;
        }
        if (primitive === "sphere") {
          nodeIds.push(
            engineApi.createPrimitive(
              "sphere",
              { r: 6 + (index % 4), widthSegments: 18, heightSegments: 14 },
              { position: [x, y + 1.4, z] },
              materialId
            )
          );
          continue;
        }

        nodeIds.push(
          engineApi.createPrimitive(
            "cone",
            { r: 6 + (index % 3), h: 12 + (index % 5), radialSegments: 18 },
            { position: [x, y, z] },
            materialId
          )
        );
      }
    }

    const groupId = engineApi.createGroup(nodeIds, "mixed");
    engineApi.setPhysicsSettings({
      enabled: true,
      simulate: false,
      runtimeMode: "static",
      floorY: -4
    });
    engineApi.frameSelection([groupId]);
    useEditorStore.getState().addLog(`[benchmark] preset=${selectedPreset} nodes=${nodeIds.length}`);
    return {
      preset: selectedPreset,
      groupId,
      nodeCount: nodeIds.length
    };
  },

  setupBattleScene() {
    const currentSnapshot = useEditorStore.getState().data.project;
    if (
      battleSceneState &&
      currentSnapshot.nodes[battleSceneState.arenaId] &&
      currentSnapshot.nodes[battleSceneState.actorAId] &&
      currentSnapshot.nodes[battleSceneState.actorBId]
    ) {
      engineApi.setPhysicsSettings({
        enabled: true,
        simulate: false,
        runtimeMode: "static",
        floorY: -1
      });
      engineApi.frameSelection([battleSceneState.arenaId, battleSceneState.actorAId, battleSceneState.actorBId]);
      useEditorStore.getState().addLog("[battle] setup reused");
      return { ...battleSceneState };
    }

    const arenaId = engineApi.generateArena();
    const actorAId = engineApi.loadMannequin("floatingCard");
    const actorBId = engineApi.loadMannequin("floatingCard");

    engineApi.setNodeTransform(actorAId, {
      position: [-52, 12, 0]
    });
    engineApi.setNodeTransform(actorBId, {
      position: [52, 12, 0]
    });

    engineApi.setNodeRigidBody(actorAId, {
      enabled: true,
      mode: "dynamic",
      mass: 2,
      gravityScale: 1,
      lockRotation: true,
      linearVelocity: [0, 0, 0]
    });
    engineApi.setNodeRigidBody(actorBId, {
      enabled: true,
      mode: "dynamic",
      mass: 2,
      gravityScale: 1,
      lockRotation: true,
      linearVelocity: [0, 0, 0]
    });

    engineApi.setNodeCollider(actorAId, {
      enabled: true,
      shape: "box",
      isTrigger: false,
      size: [40, 16, 58]
    });
    engineApi.setNodeCollider(actorBId, {
      enabled: true,
      shape: "box",
      isTrigger: false,
      size: [40, 16, 58]
    });

    engineApi.setPhysicsSettings({
      enabled: true,
      simulate: false,
      runtimeMode: "static",
      floorY: -1
    });

    battleSceneState = { arenaId, actorAId, actorBId };
    engineApi.frameSelection([arenaId, actorAId, actorBId]);
    useEditorStore.getState().addLog("[battle] setup complete");
    return { ...battleSceneState };
  },

  playBattleClash(impulse = 16) {
    let state = battleSceneState;
    const snapshot = useEditorStore.getState().data.project;
    if (
      !state ||
      !snapshot.nodes[state.arenaId] ||
      !snapshot.nodes[state.actorAId] ||
      !snapshot.nodes[state.actorBId]
    ) {
      battleSceneState = null;
      state = engineApi.setupBattleScene();
    }

    const force = Number.isFinite(impulse) ? Math.max(1, Math.min(200, impulse)) : 16;
    engineApi.setPhysicsSettings({
      enabled: true,
      simulate: true,
      runtimeMode: "arena"
    });

    engineApi.applyPhysicsImpulse(state.actorAId, [force, 1.5, 0]);
    engineApi.applyPhysicsImpulse(state.actorBId, [-force, 1.5, 0]);
    useEditorStore.getState().addLog(`[battle] clash impulse=${force.toFixed(2)}`);
    return true;
  },

  stopBattleScene() {
    if (!battleSceneState) {
      return;
    }
    const state = battleSceneState;
    engineApi.setPhysicsSettings({
      simulate: false,
      runtimeMode: "static"
    });
    engineApi.setNodeRigidBody(state.actorAId, { linearVelocity: [0, 0, 0] });
    engineApi.setNodeRigidBody(state.actorBId, { linearVelocity: [0, 0, 0] });
    useEditorStore.getState().addLog("[battle] stopped");
  },

  getBattleSceneState() {
    if (!battleSceneState) {
      return null;
    }
    const snapshot = useEditorStore.getState().data.project;
    if (
      !snapshot.nodes[battleSceneState.arenaId] ||
      !snapshot.nodes[battleSceneState.actorAId] ||
      !snapshot.nodes[battleSceneState.actorBId]
    ) {
      battleSceneState = null;
      return null;
    }
    return { ...battleSceneState };
  },

  createMaterial(kind, seed) {
    const state = useEditorStore.getState();
    const currentCount = Object.keys(state.data.project.materials).length;
    const id = createId("mat");
    const base: MaterialDef =
      kind === "solidColor"
        ? {
            id,
            name: createMaterialName(kind, currentCount),
            kind,
            color: "#cccccc"
          }
        : {
            id,
            name: createMaterialName(kind, currentCount),
            kind,
            pbr: createDefaultPbr()
          };

    const next: MaterialDef = {
      ...base,
      ...seed,
      id
    };

    state.executeCommand(upsertMaterialCommand(id, undefined, next));
    return id;
  },

  updateMaterial(materialId, patch) {
    const state = useEditorStore.getState();
    const current = state.data.project.materials[materialId];
    if (!current) {
      return;
    }

    const next: MaterialDef = {
      ...cloneMaterial(current),
      id: materialId,
      kind: current.kind
    };
    if (typeof patch.name === "string") {
      next.name = patch.name;
    }

    if (current.kind === "solidColor") {
      next.color = typeof patch.color === "string" ? patch.color : current.color ?? "#cccccc";
      delete next.pbr;
    } else {
      const currentPbr = { ...createDefaultPbr(), ...(current.pbr ?? {}) };
      const patchPbr: Partial<NonNullable<MaterialDef["pbr"]>> = patch.pbr ?? {};
      next.pbr = {
        metalness: typeof patchPbr.metalness === "number" ? patchPbr.metalness : currentPbr.metalness,
        roughness: typeof patchPbr.roughness === "number" ? patchPbr.roughness : currentPbr.roughness,
        baseColor: typeof patchPbr.baseColor === "string" ? patchPbr.baseColor : currentPbr.baseColor,
        emissiveColor: typeof patchPbr.emissiveColor === "string" ? patchPbr.emissiveColor : currentPbr.emissiveColor,
        emissiveIntensity: typeof patchPbr.emissiveIntensity === "number" ? patchPbr.emissiveIntensity : currentPbr.emissiveIntensity,
        transmission: typeof patchPbr.transmission === "number" ? patchPbr.transmission : currentPbr.transmission,
        ior: typeof patchPbr.ior === "number" ? patchPbr.ior : currentPbr.ior,
        baseColorMapId: normalizeMapId(patchPbr.baseColorMapId, currentPbr.baseColorMapId),
        normalMapId: normalizeMapId(patchPbr.normalMapId, currentPbr.normalMapId),
        aoMapId: normalizeMapId(patchPbr.aoMapId, currentPbr.aoMapId),
        roughnessMapId: normalizeMapId(patchPbr.roughnessMapId, currentPbr.roughnessMapId),
        metalnessMapId: normalizeMapId(patchPbr.metalnessMapId, currentPbr.metalnessMapId),
        emissiveMapId: normalizeMapId(patchPbr.emissiveMapId, currentPbr.emissiveMapId)
      };
      delete next.color;
    }

    state.executeCommand(upsertMaterialCommand(materialId, cloneMaterial(current), next));
  },

  deleteMaterial(materialId, fallbackMaterialId) {
    const state = useEditorStore.getState();
    const current = state.data.project.materials[materialId];
    if (!current) {
      return;
    }

    const materialIds = Object.keys(state.data.project.materials);
    if (materialIds.length <= 1) {
      state.addLog("[materials] at least one material must remain");
      return;
    }

    const fallback = fallbackMaterialId && fallbackMaterialId !== materialId ? fallbackMaterialId : materialIds.find((id) => id !== materialId);
    const reassignedNodes = Object.values(state.data.project.nodes)
      .filter((node) => node.materialId === materialId)
      .map((node) => node.id);

    state.executeCommand(removeMaterialCommand(materialId, cloneMaterial(current), reassignedNodes, fallback));
  },

  getProjectSnapshot() {
    return structuredClone(useEditorStore.getState().data.project);
  },

  listTemplates() {
    return (templates as Array<{ id: string; name: string; tags: string[] }>).map((item) => ({
      id: item.id,
      name: item.name,
      tags: item.tags
    }));
  },

  listMaterials() {
    const projectMaterials = Object.values(useEditorStore.getState().data.project.materials);
    return projectMaterials.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      color: item.color,
      pbr: item.pbr
    }));
  }
};

export default engineApi;
