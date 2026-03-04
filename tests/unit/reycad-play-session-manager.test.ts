import assert from "node:assert/strict";
import test from "node:test";
import { createProject } from "../../reycad/src/engine/scenegraph/factory";
import { PlaySessionManager } from "../../reycad/src/editor/runtime/playSessionManager";
import type { EditorData } from "../../reycad/src/editor/state/types";

function createEditorData(): EditorData {
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

test("play session start/stop toggles runtime physics and restores snapshot", () => {
  let now = 1000;
  const manager = new PlaySessionManager(60_000, () => now, () => "2026-03-03T00:00:00.000Z");
  const data = createEditorData();
  data.project.physics.enabled = false;
  data.project.physics.simulate = false;
  data.project.physics.runtimeMode = "static";

  const started = manager.start(data, 60_000);
  assert.ok(started);
  assert.equal(started.playData.project.physics.enabled, true);
  assert.equal(started.playData.project.physics.simulate, true);
  assert.equal(started.playData.project.physics.runtimeMode, "arena");
  assert.ok(started.playData.logs.some((line) => line.includes("[play] started session=")));

  now += 3450;
  const stopped = manager.stop("user_stop");
  assert.ok(stopped);
  assert.equal(stopped.elapsedMs, 3450);
  assert.equal(stopped.reason, "user_stop");
  assert.equal(stopped.restoredData.project.physics.enabled, false);
  assert.equal(stopped.restoredData.project.physics.simulate, false);
  assert.equal(stopped.restoredData.project.physics.runtimeMode, "static");
  assert.ok(stopped.restoredData.logs.some((line) => line.includes("[play] stopped reason=user_stop")));
});

test("play session enforces single active session and blocked-command accounting", () => {
  const manager = new PlaySessionManager();
  const data = createEditorData();

  const first = manager.start(data);
  assert.ok(first);
  const second = manager.start(data);
  assert.equal(second, null);

  assert.equal(manager.incrementBlockedCommands(), 1);
  assert.equal(manager.incrementBlockedCommands(), 2);
  const tick = manager.tick();
  assert.equal(tick.shouldAutoStop, false);

  const stop = manager.stop("panic");
  assert.ok(stop);
  assert.equal(stop.blockedCommands, 2);
});

test("play session tick auto-stops when max duration is reached", () => {
  let now = 50;
  const manager = new PlaySessionManager(10_000, () => now);
  const data = createEditorData();
  const started = manager.start(data, 12_000);
  assert.ok(started);

  now += 11_999;
  const beforeLimit = manager.tick();
  assert.equal(beforeLimit.shouldAutoStop, false);

  now += 1;
  const atLimit = manager.tick();
  assert.equal(atLimit.shouldAutoStop, true);
});

test("hard reset restores play world from immutable snapshot without ending session", () => {
  const manager = new PlaySessionManager();
  const data = createEditorData();

  const started = manager.start(data);
  assert.ok(started);
  started.playData.project.grid.size = 777;

  const hardReset = manager.hardResetScene();
  assert.ok(hardReset);
  assert.equal(hardReset.project.grid.size, data.project.grid.size);
  assert.equal(hardReset.project.physics.simulate, true);
  assert.equal(hardReset.project.physics.runtimeMode, "arena");

  const state = manager.getState();
  assert.equal(state.isPlaying, true);
});
