import assert from "node:assert/strict";
import test from "node:test";
import { createPrimitiveNode, createProject } from "../../reycad/src/engine/scenegraph/factory";
import { buildGeometryFromPrimitive } from "../../reycad/src/engine/rendering/geometry";
import type { RenderPrimitive } from "../../reycad/src/engine/scenegraph/evaluator";
import { Engine } from "../../reycad/src/engine-core/core/Engine";
import { BaseSystem, type EngineUpdateContext } from "../../reycad/src/engine-core/core/System";
import { QualityManager } from "../../reycad/src/engine-core/performance/QualityManager";
import { PhysicsWorld } from "../../reycad/src/engine-core/physics/PhysicsWorld";
import { PhysicsSystem } from "../../reycad/src/engine-core/physics/PhysicsSystem";
import type { ColliderComponent, RigidBodyComponent, TransformComponent } from "../../reycad/src/engine-core/core/Component";
import { physicsRuntime } from "../../reycad/src/engine/runtime/physicsRuntime";

test("Engine updates systems in stage order", () => {
  const engine = new Engine();
  const order: string[] = [];

  class MockSystem extends BaseSystem {
    private readonly label: string;

    constructor(label: string, stage: "input" | "script" | "physics" | "animation" | "render", priority: number) {
      super(label, stage, priority);
      this.label = label;
    }

    update(): void {
      order.push(this.label);
    }
  }

  engine.addSystem(new MockSystem("render", "render", 0));
  engine.addSystem(new MockSystem("script", "script", 0));
  engine.addSystem(new MockSystem("input", "input", 0));
  engine.addSystem(new MockSystem("physics", "physics", 0));
  engine.addSystem(new MockSystem("animation", "animation", 0));
  engine.update(1 / 60);

  assert.deepEqual(order, ["input", "script", "physics", "animation", "render"]);
});

test("Engine filters system entities by required components and records metrics", () => {
  const engine = new Engine();
  const plain = engine.createEntity();
  const dynamic = engine.createEntity();

  dynamic.addComponent({
    type: "RigidBody",
    enabled: true,
    mode: "dynamic",
    mass: 1,
    gravityScale: 1,
    lockRotation: true
  });

  const seen: string[] = [];
  class FilteredSystem extends BaseSystem {
    constructor() {
      super("filtered.system", "script", 0, ["RigidBody"]);
    }

    update(context: EngineUpdateContext): void {
      for (const entity of context.entities) {
        seen.push(entity.id);
      }
    }
  }

  engine.addSystem(new FilteredSystem());
  engine.update(1 / 60);

  assert.deepEqual(seen, [dynamic.id]);
  assert.notEqual(plain.id, dynamic.id);

  const metrics = engine.getSystemMetrics();
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].systemId, "filtered.system");
  assert.equal(metrics[0].ticks, 1);
  assert.ok(metrics[0].totalDurationMs >= 0);
});

test("QualityManager auto mode degrades quality when fps is low", () => {
  const manager = new QualityManager({
    minSampleCount: 4,
    transitionCooldownMs: 0
  });
  manager.setMode("auto");

  for (let index = 0; index < 12; index += 1) {
    manager.observeFrame(50);
  }

  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.mode, "auto");
  assert.equal(snapshot.effectiveLevel, "low");
});

test("QualityManager auto mode degrades one step on critical budget alert", () => {
  const manager = new QualityManager({
    minSampleCount: 4,
    transitionCooldownMs: 0,
    budgetTransitionCooldownMs: 0
  });
  manager.setMode("auto");
  assert.equal(manager.getSnapshot().effectiveLevel, "ultra");

  manager.observeBudgetAlert("critical");
  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.effectiveLevel, "high");
  assert.equal(snapshot.metrics.reason, "auto:budget:critical");
});

