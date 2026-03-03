import { PhysicsWorld, type PhysicsContactEvent, type PhysicsDistanceConstraint, type PhysicsRaycastHit } from "../../engine-core/physics/PhysicsWorld";
import type { Node, NodeCollider, NodeRigidBody, Project, Transform } from "../scenegraph/types";
import type { ColliderComponent, RigidBodyComponent, TransformComponent } from "../../engine-core/core/Component";

type PhysicsRuntimeEvent = PhysicsContactEvent & {
  at: string;
};

type StepOptions = {
  onLog?: (message: string) => void;
  onUpdateTransform?: (nodeId: string, transform: Transform) => void;
};

function toRuntimeConstraints(project: Project): PhysicsDistanceConstraint[] {
  const constraints = project.physics.constraints ?? [];
  return constraints
    .filter((item) => item.type === "distance")
    .map((item) => ({
      id: item.id,
      type: "distance",
      a: item.a,
      b: item.b,
      restLength: item.restLength,
      stiffness: item.stiffness,
      damping: item.damping,
      enabled: item.enabled
    }));
}

function cloneTransform(value: Transform): Transform {
  return {
    position: [...value.position] as [number, number, number],
    rotation: [...value.rotation] as [number, number, number],
    scale: [...value.scale] as [number, number, number]
  };
}

function toTransformComponent(value: Transform): TransformComponent {
  return {
    type: "Transform",
    enabled: true,
    position: [...value.position] as [number, number, number],
    rotation: [...value.rotation] as [number, number, number],
    scale: [...value.scale] as [number, number, number]
  };
}

function toRigidBodyComponent(value: NodeRigidBody): RigidBodyComponent {
  return {
    type: "RigidBody",
    ...value
  };
}

function toColliderComponent(value: NodeCollider): ColliderComponent {
  return {
    type: "Collider",
    ...value
  };
}

function hasTransformChanged(current: Transform, nextPosition: [number, number, number], nextRotation: [number, number, number]): boolean {
  const epsilon = 0.0001;
  const posChanged =
    Math.abs(current.position[0] - nextPosition[0]) > epsilon ||
    Math.abs(current.position[1] - nextPosition[1]) > epsilon ||
    Math.abs(current.position[2] - nextPosition[2]) > epsilon;
  const rotChanged =
    Math.abs(current.rotation[0] - nextRotation[0]) > epsilon ||
    Math.abs(current.rotation[1] - nextRotation[1]) > epsilon ||
    Math.abs(current.rotation[2] - nextRotation[2]) > epsilon;
  return posChanged || rotChanged;
}

class PhysicsRuntime {
  private world: PhysicsWorld | null = null;
  private worldKey = "";
  private initLogSent = false;
  private readonly recentEvents: PhysicsRuntimeEvent[] = [];
  private readonly pendingEvents: PhysicsRuntimeEvent[] = [];
  private readonly trackedNodeIds = new Set<string>();

  private ensureWorld(project: Project, options?: Pick<StepOptions, "onLog">): void {
    const settings = project.physics;
    const worldKey = `${settings.backend}:${settings.gravity.join(",")}:${settings.floorY}`;
    if (this.world && this.worldKey === worldKey) {
      return;
    }

    this.world = new PhysicsWorld({
      backend: settings.backend,
      gravity: settings.gravity,
      floorY: settings.floorY
    });
    this.worldKey = worldKey;
    this.initLogSent = false;
    this.trackedNodeIds.clear();
    void this.world
      .initialize()
      .then(() => {
        if (!this.world || this.initLogSent) {
          return;
        }
        this.initLogSent = true;
        options?.onLog?.(`[physics] ready backend=${this.world.getBackend()}`);
      })
      .catch((error) => {
        options?.onLog?.(`[physics] init failed ${String(error)}`);
      });
  }

