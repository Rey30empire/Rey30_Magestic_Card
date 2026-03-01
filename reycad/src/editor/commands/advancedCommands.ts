import { produce } from "immer";
import { createId } from "../../lib/ids";
import type { GroupNode, Node, BooleanOp } from "../../engine/scenegraph/types";
import type { EditorData } from "../state/types";
import type { Command } from "./types";

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function groupCommand(nodeIds: string[], mode: "solid" | "hole" | "mixed" = "mixed"): Command {
  const groupId = createId("group");
  return {
    id: createId("cmd"),
    name: `Group ${nodeIds.length} node(s)`,
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const targetParent = nodeIds.length > 0 ? draft.project.nodes[nodeIds[0]]?.parentId ?? draft.project.rootId : draft.project.rootId;
        const group: GroupNode = {
          id: groupId,
          name: "Group",
          type: "group",
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visible: true,
          locked: false,
          mode,
          children: [],
          ops: [],
          parentId: targetParent
        };
        draft.project.nodes[group.id] = group;
        const parentNode = draft.project.nodes[targetParent];
        if (parentNode && parentNode.type === "group") {
          parentNode.children.push(group.id);
        }

        for (const nodeId of nodeIds) {
          const node = draft.project.nodes[nodeId];
          if (!node) {
            continue;
          }
          const previousParent = node.parentId ? draft.project.nodes[node.parentId] : undefined;
          if (previousParent && previousParent.type === "group") {
            previousParent.children = previousParent.children.filter((id) => id !== nodeId);
          }
          node.parentId = group.id;
          group.children.push(nodeId);
        }
        draft.selection = [group.id];
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const group = draft.project.nodes[groupId];
        if (!group || group.type !== "group") {
          return;
        }
        const groupParent = group.parentId ? draft.project.nodes[group.parentId] : undefined;
        if (groupParent && groupParent.type === "group") {
          groupParent.children = groupParent.children.filter((id) => id !== group.id);
        }
        for (const childId of group.children) {
          const child = draft.project.nodes[childId];
          if (!child) {
            continue;
          }
          child.parentId = group.parentId ?? draft.project.rootId;
          const parent = draft.project.nodes[child.parentId];
          if (parent && parent.type === "group" && !parent.children.includes(childId)) {
            parent.children.push(childId);
          }
        }
        delete draft.project.nodes[group.id];
      });
    }
  };
}

export function ungroupCommand(groupId: string): Command {
  let snapshot: GroupNode | null = null;
  return {
    id: createId("cmd"),
    name: "Ungroup",
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const group = draft.project.nodes[groupId];
        if (!group || group.type !== "group") {
          return;
        }
        snapshot = cloneValue(group);
        const parentId = group.parentId ?? draft.project.rootId;
        const parent = draft.project.nodes[parentId];
        if (parent && parent.type === "group") {
          parent.children = parent.children.filter((id) => id !== group.id);
        }

        for (const childId of group.children) {
          const child = draft.project.nodes[childId];
          if (!child) {
            continue;
          }
          child.parentId = parentId;
          if (parent && parent.type === "group" && !parent.children.includes(childId)) {
            parent.children.push(childId);
          }
        }

        delete draft.project.nodes[group.id];
        draft.selection = [...group.children];
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        if (!snapshot) {
          return;
        }
        const parentId = snapshot.parentId ?? draft.project.rootId;
        const parent = draft.project.nodes[parentId];
        draft.project.nodes[snapshot.id] = cloneValue(snapshot);
        if (parent && parent.type === "group" && !parent.children.includes(snapshot.id)) {
          parent.children.push(snapshot.id);
        }
        for (const childId of snapshot.children) {
          const child = draft.project.nodes[childId];
          if (!child) {
            continue;
          }
          child.parentId = snapshot.id;
          if (parent && parent.type === "group") {
            parent.children = parent.children.filter((id) => id !== childId);
          }
        }
      });
    }
  };
}

