import assert from "node:assert/strict";
import test from "node:test";
import { createProject } from "../../reycad/src/engine/scenegraph/factory";
import engineApi from "../../reycad/src/engine/api/engineApi";
import { useEditorStore } from "../../reycad/src/editor/state/editorStore";

function resetEditor(): void {
  useEditorStore.getState().loadProject(createProject());
}

test("editor store blocks destructive commands while play session is active", () => {
  resetEditor();
  const baseNodeId = engineApi.createPrimitive("box");

  const started = useEditorStore.getState().startPlaySession(60_000);
  assert.equal(started, true);
  assert.equal(useEditorStore.getState().play.isPlaying, true);

  engineApi.deleteNodes([baseNodeId]);
  const duringPlay = useEditorStore.getState();
  assert.ok(duringPlay.data.project.nodes[baseNodeId]);
  assert.equal(duringPlay.play.blockedCommands, 1);
  assert.ok(duringPlay.data.logs.some((line) => line.includes("[play] blocked command")));

  const stopped = useEditorStore.getState().stopPlaySession("user_stop");
  assert.equal(stopped, true);
  const afterStop = useEditorStore.getState();
  assert.equal(afterStop.play.isPlaying, false);
  assert.equal(afterStop.play.lastStopReason, "user_stop");
  assert.ok(afterStop.data.project.nodes[baseNodeId]);
});

test("hard reset keeps play active and rolls back play-only mutations", () => {
  resetEditor();
  const baseNodeId = engineApi.createPrimitive("box");
  const started = useEditorStore.getState().startPlaySession(60_000);
  assert.equal(started, true);

  const playOnlyNodeId = engineApi.createPrimitive("sphere");
  let duringPlay = useEditorStore.getState();
  assert.ok(duringPlay.data.project.nodes[playOnlyNodeId]);

  const hardReset = useEditorStore.getState().hardResetPlaySession();
  assert.equal(hardReset, true);
  duringPlay = useEditorStore.getState();
  assert.equal(duringPlay.play.isPlaying, true);
  assert.equal(duringPlay.data.project.nodes[playOnlyNodeId], undefined);
  assert.ok(duringPlay.data.project.nodes[baseNodeId]);

  const panicStopped = useEditorStore.getState().panicStopPlaySession();
  assert.equal(panicStopped, true);
  const finalState = useEditorStore.getState();
  assert.equal(finalState.play.isPlaying, false);
  assert.equal(finalState.play.lastStopReason, "panic");
  assert.equal(finalState.data.project.nodes[playOnlyNodeId], undefined);
  assert.ok(finalState.data.project.nodes[baseNodeId]);
});