  private syncWorldState(project: Project, world: PhysicsWorld): void {
    const currentTracked = new Set<string>();
    for (const node of Object.values(project.nodes)) {
      if (node.id === project.rootId || node.type === "import") {
        continue;
      }

      const hasRigidBody = Boolean(node.rigidBody?.enabled);
      const hasCollider = Boolean(node.collider?.enabled);
      if (!hasRigidBody && !hasCollider) {
        world.removeRigidBody(node.id);
        world.removeCollider(node.id);
        continue;
      }

      currentTracked.add(node.id);
      const transform = cloneTransform(node.transform);
      const runtimeTransform = toTransformComponent(transform);
      if (hasRigidBody && node.rigidBody) {
        world.upsertRigidBody(node.id, runtimeTransform, toRigidBodyComponent(node.rigidBody));
      } else {
        world.removeRigidBody(node.id);
      }

      if (hasCollider && node.collider) {
        world.upsertCollider(node.id, runtimeTransform, toColliderComponent(node.collider));
      } else {
        world.removeCollider(node.id);
      }
    }

    for (const nodeId of this.trackedNodeIds) {
      if (currentTracked.has(nodeId)) {
        continue;
      }
      world.removeRigidBody(nodeId);
      world.removeCollider(nodeId);
    }
    this.trackedNodeIds.clear();
    for (const nodeId of currentTracked) {
      this.trackedNodeIds.add(nodeId);
    }

    world.syncConstraints(toRuntimeConstraints(project));
  }

  step(project: Project, delta: number, options?: StepOptions): void {
    if (!project.physics.enabled || !project.physics.simulate || project.physics.runtimeMode !== "arena") {
      return;
    }

    this.ensureWorld(project, { onLog: options?.onLog });
    const world = this.world;
    if (!world) {
      return;
    }

    this.syncWorldState(project, world);
    world.step(delta);
    const events = world.drainContactEvents();
    if (events.length > 0) {
      const at = new Date().toISOString();
      for (const event of events) {
        const withTimestamp: PhysicsRuntimeEvent = {
          ...event,
          at
        };
        this.recentEvents.push(withTimestamp);
        this.pendingEvents.push(withTimestamp);
      }
      if (this.recentEvents.length > 200) {
        this.recentEvents.splice(0, this.recentEvents.length - 200);
      }
      if (this.pendingEvents.length > 200) {
        this.pendingEvents.splice(0, this.pendingEvents.length - 200);
      }
    }

    if (!options?.onUpdateTransform) {
      return;
    }

    for (const node of Object.values(project.nodes)) {
      if (node.id === project.rootId || node.type === "import" || !node.rigidBody?.enabled) {
        continue;
      }

      const position = world.getBodyPosition(node.id);
      if (!position) {
        continue;
      }
      const worldRotation = world.getBodyRotation(node.id) ?? node.transform.rotation;
      const rotation = node.rigidBody.lockRotation ? node.transform.rotation : worldRotation;
      if (!hasTransformChanged(node.transform, position, rotation)) {
        continue;
      }
      options.onUpdateTransform(node.id, {
        position,
        rotation,
        scale: node.transform.scale
      });
    }
  }

  applyImpulse(project: Project, nodeId: string, impulse: [number, number, number], options?: Pick<StepOptions, "onLog">): boolean {
    if (!project.physics.enabled || !project.physics.simulate || project.physics.runtimeMode !== "arena") {
      return false;
    }

    this.ensureWorld(project, { onLog: options?.onLog });
    const world = this.world;
    if (!world) {
      return false;
    }

    this.syncWorldState(project, world);
    const applied = world.applyImpulse(nodeId, impulse);
    if (applied) {
      options?.onLog?.(`[physics] impulse ${nodeId} i=${impulse.map((value) => value.toFixed(2)).join(",")}`);
    }
    return applied;
  }

  getRecentEvents(limit = 50): PhysicsRuntimeEvent[] {
    const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.recentEvents.slice(-bounded).map((item) => ({ ...item }));
  }

  clearEvents(): void {
    this.recentEvents.length = 0;
    this.pendingEvents.length = 0;
  }

  drainStepEvents(): PhysicsRuntimeEvent[] {
    if (this.pendingEvents.length === 0) {
      return [];
    }
    const copy = this.pendingEvents.map((item) => ({ ...item }));
    this.pendingEvents.length = 0;
    return copy;
  }

  raycast(project: Project, origin: [number, number, number], direction: [number, number, number], maxDistance = 1000): PhysicsRaycastHit | null {
    this.ensureWorld(project);
    const world = this.world;
    if (!world) {
      return null;
    }
    return world.raycast(origin, direction, maxDistance);
  }
}

export const physicsRuntime = new PhysicsRuntime();