export function duplicateCommand(nodeIds: string[]): Command {
  const clonedNodeIds = new Set<string>();
  const rootCloneIds: string[] = [];
  const parentChildrenBefore = new Map<string, string[]>();

  function collectSelectedRoots(state: EditorData): string[] {
    const selectedSet = new Set(nodeIds);
    return nodeIds.filter((nodeId) => {
      let current = state.project.nodes[nodeId];
      while (current?.parentId) {
        if (selectedSet.has(current.parentId)) {
          return false;
        }
        current = state.project.nodes[current.parentId];
      }
      return Boolean(state.project.nodes[nodeId]);
    });
  }

  function cloneSubtree(draft: EditorData, sourceId: string, parentId: string | undefined, isRoot = false): string | null {
    const sourceNode = draft.project.nodes[sourceId];
    if (!sourceNode) {
      return null;
    }

    const clone = cloneValue(sourceNode);
    clone.id = createId(sourceNode.type);
    clone.name = `${sourceNode.name} Copy`;
    clone.parentId = parentId;
    if (isRoot) {
      clone.transform.position = [clone.transform.position[0] + 5, clone.transform.position[1], clone.transform.position[2] + 5];
    }

    if (clone.type === "group") {
      const sourceChildren = [...sourceNode.children];
      clone.children = [];
      draft.project.nodes[clone.id] = clone;
      clonedNodeIds.add(clone.id);

      for (const childId of sourceChildren) {
        const childCloneId = cloneSubtree(draft, childId, clone.id, false);
        if (childCloneId) {
          clone.children.push(childCloneId);
        }
      }

      draft.project.nodes[clone.id] = clone;
      return clone.id;
    }

    draft.project.nodes[clone.id] = clone;
    clonedNodeIds.add(clone.id);
    return clone.id;
  }

  return {
    id: createId("cmd"),
    name: `Duplicate ${nodeIds.length} node(s)`,
    do(state: EditorData): EditorData {
      clonedNodeIds.clear();
      rootCloneIds.length = 0;
      parentChildrenBefore.clear();

      return produce(state, (draft) => {
        const selectedRoots = collectSelectedRoots(draft);
        for (const sourceRootId of selectedRoots) {
          const sourceRoot = draft.project.nodes[sourceRootId];
          if (!sourceRoot) {
            continue;
          }

          const parentId = sourceRoot.parentId ?? draft.project.rootId;
          const parent = draft.project.nodes[parentId];
          if (!parent || parent.type !== "group") {
            continue;
          }

          if (!parentChildrenBefore.has(parentId)) {
            parentChildrenBefore.set(parentId, [...parent.children]);
          }

          const cloneRootId = cloneSubtree(draft, sourceRootId, parentId, true);
          if (!cloneRootId) {
            continue;
          }

          parent.children.push(cloneRootId);
          rootCloneIds.push(cloneRootId);
        }
        draft.selection = [...rootCloneIds];
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        for (const [parentId, children] of parentChildrenBefore.entries()) {
          const parent = draft.project.nodes[parentId];
          if (parent && parent.type === "group") {
            parent.children = [...children];
          }
        }

        for (const cloneId of clonedNodeIds) {
          delete draft.project.nodes[cloneId];
        }

        draft.selection = draft.selection.filter((id) => !clonedNodeIds.has(id));
      });
    }
  };
}

export function addBooleanOpCommand(groupId: string, op: BooleanOp): Command {
  return {
    id: createId("cmd"),
    name: `Add Boolean ${op.op}`,
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const group = draft.project.nodes[groupId];
        if (group && group.type === "group") {
          group.ops = [...(group.ops ?? []), op];
        }
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const group = draft.project.nodes[groupId];
        if (group && group.type === "group") {
          group.ops = (group.ops ?? []).filter((item) => item.id !== op.id);
        }
      });
    }
  };
}

export function removeBooleanOpCommand(groupId: string, opId: string): Command {
  let removed: BooleanOp | undefined;
  return {
    id: createId("cmd"),
    name: "Remove Boolean",
    do(state: EditorData): EditorData {
      return produce(state, (draft) => {
        const group = draft.project.nodes[groupId];
        if (group && group.type === "group") {
          removed = (group.ops ?? []).find((item) => item.id === opId);
          group.ops = (group.ops ?? []).filter((item) => item.id !== opId);
        }
      });
    },
    undo(state: EditorData): EditorData {
      return produce(state, (draft) => {
        if (!removed) {
          return;
        }
        const group = draft.project.nodes[groupId];
        if (group && group.type === "group") {
          group.ops = [...(group.ops ?? []), removed];
        }
      });
    }
  };
}
