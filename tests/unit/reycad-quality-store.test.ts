import assert from "node:assert/strict";
import test from "node:test";
import { QualityManager } from "../../reycad/src/engine-core/performance/QualityManager";
import { createQualityStore, type RenderStatsInput } from "../../reycad/src/engine/runtime/qualityStore";

function createRenderStats(alert: "ok" | "warn" | "critical"): RenderStatsInput {
  return {
    drawCalls: 520,
    triangles: 920000,
    budgetDrawCallsTarget: 480,
    budgetTrianglesTarget: 860000,
    budgetDrawCallUsage: 1.0833,
    budgetTriangleUsage: 1.0698,
    budgetAlert: alert,
    lines: 0,
    points: 0,
    visibleMeshes: 160,
    culledMeshes: 18,
    instancedGroups: 5,
    staticBatchGroups: 2,
    staticBatchMeshes: 48,
    lodHigh: 62,
    lodMedium: 70,
    lodLow: 28,
    sceneProfile: "outdoor",
    sceneRadius: 440,
    sceneNodeCount: 180,
    instancingThreshold: 4,
    cullMargin: 1.34,
    lodNearDistance: 58,
    lodMidDistance: 176,
    cpuFrameBudgetMs: 16.2,
    cpuFrameUsedMs: 8.4,
    cpuFrameRemainingMs: 7.8,
    cpuPressure: 0.519,
    gpuPressure: 1.08,
    jobQueueDepth: 2,
    jobsExecuted: 3,
    jobsDeferred: 2,
    jobsDropped: 0,
    physicsBudgetMs: 4.8,
    physicsUsedMs: 1.7,
    physicsDeferred: 0,
    cullingBudgetMs: 4.2,
    cullingUsedMs: 2.3,
    cullingDeferred: 0,
    prefetchBudgetMs: 1.3,
    prefetchUsedMs: 0.4,
    prefetchDeferred: 0,
    jobSystemBudgetMs: 3.1,
    jobSystemUsedMs: 1.2,
    jobSystemDeferred: 1,
    miscBudgetMs: 1.1,
    miscUsedMs: 0.6,
    miscDeferred: 0
  };
}

test("qualityStore applies critical budget alert downgrade in auto mode", () => {
  const manager = new QualityManager({
    transitionCooldownMs: 0,
    budgetTransitionCooldownMs: 0
  });
  const store = createQualityStore(manager);
  store.getState().setMode("auto");
  assert.equal(store.getState().effectiveLevel, "ultra");

  store.getState().setRenderStats(createRenderStats("critical"));
  assert.equal(store.getState().effectiveLevel, "high");
  assert.equal(store.getState().reason, "auto:budget:critical");
});

test("qualityStore requires warn streak before applying budget downgrade", () => {
  const manager = new QualityManager({
    transitionCooldownMs: 0,
    budgetTransitionCooldownMs: 0,
    budgetWarnSampleCount: 3
  });
  const store = createQualityStore(manager);
  store.getState().setMode("auto");

  store.getState().setRenderStats(createRenderStats("warn"));
  store.getState().setRenderStats(createRenderStats("warn"));
  assert.equal(store.getState().effectiveLevel, "ultra");

  store.getState().setRenderStats(createRenderStats("warn"));
  assert.equal(store.getState().effectiveLevel, "high");
  assert.equal(store.getState().reason, "auto:budget:warn");
});

test("qualityStore ignores budget alerts in manual mode", () => {
  const manager = new QualityManager({
    transitionCooldownMs: 0,
    budgetTransitionCooldownMs: 0
  });
  const store = createQualityStore(manager);
  store.getState().setMode("ultra");

  store.getState().setRenderStats(createRenderStats("critical"));
  assert.equal(store.getState().mode, "ultra");
  assert.equal(store.getState().effectiveLevel, "ultra");
  assert.equal(store.getState().reason, "manual:ultra");
});
