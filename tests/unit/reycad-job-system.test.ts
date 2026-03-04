import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeJobSystemLite } from "../../reycad/src/engine/runtime/jobSystemLite";

test("job system executes higher-priority jobs first", () => {
  const system = new RuntimeJobSystemLite({ maxQueueSize: 16 });
  const order: string[] = [];

  system.enqueue({
    id: "job:normal",
    subsystem: "jobs",
    priority: "normal",
    run: () => {
      order.push("normal");
    }
  });
  system.enqueue({
    id: "job:critical",
    subsystem: "prefetch",
    priority: "critical",
    run: () => {
      order.push("critical");
    }
  });
  system.enqueue({
    id: "job:high",
    subsystem: "physics",
    priority: "high",
    run: () => {
      order.push("high");
    }
  });

  const summary = system.drain(100);
  assert.equal(summary.executed, 3);
  assert.deepEqual(order, ["critical", "high", "normal"]);
});

test("job system deduplicates by id and keeps highest priority", () => {
  const system = new RuntimeJobSystemLite({ maxQueueSize: 8 });
  const output: string[] = [];

  system.enqueue({
    id: "prefetch:scene",
    subsystem: "prefetch",
    priority: "low",
    run: () => {
      output.push("first");
    }
  });
  system.enqueue({
    id: "prefetch:scene",
    subsystem: "prefetch",
    priority: "critical",
    run: () => {
      output.push("latest");
    }
  });

  const snapshot = system.getSnapshot();
  assert.equal(snapshot.queueDepth, 1);
  assert.equal(snapshot.byPriority.critical, 1);

  const summary = system.drain(100);
  assert.equal(summary.executed, 1);
  assert.deepEqual(output, ["latest"]);
});

test("job system drops low priority jobs when queue exceeds capacity", () => {
  const system = new RuntimeJobSystemLite({ maxQueueSize: 2 });
  const output: string[] = [];

  system.enqueue({
    id: "j1",
    subsystem: "jobs",
    priority: "low",
    run: () => {
      output.push("j1");
    }
  });
  system.enqueue({
    id: "j2",
    subsystem: "jobs",
    priority: "normal",
    run: () => {
      output.push("j2");
    }
  });
  system.enqueue({
    id: "j3",
    subsystem: "jobs",
    priority: "critical",
    run: () => {
      output.push("j3");
    }
  });

  const summary = system.drain(100);
  assert.equal(summary.dropped, 1);
  assert.equal(summary.executed, 2);
  assert.deepEqual(output.includes("j1"), false);
});
