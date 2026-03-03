import assert from "node:assert/strict";
import test from "node:test";
import { createPrimitiveNode, createProject, DEFAULT_TRANSFORM } from "../../reycad/src/engine/scenegraph/factory";
import type { GroupNode } from "../../reycad/src/engine/scenegraph/types";
import engineApi from "../../reycad/src/engine/api/engineApi";
import { useEditorStore } from "../../reycad/src/editor/state/editorStore";
import {
  deleteNodesCommand,
  removeMaterialCommand,
  setMaterialBatchCommand,
  setNodeColliderCommand,
  setNodeRigidBodyCommand,
  setPhysicsConstraintsCommand,
  setPhysicsSettingsCommand,
  upsertMaterialCommand
} from "../../reycad/src/editor/commands/basicCommands";
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

test("setMaterialBatchCommand assigns and restores materials per node", () => {
  const state = createBaseState();
  const root = state.project.nodes[state.project.rootId] as GroupNode;

  const a = createPrimitiveNode("box");
  a.id = "batch_box_a";
  a.parentId = root.id;
  a.materialId = "solid_steel";

  const b = createPrimitiveNode("sphere");
  b.id = "batch_sphere_b";
  b.parentId = root.id;
  b.materialId = "solid_ember";

  root.children.push(a.id, b.id);
  state.project.nodes[a.id] = a;
  state.project.nodes[b.id] = b;

  const cmd = setMaterialBatchCommand([a.id, b.id, "missing_node"], "pbr_metal");
  const afterDo = cmd.do(state);
  assert.equal(afterDo.project.nodes[a.id].materialId, "pbr_metal");
  assert.equal(afterDo.project.nodes[b.id].materialId, "pbr_metal");

  const afterUndo = cmd.undo(afterDo);
  assert.equal(afterUndo.project.nodes[a.id].materialId, "solid_steel");
  assert.equal(afterUndo.project.nodes[b.id].materialId, "solid_ember");
});

test("physics commands apply and restore node/world physics", () => {
  const state = createBaseState();
  const root = state.project.nodes[state.project.rootId] as GroupNode;
  const node = createPrimitiveNode("box");
  node.id = "physics_box";
  node.parentId = root.id;
  root.children.push(node.id);
  state.project.nodes[node.id] = node;

  const rbCmd = setNodeRigidBodyCommand(node.id, undefined, {
    enabled: true,
    mode: "dynamic",
    mass: 2,
    gravityScale: 1,
    lockRotation: true,
    linearVelocity: [0, 0, 0]
  });
  const afterRb = rbCmd.do(state);
  assert.equal(afterRb.project.nodes[node.id].rigidBody?.mode, "dynamic");

  const colCmd = setNodeColliderCommand(node.id, undefined, {
    enabled: true,
    shape: "box",
    isTrigger: false,
    size: [10, 10, 10]
  });
  const afterCol = colCmd.do(afterRb);
  assert.equal(afterCol.project.nodes[node.id].collider?.shape, "box");

  const beforePhysics = afterCol.project.physics;
  const nextPhysics = {
    ...beforePhysics,
    enabled: true,
    simulate: true,
    backend: "lite" as const,
    floorY: -2
  };
  const worldCmd = setPhysicsSettingsCommand(beforePhysics, nextPhysics);
  const afterWorld = worldCmd.do(afterCol);
  assert.equal(afterWorld.project.physics.enabled, true);
  assert.equal(afterWorld.project.physics.backend, "lite");

  const beforeConstraints = afterWorld.project.physics.constraints;
  const nextConstraints = [
    ...beforeConstraints,
    {
      id: "constraint_one",
      type: "distance" as const,
      a: node.id,
      b: node.id,
      restLength: 10,
      stiffness: 0.6,
      damping: 0.1,
      enabled: true
    }
  ];
  const constraintsCmd = setPhysicsConstraintsCommand(beforeConstraints, nextConstraints);
  const afterConstraints = constraintsCmd.do(afterWorld);
  assert.equal(afterConstraints.project.physics.constraints.length, 1);

  const undoneConstraints = constraintsCmd.undo(afterConstraints);
  assert.equal(undoneConstraints.project.physics.constraints.length, 0);

  const undoneWorld = worldCmd.undo(undoneConstraints);
  assert.equal(undoneWorld.project.physics.enabled, beforePhysics.enabled);
  const undoneCol = colCmd.undo(undoneWorld);
  assert.equal(undoneCol.project.nodes[node.id].collider, undefined);
  const undoneRb = rbCmd.undo(undoneCol);
  assert.equal(undoneRb.project.nodes[node.id].rigidBody, undefined);
});

