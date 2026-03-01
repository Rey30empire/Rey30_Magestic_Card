import assert from "node:assert/strict";
import test from "node:test";
import { createPrimitiveNode, createProject, DEFAULT_TRANSFORM } from "../../reycad/src/engine/scenegraph/factory";
import type { GroupNode } from "../../reycad/src/engine/scenegraph/types";
import { deleteNodesCommand, removeMaterialCommand, upsertMaterialCommand } from "../../reycad/src/editor/commands/basicCommands";
import { duplicateCommand } from "../../reycad/src/editor/commands/advancedCommands";
import type { EditorData } from "../../reycad/src/editor/state/types";

function createBaseState(): EditorData {
  return {
    project: createProject(),
    selection: [],
    logs: [],
    aiHistory: {
      undoBlocks: [],
      redoBlocks: []
    }
  };
}

function createGroup(id: string, name = "Group"): GroupNode {
  return {
    id,
    name,
    type: "group",
    transform: { ...DEFAULT_TRANSFORM },
    visible: true,
    locked: false,
    mode: "mixed",
    children: [],
    ops: []
  };
}

test("deleteNodesCommand removes subtree and restores it on undo", () => {
  const state = createBaseState();
  const root = state.project.nodes[state.project.rootId] as GroupNode;
  const group = createGroup("group_a", "Group A");
  const child = createPrimitiveNode("box");
  child.id = "child_box";
  child.parentId = group.id;
  group.children = [child.id];
  group.parentId = root.id;

  state.project.nodes[group.id] = group;
  state.project.nodes[child.id] = child;
  root.children.push(group.id);
  state.selection = [group.id, child.id];

  const cmd = deleteNodesCommand([group.id]);
  const afterDelete = cmd.do(state);
  assert.equal(afterDelete.project.nodes[group.id], undefined);
  assert.equal(afterDelete.project.nodes[child.id], undefined);
  assert.equal((afterDelete.project.nodes[root.id] as GroupNode).children.includes(group.id), false);

  const afterUndo = cmd.undo(afterDelete);
  assert.ok(afterUndo.project.nodes[group.id]);
  assert.ok(afterUndo.project.nodes[child.id]);
  assert.equal((afterUndo.project.nodes[root.id] as GroupNode).children.includes(group.id), true);
  assert.equal((afterUndo.project.nodes[group.id] as GroupNode).children.includes(child.id), true);
});

test("duplicateCommand clones group subtree with remapped child ids and keeps hierarchy", () => {
  const state = createBaseState();
  const root = state.project.nodes[state.project.rootId] as GroupNode;
  const group = createGroup("group_source", "Source Group");
  const child = createPrimitiveNode("cylinder");
  child.id = "child_source";
  child.parentId = group.id;
  group.children = [child.id];
  group.parentId = root.id;

  state.project.nodes[group.id] = group;
  state.project.nodes[child.id] = child;
  root.children.push(group.id);
  state.selection = [group.id];

  const cmd = duplicateCommand([group.id]);
  const afterDuplicate = cmd.do(state);

  assert.equal(afterDuplicate.selection.length, 1);
  const clonedGroupId = afterDuplicate.selection[0];
  assert.notEqual(clonedGroupId, group.id);

  const clonedGroup = afterDuplicate.project.nodes[clonedGroupId] as GroupNode;
  assert.ok(clonedGroup);
  assert.equal(clonedGroup.type, "group");
  assert.equal(clonedGroup.children.length, 1);
  assert.equal((afterDuplicate.project.nodes[root.id] as GroupNode).children.includes(clonedGroupId), true);

  const clonedChildId = clonedGroup.children[0];
  assert.notEqual(clonedChildId, child.id);
  const clonedChild = afterDuplicate.project.nodes[clonedChildId];
  assert.ok(clonedChild);
  assert.equal(clonedChild.parentId, clonedGroupId);

  const afterUndo = cmd.undo(afterDuplicate);
  assert.equal(afterUndo.project.nodes[clonedGroupId], undefined);
  assert.equal(afterUndo.project.nodes[clonedChildId], undefined);
  assert.equal((afterUndo.project.nodes[root.id] as GroupNode).children.includes(clonedGroupId), false);
});

test("material commands upsert and remove without losing node assignments on undo", () => {
  const state = createBaseState();
  const box = createPrimitiveNode("box");
  box.id = "mat_box";
  box.parentId = state.project.rootId;
  (state.project.nodes[state.project.rootId] as GroupNode).children.push(box.id);
  state.project.nodes[box.id] = box;

  const createdMaterial = {
    id: "mat_custom",
    name: "Custom",
    kind: "solidColor" as const,
    color: "#112233"
  };

  const createCmd = upsertMaterialCommand(createdMaterial.id, undefined, createdMaterial);
  const afterCreate = createCmd.do(state);
  assert.ok(afterCreate.project.materials[createdMaterial.id]);

  const assignCmdState = {
    ...afterCreate,
    project: {
      ...afterCreate.project,
      nodes: {
        ...afterCreate.project.nodes,
        [box.id]: {
          ...afterCreate.project.nodes[box.id],
          materialId: createdMaterial.id
        }
      }
    }
  };

  const removeCmd = removeMaterialCommand(createdMaterial.id, createdMaterial, [box.id], "solid_steel");
  const afterRemove = removeCmd.do(assignCmdState);
  assert.equal(afterRemove.project.materials[createdMaterial.id], undefined);
  assert.equal(afterRemove.project.nodes[box.id].materialId, "solid_steel");

  const afterUndoRemove = removeCmd.undo(afterRemove);
  assert.ok(afterUndoRemove.project.materials[createdMaterial.id]);
  assert.equal(afterUndoRemove.project.nodes[box.id].materialId, createdMaterial.id);
});
