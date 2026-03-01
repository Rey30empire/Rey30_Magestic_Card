import { produce } from "immer";
import { createId } from "../../lib/ids";
import type { PrimitiveNode, Transform, Node, Project, MaterialDef } from "../../engine/scenegraph/types";
import type { Command } from "./types";
import type { EditorData } from "../state/types";

function addChild(project: Project, parentId: string, childId: string): void {
  const parent = project.nodes[parentId];
  if (parent && parent.type === "group" && !parent.children.includes(childId)) {
    parent.children.push(childId);
  }
}

function removeChild(project: Project, parentId: string | undefined, childId: string): void {
  if (!parentId) {
    return;
  }
  const parent = project.nodes[parentId];
  if (parent && parent.type === "group") {
    parent.children = parent.children.filter((id) => id !== childId);
  }
}

function collectSubtreeNodeIds(project: Project, nodeId: string, out: Set<string>): void {
  if (out.has(nodeId)) {
    return;
  }

  const node = project.nodes[nodeId];
  if (!node) {
    return;
  }

  out.add(nodeId);
  if (node.type !== "group") {
    return;
  }

  for (const childId of node.children) {
    collectSubtreeNodeIds(project, childId, out);
  }
}

function cloneNode<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function addNodeCommand(node: Node, parentId: string): Command {
  return {
    id: createId("cmd"),
    name: `Add ${node.name}`,
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        draft.project.nodes[node.id] = node;
        draft.project.nodes[node.id].parentId = parentId;
        addChild(draft.project, parentId, node.id);
        draft.selection = [node.id];
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const current = draft.project.nodes[node.id];
        if (!current) {
          return;
        }
        removeChild(draft.project, current.parentId, node.id);
        delete draft.project.nodes[node.id];
        draft.selection = draft.selection.filter((id) => id !== node.id);
      });
    }
  };
}

export function updateTransformCommand(nodeId: string, previous: Transform, next: Transform): Command {
  return {
    id: createId("cmd"),
    name: `Transform ${nodeId}`,
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const node = draft.project.nodes[nodeId];
        if (node) {
          node.transform = next;
        }
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const node = draft.project.nodes[nodeId];
        if (node) {
          node.transform = previous;
        }
      });
    }
  };
}

export function updateParamsCommand(nodeId: string, before: PrimitiveNode["params"], after: PrimitiveNode["params"]): Command {
  return {
    id: createId("cmd"),
    name: `Update Params ${nodeId}`,
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const node = draft.project.nodes[nodeId];
        if (node && node.type === "primitive") {
          node.params = after as never;
        }
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const node = draft.project.nodes[nodeId];
        if (node && node.type === "primitive") {
          node.params = before as never;
        }
      });
    }
  };
}

export function setMaterialCommand(nodeId: string, before: string | undefined, after: string | undefined): Command {
  return {
    id: createId("cmd"),
    name: `Set Material ${nodeId}`,
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const node = draft.project.nodes[nodeId];
        if (node) {
          node.materialId = after;
        }
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const node = draft.project.nodes[nodeId];
        if (node) {
          node.materialId = before;
        }
      });
    }
  };
}

export function renameCommand(nodeId: string, before: string, after: string): Command {
  return {
    id: createId("cmd"),
    name: `Rename ${nodeId}`,
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const node = draft.project.nodes[nodeId];
        if (node) {
          node.name = after;
        }
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const node = draft.project.nodes[nodeId];
        if (node) {
          node.name = before;
        }
      });
    }
  };
}

