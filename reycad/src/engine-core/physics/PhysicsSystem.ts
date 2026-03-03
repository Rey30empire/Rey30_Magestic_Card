import type { ColliderComponent, RigidBodyComponent, TransformComponent } from "../core/Component";
import { BaseSystem, type EngineUpdateContext } from "../core/System";
import { PhysicsWorld, type PhysicsWorldOptions } from "./PhysicsWorld";

function transformOf(entity: EngineUpdateContext["entities"][number]): TransformComponent | null {
  return entity.getComponent<TransformComponent>("Transform") ?? null;
}

function rigidBodyOf(entity: EngineUpdateContext["entities"][number]): RigidBodyComponent | null {
  return entity.getComponent<RigidBodyComponent>("RigidBody") ?? null;
}

function colliderOf(entity: EngineUpdateContext["entities"][number]): ColliderComponent | null {
  return entity.getComponent<ColliderComponent>("Collider") ?? null;
}

export type PhysicsSystemOptions = PhysicsWorldOptions & {
  fixedTimeStep?: number;
  maxSubSteps?: number;
};

export class PhysicsSystem extends BaseSystem {
  private readonly world: PhysicsWorld;
  private readonly fixedTimeStep: number;
  private readonly maxSubSteps: number;
  private initialized = false;
  private initializeInFlight = false;

  constructor(options: PhysicsSystemOptions = {}) {
    super("physics.system", "physics", 0, ["Transform"]);
    this.world = new PhysicsWorld(options);
    const fixedTimeStep = Number.isFinite(options.fixedTimeStep) ? (options.fixedTimeStep as number) : 1 / 60;
    this.fixedTimeStep = Math.max(1 / 240, fixedTimeStep);
    const maxSubSteps = Number.isFinite(options.maxSubSteps) ? (options.maxSubSteps as number) : 8;
    this.maxSubSteps = Math.max(1, Math.floor(maxSubSteps));
  }

  getWorld(): PhysicsWorld {
    return this.world;
  }

  update(context: EngineUpdateContext): void {
    if (!this.initialized && !this.initializeInFlight) {
      this.initializeInFlight = true;
      void this.world
        .initialize()
        .then(() => {
          this.initialized = true;
        })
        .finally(() => {
          this.initializeInFlight = false;
        });
    }

    const aliveBodies = new Set<string>();
    const aliveColliders = new Set<string>();
    for (const entity of context.entities) {
      const transform = transformOf(entity);
      if (!transform) {
        continue;
      }

      const rigidBody = rigidBodyOf(entity);
      const collider = colliderOf(entity);
      if (rigidBody) {
        this.world.upsertRigidBody(entity.id, transform, rigidBody);
        aliveBodies.add(entity.id);
      } else {
        this.world.removeRigidBody(entity.id);
      }

      if (collider) {
        this.world.upsertCollider(entity.id, transform, collider);
        aliveColliders.add(entity.id);
      } else {
        this.world.removeCollider(entity.id);
      }
    }

    const subStepCount = Math.max(1, Math.min(this.maxSubSteps, Math.ceil(context.deltaTime / this.fixedTimeStep)));
    const subStepDelta = context.deltaTime / subStepCount;
    for (let stepIndex = 0; stepIndex < subStepCount; stepIndex += 1) {
      this.world.step(subStepDelta);
    }
    this.world.drainContactEvents();

    for (const entity of context.entities) {
      if (!aliveBodies.has(entity.id)) {
        this.world.removeRigidBody(entity.id);
      }
      if (!aliveColliders.has(entity.id)) {
        this.world.removeCollider(entity.id);
      }
    }
  }
}