test("engineApi loadMannequin creates grouped mannequin nodes", () => {
  useEditorStore.getState().loadProject(createProject());

  const groupId = engineApi.loadMannequin("humanoid");
  const snapshot = engineApi.getProjectSnapshot();
  const group = snapshot.nodes[groupId];

  assert.ok(group);
  assert.equal(group.type, "group");
  assert.ok(group.type === "group" && group.children.length >= 5, "expected grouped mannequin with body parts");
});

test("engineApi generateArena creates arena scaffold and static runtime mode", () => {
  useEditorStore.getState().loadProject(createProject());

  const arenaId = engineApi.generateArena();
  const snapshot = engineApi.getProjectSnapshot();
  const arenaNode = snapshot.nodes[arenaId];
  const terrains = Object.values(snapshot.nodes).filter((node) => node.type === "primitive" && node.primitive === "terrain");

  assert.ok(arenaNode);
  assert.equal(arenaNode.type, "group");
  assert.ok(terrains.length >= 1, "expected at least one terrain node for arena floor");
  assert.equal(snapshot.physics.enabled, true);
  assert.equal(snapshot.physics.simulate, false);
  assert.equal(snapshot.physics.runtimeMode, "static");
});

test("engineApi generateBenchmarkScene clears scene and creates reproducible dense preset", () => {
  useEditorStore.getState().loadProject(createProject());
  const staleNodeId = engineApi.createPrimitive("box");

  const summary = engineApi.generateBenchmarkScene("outdoor");
  const snapshot = engineApi.getProjectSnapshot();
  const benchmarkGroup = snapshot.nodes[summary.groupId];

  assert.equal(summary.preset, "outdoor");
  assert.ok(summary.nodeCount >= 140, `expected dense benchmark node count, got ${summary.nodeCount}`);
  assert.equal(snapshot.nodes[staleNodeId], undefined, "expected previous scene node to be cleared");
  assert.ok(benchmarkGroup);
  assert.equal(benchmarkGroup.type, "group");
  assert.equal(snapshot.physics.enabled, true);
  assert.equal(snapshot.physics.simulate, false);
  assert.equal(snapshot.physics.runtimeMode, "static");
});

test("engineApi applyTextureToSelection assigns uploaded texture map to selected node", () => {
  useEditorStore.getState().loadProject(createProject());
  const nodeId = engineApi.createPrimitive("box");
  engineApi.setSelection([nodeId]);

  const textureId = engineApi.createTextureAsset(
    "skin.png",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W2FEAAAAASUVORK5CYII=",
    "image/png"
  );
  const affected = engineApi.applyTextureToSelection(textureId);
  const snapshot = engineApi.getProjectSnapshot();
  const node = snapshot.nodes[nodeId];
  const materialId = node.materialId;
  const material = materialId ? snapshot.materials[materialId] : undefined;

  assert.equal(affected, 1);
  assert.ok(materialId);
  assert.ok(material && material.kind === "pbr");
  assert.equal(material?.kind === "pbr" ? material.pbr?.baseColorMapId : undefined, textureId);
});

test("engineApi battle scene flow setup play stop toggles runtime mode", () => {
  useEditorStore.getState().loadProject(createProject());

  const setup = engineApi.setupBattleScene();
  assert.ok(setup.arenaId);
  assert.ok(setup.actorAId);
  assert.ok(setup.actorBId);

  let snapshot = engineApi.getProjectSnapshot();
  assert.ok(snapshot.nodes[setup.arenaId]);
  assert.ok(snapshot.nodes[setup.actorAId]);
  assert.ok(snapshot.nodes[setup.actorBId]);
  assert.equal(snapshot.physics.enabled, true);
  assert.equal(snapshot.physics.simulate, false);
  assert.equal(snapshot.physics.runtimeMode, "static");

  const started = engineApi.playBattleClash(20);
  assert.equal(started, true);

  snapshot = engineApi.getProjectSnapshot();
  assert.equal(snapshot.physics.enabled, true);
  assert.equal(snapshot.physics.simulate, true);
  assert.equal(snapshot.physics.runtimeMode, "arena");

  const runtimeState = engineApi.getBattleSceneState();
  assert.ok(runtimeState);
  assert.equal(runtimeState?.arenaId, setup.arenaId);

  engineApi.stopBattleScene();
  snapshot = engineApi.getProjectSnapshot();
  assert.equal(snapshot.physics.simulate, false);
  assert.equal(snapshot.physics.runtimeMode, "static");
});