test("QualityManager requires warn streak before budget downgrade", () => {
  const manager = new QualityManager({
    minSampleCount: 4,
    transitionCooldownMs: 0,
    budgetTransitionCooldownMs: 0,
    budgetWarnSampleCount: 3
  });
  manager.setMode("auto");
  assert.equal(manager.getSnapshot().effectiveLevel, "ultra");

  manager.observeBudgetAlert("warn");
  manager.observeBudgetAlert("warn");
  assert.equal(manager.getSnapshot().effectiveLevel, "ultra");

  manager.observeBudgetAlert("warn");
  assert.equal(manager.getSnapshot().effectiveLevel, "high");
  assert.equal(manager.getSnapshot().metrics.reason, "auto:budget:warn");
});

test("QualityManager ignores budget alerts in manual mode", () => {
  const manager = new QualityManager({
    transitionCooldownMs: 0,
    budgetTransitionCooldownMs: 0
  });
  manager.setMode("ultra");
  manager.observeBudgetAlert("critical");

  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.mode, "ultra");
  assert.equal(snapshot.effectiveLevel, "ultra");
  assert.equal(snapshot.metrics.reason, "manual:ultra");
});

test("Terrain primitive builds displaced geometry", () => {
  const terrain = createPrimitiveNode("terrain");
  const renderPrimitive: RenderPrimitive = {
    nodeId: terrain.id,
    primitive: "terrain",
    params: terrain.params,
    materialId: undefined,
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1]
    },
    mode: "solid"
  };

  const geometry = buildGeometryFromPrimitive(renderPrimitive);
  const position = geometry.attributes.position;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < position.count; index += 1) {
    const y = position.getY(index);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  assert.ok(position.count > 100, "expected dense terrain vertex count");
  assert.ok(maxY - minY > 0.1, "terrain should contain elevation variance");
});

test("PhysicsSystem applies gravity in lite backend", () => {
  const engine = new Engine();
  const physics = new PhysicsSystem({
    backend: "lite",
    gravity: [0, -9.81, 0],
    floorY: -1000
  });
  engine.addSystem(physics);

  const entity = engine.createEntity();
  const transform = entity.getComponent<TransformComponent>("Transform");
  assert.ok(transform);
  transform.position = [0, 10, 0];

  entity.addComponent({
    type: "RigidBody",
    enabled: true,
    mode: "dynamic",
    mass: 1,
    gravityScale: 1,
    lockRotation: true
  });

  engine.update(0.5);
  assert.ok(transform.position[1] < 10, "expected body to move down due gravity");
});

test("PhysicsSystem floor collision clamps body above floor", () => {
  const engine = new Engine();
  const physics = new PhysicsSystem({
    backend: "lite",
    gravity: [0, -9.81, 0],
    floorY: 0
  });
  engine.addSystem(physics);

  const entity = engine.createEntity();
  const transform = entity.getComponent<TransformComponent>("Transform");
  assert.ok(transform);
  transform.position = [0, 0.1, 0];

  entity.addComponent({
    type: "RigidBody",
    enabled: true,
    mode: "dynamic",
    mass: 1,
    gravityScale: 1,
    lockRotation: true
  });

  entity.addComponent({
    type: "Collider",
    enabled: true,
    shape: "box",
    isTrigger: false,
    size: [1, 1, 1]
  });

  engine.update(0.5);
  assert.ok(transform.position[1] >= 0.5, "expected collider to remain over floor");
});

