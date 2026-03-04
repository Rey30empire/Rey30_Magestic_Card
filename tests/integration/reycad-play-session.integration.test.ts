import assert from "node:assert/strict";
import test from "node:test";
import { createProject } from "../../reycad/src/engine/scenegraph/factory";
import engineApi from "../../reycad/src/engine/api/engineApi";
import { useEditorStore } from "../../reycad/src/editor/state/editorStore";

function resetEditor(): void {
  useEditorStore.getState().loadProject(createProject());
}

test("PIE integration flow edit -> play -> stop restores editor world", () => {
  resetEditor();
  const baseNodeId = engineApi.createPrimitive("box");
  const before = useEditorStore.getState().data;
  const beforePhysics = before.project.physics;
  const beforeNodeCount = Object.keys(before.project.nodes).length;

  const started = useEditorStore.getState().startPlaySession(60_000);
  assert.equal(started, true);
  assert.equal(useEditorStore.getState().play.isPlaying, true);

  const transientNodeId = engineApi.createPrimitive("sphere");
  engineApi.deleteNodes([baseNodeId]); // blocked while play is active

  const duringPlay = useEditorStore.getState();
  assert.ok(duringPlay.data.project.nodes[baseNodeId], "base node should survive blocked delete");
  assert.ok(duringPlay.data.project.nodes[transientNodeId], "transient node should exist in play world");
  assert.equal(duringPlay.play.blockedCommands, 1);

  const stopped = useEditorStore.getState().stopPlaySession("user_stop");
  assert.equal(stopped, true);

  const after = useEditorStore.getState();
  assert.equal(after.play.isPlaying, false);
  assert.equal(after.play.lastStopReason, "user_stop");
  assert.ok(after.data.project.nodes[baseNodeId], "base node should still exist after restore");
  assert.equal(after.data.project.nodes[transientNodeId], undefined, "play-only node must be removed after restore");
  assert.deepEqual(after.data.project.physics, beforePhysics);
  assert.equal(Object.keys(after.data.project.nodes).length, beforeNodeCount);
});

test("PIE hard reset keeps active session and restores play clone from snapshot", () => {
  resetEditor();
  const baseNodeId = engineApi.createPrimitive("box");
  const started = useEditorStore.getState().startPlaySession(60_000);
  assert.equal(started, true);

  const transientNodeId = engineApi.createPrimitive("cone");
  const hardReset = useEditorStore.getState().hardResetPlaySession();
  assert.equal(hardReset, true);

  const duringPlay = useEditorStore.getState();
  assert.equal(duringPlay.play.isPlaying, true);
  assert.ok(duringPlay.data.project.nodes[baseNodeId], "snapshot baseline node should remain");
  assert.equal(duringPlay.data.project.nodes[transientNodeId], undefined, "hard reset should drop transient mutations");

  const panicStopped = useEditorStore.getState().panicStopPlaySession();
  assert.equal(panicStopped, true);
  const after = useEditorStore.getState();
  assert.equal(after.play.isPlaying, false);
  assert.equal(after.play.lastStopReason, "panic");
});