export function deleteNodesCommand(nodeIds: string[]): Command {
  const deletedNodes = new Map<string, Node>();
  const parentChildrenBefore = new Map<string, string[]>();
  let deletedCount = 0;
  return {
    id: createId("cmd"),
    name: `Delete ${nodeIds.length} node(s)`,
    do(state: EditorData): EditorData {
      deletedNodes.clear();
      parentChildrenBefore.clear();
      deletedCount = 0;

      return produce(state, (draft) => {
        const deleteSet = new Set<string>();
        for (const nodeId of nodeIds) {
          if (nodeId === draft.project.rootId) {
            continue;
          }
          collectSubtreeNodeIds(draft.project, nodeId, deleteSet);
        }

        for (const nodeId of deleteSet) {
          const node = draft.project.nodes[nodeId];
          if (!node) {
            continue;
          }
          deletedNodes.set(nodeId, cloneNode(node));
          if (node.parentId && !deleteSet.has(node.parentId) && !parentChildrenBefore.has(node.parentId)) {
            const parent = draft.project.nodes[node.parentId];
            if (parent && parent.type === "group") {
              parentChildrenBefore.set(node.parentId, [...parent.children]);
            }
          }
        }

        for (const [parentId, children] of parentChildrenBefore.entries()) {
          const parent = draft.project.nodes[parentId];
          if (!parent || parent.type !== "group") {
            continue;
          }
          parent.children = children.filter((childId) => !deleteSet.has(childId));
        }

        for (const nodeId of deleteSet) {
          delete draft.project.nodes[nodeId];
        }

        deletedCount = deleteSet.size;
        draft.selection = draft.selection.filter((id) => !deleteSet.has(id));
        draft.logs.push(`Deleted ${deletedCount} node(s)`);
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        for (const [nodeId, node] of deletedNodes.entries()) {
          draft.project.nodes[nodeId] = cloneNode(node);
        }

        for (const [parentId, children] of parentChildrenBefore.entries()) {
          const parent = draft.project.nodes[parentId];
          if (parent && parent.type === "group") {
            parent.children = [...children];
          }
        }
      });
    }
  };
}

export function toggleHoleCommand(nodeId: string, before: "solid" | "hole", after: "solid" | "hole"): Command {
  return {
    id: createId("cmd"),
    name: `Toggle Hole ${nodeId}`,
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const node = draft.project.nodes[nodeId];
        if (node && node.type !== "import") {
          node.mode = after;
        }
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const node = draft.project.nodes[nodeId];
        if (node && node.type !== "import") {
          node.mode = before;
        }
      });
    }
  };
}

export function setGridCommand(
  before: Project["grid"],
  after: Project["grid"]
): Command {
  return {
    id: createId("cmd"),
    name: "Set Grid",
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        draft.project.grid = { ...after };
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        draft.project.grid = { ...before };
      });
    }
  };
}

export function upsertMaterialCommand(
  materialId: string,
  before: MaterialDef | undefined,
  after: MaterialDef
): Command {
  return {
    id: createId("cmd"),
    name: `Upsert Material ${after.name}`,
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        draft.project.materials[materialId] = cloneNode(after);
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        if (before) {
          draft.project.materials[materialId] = cloneNode(before);
          return;
        }

        delete draft.project.materials[materialId];
        for (const node of Object.values(draft.project.nodes)) {
          if (node.materialId === materialId) {
            delete node.materialId;
          }
        }
      });
    }
  };
}

export function removeMaterialCommand(
  materialId: string,
  before: MaterialDef,
  reassignedNodes: string[],
  fallbackMaterialId?: string
): Command {
  return {
    id: createId("cmd"),
    name: `Delete Material ${before.name}`,
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        delete draft.project.materials[materialId];
        for (const nodeId of reassignedNodes) {
          const node = draft.project.nodes[nodeId];
          if (!node) {
            continue;
          }
          if (fallbackMaterialId) {
            node.materialId = fallbackMaterialId;
          } else {
            delete node.materialId;
          }
        }
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        draft.project.materials[materialId] = cloneNode(before);
        for (const nodeId of reassignedNodes) {
          const node = draft.project.nodes[nodeId];
          if (node) {
            node.materialId = materialId;
          }
        }
      });
    }
  };
}