test("PhysicsSystem substeps large deltas for stable integration", () => {
  const createSetup = (maxSubSteps: number) => {
    const engine = new Engine();
    const physics = new PhysicsSystem({
      backend: "lite",
      gravity: [0, -9.81, 0],
      floorY: -1000,
      fixedTimeStep: 1 / 60,
      maxSubSteps
    });
    engine.addSystem(physics);

    const entity = engine.createEntity();
    const transform = entity.getComponent<TransformComponent>("Transform");
    assert.ok(transform);
    transform.position = [0, 10, 0];

    entity.addComponent({
      type: "RigidBody",
      enabled: true,
      mode: "dynamic",
      mass: 1,
      gravityScale: 1,
      lockRotation: true,
      linearVelocity: [0, 0, 0]
    });

    return { engine, transform };
  };

  const noSubSteps = createSetup(1);
  const withSubSteps = createSetup(8);
  const reference = createSetup(32);

  noSubSteps.engine.update(0.4);
  withSubSteps.engine.update(0.4);
  reference.engine.update(0.4);

  const errorWithoutSubSteps = Math.abs(noSubSteps.transform.position[1] - reference.transform.position[1]);
  const errorWithSubSteps = Math.abs(withSubSteps.transform.position[1] - reference.transform.position[1]);
  assert.ok(
    errorWithSubSteps < errorWithoutSubSteps,
    `expected substeps to improve stability (with=${errorWithSubSteps}, without=${errorWithoutSubSteps})`
  );
});

