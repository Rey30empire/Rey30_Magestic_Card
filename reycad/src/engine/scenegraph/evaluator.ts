import type { GroupNode, Node, PrimitiveNode, Project, Transform } from "./types";
import { evaluateCsgPipeline } from "./csgPipeline";
import type { BooleanOp } from "./types";

export type RenderPrimitive = {
  nodeId: string;
  primitive: PrimitiveNode["primitive"];
  params: PrimitiveNode["params"];
  materialId?: string;
  transform: Transform;
  mode: "solid" | "hole";
};

export type RenderScene = {
  items: RenderPrimitive[];
  booleanTasks: Array<{
    groupId: string;
    primitives: RenderPrimitive[];
    ops: BooleanOp[];
  }>;
  suppressedNodeIds: string[];
  nodeMeshMap: Record<string, string[]>;
  warnings: string[];
};

function addTransforms(a: Transform, b: Transform): Transform {
  return {
    position: [a.position[0] + b.position[0], a.position[1] + b.position[1], a.position[2] + b.position[2]],
    rotation: [a.rotation[0] + b.rotation[0], a.rotation[1] + b.rotation[1], a.rotation[2] + b.rotation[2]],
    scale: [a.scale[0] * b.scale[0], a.scale[1] * b.scale[1], a.scale[2] * b.scale[2]]
  };
}

function collectNodes(
  project: Project,
  nodeId: string,
  inherited: Transform,
  inheritedMode: "solid" | "hole",
  out: RenderPrimitive[],
  transformCache: Map<string, Transform>
): void {
  const node = project.nodes[nodeId];
  if (!node || !node.visible) {
    return;
  }

  const cacheKey = `${node.id}:${JSON.stringify(node.transform)}:${JSON.stringify(inherited)}`;
  let world = transformCache.get(cacheKey);
  if (!world) {
    world = addTransforms(inherited, node.transform);
    transformCache.set(cacheKey, world);
  }

  if (node.type === "primitive") {
    const ownMode = node.mode ?? "solid";
    const effectiveMode: "solid" | "hole" = inheritedMode === "hole" || ownMode === "hole" ? "hole" : "solid";
    out.push({
      nodeId: node.id,
      primitive: node.primitive,
      params: node.params,
      materialId: node.materialId,
      transform: world,
      mode: effectiveMode
    });
    return;
  }

  if (node.type === "group") {
    const group = node as GroupNode;
    const groupMode = group.mode === "hole" ? "hole" : inheritedMode;
    for (const childId of group.children) {
      collectNodes(project, childId, world, groupMode, out, transformCache);
    }
  }
}

function hasBooleanFeature(group: GroupNode, descendantPrimitives: RenderPrimitive[]): boolean {
  if ((group.ops?.length ?? 0) > 0) {
    return true;
  }
  const hasHole = descendantPrimitives.some((item) => item.mode === "hole");
  const hasSolid = descendantPrimitives.some((item) => item.mode !== "hole");
  return hasHole && hasSolid;
}

function isDescendantOfGroup(project: Project, nodeId: string, groupId: string): boolean {
  let cursor = project.nodes[nodeId];
  while (cursor?.parentId) {
    if (cursor.parentId === groupId) {
      return true;
    }
    cursor = project.nodes[cursor.parentId];
  }
  return false;
}

function isTopLevelBooleanGroup(project: Project, groupId: string, candidates: Set<string>): boolean {
  let cursor = project.nodes[groupId];
  while (cursor?.parentId) {
    if (candidates.has(cursor.parentId)) {
      return false;
    }
    cursor = project.nodes[cursor.parentId];
  }
  return true;
}

export function evaluateProject(project: Project): RenderScene {
  const transformCache = new Map<string, Transform>();
  const identity: Transform = {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
  };

  const primitives: RenderPrimitive[] = [];
  collectNodes(project, project.rootId, identity, "solid", primitives, transformCache);

  const booleanCandidateIds = new Set<string>();
  for (const node of Object.values(project.nodes)) {
    if (node.type !== "group" || node.id === project.rootId) {
      continue;
    }
    const descendants = primitives.filter((item) => isDescendantOfGroup(project, item.nodeId, node.id));
    if (descendants.length === 0) {
      continue;
    }
    if (hasBooleanFeature(node, descendants)) {
      booleanCandidateIds.add(node.id);
    }
  }

  const booleanTasks: RenderScene["booleanTasks"] = [];
  const suppressedNodeIds = new Set<string>();
  for (const groupId of booleanCandidateIds) {
    if (!isTopLevelBooleanGroup(project, groupId, booleanCandidateIds)) {
      continue;
    }
    const groupNode = project.nodes[groupId];
    if (!groupNode || groupNode.type !== "group") {
      continue;
    }
    const descendants = primitives.filter((item) => isDescendantOfGroup(project, item.nodeId, groupId));
    if (descendants.length === 0) {
      continue;
    }
    booleanTasks.push({
      groupId,
      primitives: descendants,
      ops: groupNode.ops ?? []
    });
    for (const item of descendants) {
      suppressedNodeIds.add(item.nodeId);
    }
  }

  const directItems = primitives.filter((item) => !suppressedNodeIds.has(item.nodeId));

  const csg = evaluateCsgPipeline(project, Object.values(project.nodes) as Node[]);
  const nodeMeshMap: Record<string, string[]> = {};
  for (const item of directItems) {
    nodeMeshMap[item.nodeId] = [item.nodeId];
  }
  for (const task of booleanTasks) {
    nodeMeshMap[task.groupId] = [task.groupId];
  }

  return {
    items: directItems,
    booleanTasks,
    suppressedNodeIds: [...suppressedNodeIds],
    nodeMeshMap,
    warnings: csg.warnings.map((warning) => warning.message)
  };
}
