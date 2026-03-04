import assert from "node:assert/strict";
import test from "node:test";
import { FrameBudgetScheduler } from "../../reycad/src/engine/runtime/frameBudgetScheduler";

test("frame budget scheduler reserves and tracks subsystem usage", () => {
  const scheduler = new FrameBudgetScheduler();
  scheduler.beginFrame(16, 1);

  const reserve = scheduler.reserve("jobs", 0.5);
  assert.equal(reserve.granted, true);
  assert.ok(reserve.allowanceMs > 0);

  scheduler.recordUsage("physics", 2.4);
  scheduler.recordUsage("jobs", 0.9);
  scheduler.recordUsage("misc", 0.4);

  const snapshot = scheduler.getSnapshot();
  assert.equal(snapshot.frameBudgetMs, 16);
  assert.ok(snapshot.frameUsedMs >= 3.7);
  assert.equal(snapshot.subsystems.physics.usedMs, 2.4);
  assert.equal(snapshot.subsystems.jobs.usedMs, 0.9);
});

test("frame budget scheduler marks deferred when reservation exceeds allowance", () => {
  const scheduler = new FrameBudgetScheduler({
    weights: {
      jobs: 0.05,
      physics: 0.45,
      culling: 0.3,
      prefetch: 0.1,
      misc: 0.1
    }
  });
  scheduler.beginFrame(10, 1);
  const first = scheduler.reserve("jobs", 2);
  assert.equal(first.granted, false);
  const snapshot = scheduler.getSnapshot();
  assert.equal(snapshot.subsystems.jobs.deferred, 1);
});

test("frame budget scheduler tightens opportunistic budgets under gpu pressure", () => {
  const scheduler = new FrameBudgetScheduler();
  scheduler.beginFrame(16, 0.8);
  const relaxed = scheduler.getSnapshot();

  scheduler.beginFrame(16, 1.8);
  const constrained = scheduler.getSnapshot();

  assert.ok(constrained.subsystems.prefetch.budgetMs < relaxed.subsystems.prefetch.budgetMs);
  assert.ok(constrained.subsystems.jobs.budgetMs < relaxed.subsystems.jobs.budgetMs);
});