test("PhysicsWorld emits exit contact events when overlap ends", () => {
  const world = new PhysicsWorld({
    backend: "lite",
    gravity: [0, 0, 0],
    floorY: -1000
  });

  const baseCollider: ColliderComponent = {
    type: "Collider",
    enabled: true,
    shape: "box",
    isTrigger: false,
    size: [1, 1, 1]
  };

  const transformA: TransformComponent = {
    type: "Transform",
    enabled: true,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
  };
  const transformB: TransformComponent = {
    type: "Transform",
    enabled: true,
    position: [0.25, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
  };

  world.upsertCollider("a", transformA, baseCollider);
  world.upsertCollider("b", transformB, baseCollider);
  world.step(1 / 60);
  const first = world.drainContactEvents();
  assert.ok(first.some((event) => event.type === "enter"), "expected enter event");

  const transformBFar: TransformComponent = {
    ...transformB,
    position: [10, 0, 0]
  };
  world.upsertCollider("b", transformBFar, baseCollider);
  world.step(1 / 60);
  const second = world.drainContactEvents();
  assert.ok(second.some((event) => event.type === "exit"), "expected exit event");
});

test("PhysicsWorld broadphase keeps overlap detection across multiple cells", () => {
  const world = new PhysicsWorld({
    backend: "lite",
    gravity: [0, 0, 0],
    floorY: -1000,
    broadphaseCellSize: 1
  });

  const big: ColliderComponent = {
    type: "Collider",
    enabled: true,
    shape: "box",
    isTrigger: false,
    size: [4, 4, 4]
  };
  const small: ColliderComponent = {
    type: "Collider",
    enabled: true,
    shape: "box",
    isTrigger: false,
    size: [1, 1, 1]
  };

  world.upsertCollider("big", {
    type: "Transform",
    enabled: true,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
  }, big);
  world.upsertCollider("small", {
    type: "Transform",
    enabled: true,
    position: [1.5, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
  }, small);

  world.step(1 / 60);
  const events = world.drainContactEvents();
  assert.ok(events.some((event) => event.type === "enter"), "expected broadphase overlap enter event");
});

test("PhysicsWorld distance constraints enforce target spacing", () => {
  const world = new PhysicsWorld({
    backend: "lite",
    gravity: [0, 0, 0],
    floorY: -1000
  });

  const rigidBody: RigidBodyComponent = {
    type: "RigidBody",
    enabled: true,
    mode: "dynamic",
    mass: 1,
    gravityScale: 1,
    lockRotation: true,
    linearVelocity: [0, 0, 0]
  };

  const transformA: TransformComponent = {
    type: "Transform",
    enabled: true,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
  };
  const transformB: TransformComponent = {
    type: "Transform",
    enabled: true,
    position: [20, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
  };

  world.upsertRigidBody("a", transformA, rigidBody);
  world.upsertRigidBody("b", transformB, rigidBody);
  world.syncConstraints([
    {
      id: "constraint_test",
      type: "distance",
      a: "a",
      b: "b",
      restLength: 10,
      stiffness: 1,
      damping: 0,
      enabled: true
    }
  ]);

  world.step(1 / 60);

  const posA = world.getBodyPosition("a");
  const posB = world.getBodyPosition("b");
  assert.ok(posA && posB);
  const dx = posB[0] - posA[0];
  const dy = posB[1] - posA[1];
  const dz = posB[2] - posA[2];
  const distance = Math.hypot(dx, dy, dz);
  assert.ok(Math.abs(distance - 10) < 0.05, `expected distance near 10, got ${distance}`);
});

test("PhysicsWorld applyImpulse affects only dynamic rigidbodies", () => {
  const world = new PhysicsWorld({
    backend: "lite",
    gravity: [0, 0, 0],
    floorY: -1000
  });

  const transformDynamic: TransformComponent = {
    type: "Transform",
    enabled: true,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
  };
  const transformFixed: TransformComponent = {
    type: "Transform",
    enabled: true,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
  };

  world.upsertRigidBody("dynamic_box", transformDynamic, {
    type: "RigidBody",
    enabled: true,
    mode: "dynamic",
    mass: 2,
    gravityScale: 1,
    lockRotation: true,
    linearVelocity: [0, 0, 0]
  });
  world.upsertRigidBody("fixed_box", transformFixed, {
    type: "RigidBody",
    enabled: true,
    mode: "fixed",
    mass: 1,
    gravityScale: 1,
    lockRotation: true,
    linearVelocity: [0, 0, 0]
  });

  assert.equal(world.applyImpulse("dynamic_box", [0, 10, 0]), true);
  assert.equal(world.applyImpulse("fixed_box", [0, 10, 0]), false);

  world.step(1);
  const dynamicPos = world.getBodyPosition("dynamic_box");
  const fixedPos = world.getBodyPosition("fixed_box");
  assert.ok(dynamicPos);
  assert.ok(fixedPos);
  assert.ok(dynamicPos[1] > 4.9, `expected dynamic body to move up after impulse, got ${dynamicPos[1]}`);
  assert.ok(Math.abs(fixedPos[1]) < 0.001, `expected fixed body to stay in place, got ${fixedPos[1]}`);
});

test("physicsRuntime runs only in arena mode and blocks impulse in static mode", () => {
  const project = createProject();
  const node = createPrimitiveNode("box");
  node.parentId = project.rootId;
  node.transform.position = [0, 10, 0];
  node.rigidBody = {
    enabled: true,
    mode: "dynamic",
    mass: 1,
    gravityScale: 1,
    lockRotation: true,
    linearVelocity: [0, 0, 0]
  };
  node.collider = {
    enabled: true,
    shape: "box",
    isTrigger: false,
    size: [1, 1, 1]
  };
  project.nodes[node.id] = node;

  const root = project.nodes[project.rootId];
  if (root && root.type === "group") {
    root.children.push(node.id);
  }

  project.physics.enabled = true;
  project.physics.simulate = true;
  project.physics.runtimeMode = "static";
  project.physics.gravity = [0, -9.81, 0];
  project.physics.floorY = -1000;
  physicsRuntime.clearEvents();

  const impulseBlocked = physicsRuntime.applyImpulse(project, node.id, [0, 8, 0]);
  assert.equal(impulseBlocked, false);

  physicsRuntime.step(project, 0.5, {
    onUpdateTransform: (nodeId, transform) => {
      const target = project.nodes[nodeId];
      if (target) {
        target.transform = transform;
      }
    }
  });
  const afterStatic = project.nodes[node.id].transform.position[1];
  assert.equal(afterStatic, 10);

  project.physics.runtimeMode = "arena";
  const impulseApplied = physicsRuntime.applyImpulse(project, node.id, [0, 8, 0]);
  assert.equal(impulseApplied, true);
  physicsRuntime.step(project, 0.5, {
    onUpdateTransform: (nodeId, transform) => {
      const target = project.nodes[nodeId];
      if (target) {
        target.transform = transform;
      }
    }
  });
  const afterArena = project.nodes[node.id].transform.position[1];
  assert.ok(afterArena > 10, `expected upward movement in arena mode, got ${afterArena}`);
});
