import type { ColliderComponent, RigidBodyComponent, TransformComponent, Vec3 } from "../core/Component";
import { aabbCenter, aabbIntersects, computeColliderAabb, createColliderState, type Aabb, type ColliderState } from "./Collider";
import { createPhysicsBodyState, type PhysicsBodyState } from "./RigidBody";

export type PhysicsBackendMode = "auto" | "lite" | "rapier";
export type PhysicsBackend = "lite" | "rapier";

export type PhysicsWorldOptions = {
  backend?: PhysicsBackendMode;
  gravity?: Vec3;
  floorY?: number;
  broadphaseCellSize?: number;
};

export type PhysicsRaycastHit = {
  entityId: string;
  distance: number;
  point: Vec3;
};

export type PhysicsContactEvent = {
  a: string;
  b: string;
  type: "enter" | "stay" | "exit";
  point: Vec3;
};

export type PhysicsDistanceConstraint = {
  id: string;
  type: "distance";
  a: string;
  b: string;
  restLength: number;
  stiffness: number;
  damping: number;
  enabled: boolean;
};

type RapierHandle = {
  module: unknown;
  world: unknown;
};

type RapierModule = {
  default?: { init?: () => Promise<void> };
  init?: () => Promise<void>;
  World?: new (gravity: { x: number; y: number; z: number }) => unknown;
};

function cloneVec3(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

function keyPair(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function splitPair(pair: string): [string, string] {
  const separator = pair.indexOf("|");
  if (separator < 0) {
    return [pair, pair];
  }
  return [pair.slice(0, separator), pair.slice(separator + 1)];
}

function cellCoord(value: number, cellSize: number): number {
  return Math.floor(value / cellSize);
}

function cellKey(x: number, y: number, z: number): string {
  return `${x}|${y}|${z}`;
}

function directionNormalize(direction: Vec3): Vec3 {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length <= 0.000001) {
    return [0, -1, 0];
  }
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

function vecSubtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vecLength(value: Vec3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function vecScale(value: Vec3, scalar: number): Vec3 {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

function vecDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

async function importRapierModule(): Promise<RapierModule> {
  const importer = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<unknown>;
  return (await importer("@dimforge/rapier3d-compat")) as RapierModule;
}

function rayIntersectsAabb(origin: Vec3, direction: Vec3, aabb: Aabb, maxDistance: number): number | null {
  const dir = directionNormalize(direction);
  let tMin = 0;
  let tMax = maxDistance;

  for (let axis = 0; axis < 3; axis += 1) {
    const originAxis = origin[axis];
    const dirAxis = dir[axis];
    const minAxis = aabb.min[axis];
    const maxAxis = aabb.max[axis];

    if (Math.abs(dirAxis) < 0.000001) {
      if (originAxis < minAxis || originAxis > maxAxis) {
        return null;
      }
      continue;
    }

    const inv = 1 / dirAxis;
    let t1 = (minAxis - originAxis) * inv;
    let t2 = (maxAxis - originAxis) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) {
      return null;
    }
  }

  return tMin >= 0 && tMin <= maxDistance ? tMin : null;
}

export class PhysicsWorld {
  private readonly desiredBackend: PhysicsBackendMode;
  private backend: PhysicsBackend = "lite";
  private readonly gravity: Vec3;
  private readonly floorY: number;
  private readonly broadphaseCellSize: number;
  private rapier: RapierHandle | null = null;
  private initializePromise: Promise<void> | null = null;

  private readonly bodies = new Map<string, PhysicsBodyState>();
  private readonly colliders = new Map<string, ColliderState>();
  private readonly transforms = new Map<string, TransformComponent>();
  private readonly constraints = new Map<string, PhysicsDistanceConstraint>();
  private readonly events: PhysicsContactEvent[] = [];
  private previousContacts = new Set<string>();
  private previousContactPoints = new Map<string, Vec3>();

  constructor(options: PhysicsWorldOptions = {}) {
    this.desiredBackend = options.backend ?? "auto";
    this.gravity = cloneVec3(options.gravity ?? [0, -9.81, 0]);
    this.floorY = Number.isFinite(options.floorY) ? (options.floorY as number) : 0;
    const cellSize = Number.isFinite(options.broadphaseCellSize) ? (options.broadphaseCellSize as number) : 4;
    this.broadphaseCellSize = Math.max(0.25, cellSize);
  }

  async initialize(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = (async () => {
      if (this.desiredBackend === "lite") {
        this.backend = "lite";
        return;
      }

      try {
        const module = await importRapierModule();
        const init = module.init ?? module.default?.init;
        if (init) {
          await init();
        }

        const WorldCtor = module.World;
        if (!WorldCtor) {
          throw new Error("Rapier World constructor not found");
        }

        const world = new WorldCtor({
          x: this.gravity[0],
          y: this.gravity[1],
          z: this.gravity[2]
        });

        this.rapier = {
          module,
          world
        };
        this.backend = "rapier";
      } catch {
        this.rapier = null;
        this.backend = "lite";
      }
    })();

    return this.initializePromise;
  }

  getBackend(): PhysicsBackend {
    return this.backend;
  }

  getGravity(): Vec3 {
    return cloneVec3(this.gravity);
  }

  upsertRigidBody(entityId: string, transform: TransformComponent, component: RigidBodyComponent): void {
    if (!component.enabled) {
      this.removeRigidBody(entityId);
      return;
    }

    this.transforms.set(entityId, transform);
    const current = this.bodies.get(entityId);
    const next = createPhysicsBodyState(entityId, transform, component);
    if (!current) {
      this.bodies.set(entityId, next);
      return;
    }

    const previousDescriptor = current.descriptor;
    current.descriptor = next.descriptor;
    current.rotation = cloneVec3(transform.rotation);
    if (component.linearVelocity) {
      const epsilon = 0.000001;
      const hasAuthorVelocityChange =
        Math.abs(component.linearVelocity[0] - previousDescriptor.linearVelocity[0]) > epsilon ||
        Math.abs(component.linearVelocity[1] - previousDescriptor.linearVelocity[1]) > epsilon ||
        Math.abs(component.linearVelocity[2] - previousDescriptor.linearVelocity[2]) > epsilon;
      if (hasAuthorVelocityChange) {
        current.velocity = cloneVec3(component.linearVelocity);
      }
    }
    if (current.descriptor.mode !== "dynamic") {
      current.position = cloneVec3(transform.position);
    }
  }

  removeRigidBody(entityId: string): void {
    this.bodies.delete(entityId);
    if (!this.colliders.has(entityId)) {
      this.transforms.delete(entityId);
    }
  }

  upsertCollider(entityId: string, transform: TransformComponent, component: ColliderComponent): void {
    if (!component.enabled) {
      this.removeCollider(entityId);
      return;
    }
    this.transforms.set(entityId, transform);
    const state = createColliderState(entityId, component);
    this.colliders.set(entityId, state);
  }

  removeCollider(entityId: string): void {
    this.colliders.delete(entityId);
    if (!this.bodies.has(entityId)) {
      this.transforms.delete(entityId);
    }
  }

  syncConstraints(constraints: PhysicsDistanceConstraint[]): void {
    const active = new Set<string>();
    for (const constraint of constraints) {
      if (!constraint || constraint.type !== "distance") {
        continue;
      }
      if (!constraint.enabled) {
        continue;
      }
      if (!this.bodies.has(constraint.a) || !this.bodies.has(constraint.b)) {
        continue;
      }
      const normalized: PhysicsDistanceConstraint = {
        ...constraint,
        type: "distance",
        restLength: Number.isFinite(constraint.restLength) ? Math.max(0.001, constraint.restLength) : 1,
        stiffness: Number.isFinite(constraint.stiffness) ? Math.max(0, Math.min(1, constraint.stiffness)) : 0.6,
        damping: Number.isFinite(constraint.damping) ? Math.max(0, Math.min(1, constraint.damping)) : 0.1
      };
      this.constraints.set(normalized.id, normalized);
      active.add(normalized.id);
    }

    for (const id of [...this.constraints.keys()]) {
      if (!active.has(id)) {
        this.constraints.delete(id);
      }
    }
  }

  step(deltaTime: number): void {
    if (!Number.isFinite(deltaTime) || deltaTime <= 0) {
      return;
    }

    if (this.backend === "rapier") {
      // Reserved for Rapier stepping. For now we keep runtime deterministic with lite updates.
      this.stepLite(deltaTime);
      return;
    }

    this.stepLite(deltaTime);
  }

  getBodyPosition(entityId: string): Vec3 | null {
    const body = this.bodies.get(entityId);
    if (!body) {
      return null;
    }
    return cloneVec3(body.position);
  }

  getBodyRotation(entityId: string): Vec3 | null {
    const body = this.bodies.get(entityId);
    if (!body) {
      return null;
    }
    return cloneVec3(body.rotation);
  }

  applyImpulse(entityId: string, impulse: Vec3): boolean {
    const body = this.bodies.get(entityId);
    if (!body || body.descriptor.mode !== "dynamic") {
      return false;
    }

    const mass = body.descriptor.mass > 0 ? body.descriptor.mass : 1;
    const ix = Number.isFinite(impulse[0]) ? impulse[0] : 0;
    const iy = Number.isFinite(impulse[1]) ? impulse[1] : 0;
    const iz = Number.isFinite(impulse[2]) ? impulse[2] : 0;

    body.velocity[0] += ix / mass;
    body.velocity[1] += iy / mass;
    body.velocity[2] += iz / mass;
    return true;
  }

  drainContactEvents(): PhysicsContactEvent[] {
    const next = [...this.events];
    this.events.length = 0;
    return next;
  }

  raycast(origin: Vec3, direction: Vec3, maxDistance = 1000): PhysicsRaycastHit | null {
    let best: PhysicsRaycastHit | null = null;

    for (const [entityId, collider] of this.colliders.entries()) {
      const transform = this.transforms.get(entityId);
      if (!transform) {
        continue;
      }
      const body = this.bodies.get(entityId);
      const aabb = computeColliderAabb(collider.descriptor, transform, body?.position);
      const hitDistance = rayIntersectsAabb(origin, direction, aabb, maxDistance);
      if (hitDistance === null) {
        continue;
      }

      if (!best || hitDistance < best.distance) {
        best = {
          entityId,
          distance: hitDistance,
          point: [
            origin[0] + direction[0] * hitDistance,
            origin[1] + direction[1] * hitDistance,
            origin[2] + direction[2] * hitDistance
          ]
        };
      }
    }

    return best;
  }

  private stepLite(deltaTime: number): void {
    for (const body of this.bodies.values()) {
      if (body.descriptor.mode !== "dynamic") {
        continue;
      }

      body.velocity[0] += this.gravity[0] * body.descriptor.gravityScale * deltaTime;
      body.velocity[1] += this.gravity[1] * body.descriptor.gravityScale * deltaTime;
      body.velocity[2] += this.gravity[2] * body.descriptor.gravityScale * deltaTime;

      body.position[0] += body.velocity[0] * deltaTime;
      body.position[1] += body.velocity[1] * deltaTime;
      body.position[2] += body.velocity[2] * deltaTime;

      const collider = this.colliders.get(body.entityId);
      const transform = this.transforms.get(body.entityId);
      if (!collider || !transform || collider.descriptor.isTrigger) {
        continue;
      }

      const aabb = computeColliderAabb(collider.descriptor, transform, body.position);
      if (aabb.min[1] < this.floorY) {
        const offset = this.floorY - aabb.min[1];
        body.position[1] += offset;
        if (body.velocity[1] < 0) {
          body.velocity[1] = 0;
        }
      }
    }

    this.applyConstraints(deltaTime);
    this.rebuildContacts();
    this.syncTransformsFromBodies();
  }

  private applyConstraints(deltaTime: number): void {
    if (this.constraints.size === 0) {
      return;
    }

    for (const constraint of this.constraints.values()) {
      const bodyA = this.bodies.get(constraint.a);
      const bodyB = this.bodies.get(constraint.b);
      if (!bodyA || !bodyB) {
        continue;
      }

      const dynamicA = bodyA.descriptor.mode === "dynamic";
      const dynamicB = bodyB.descriptor.mode === "dynamic";
      if (!dynamicA && !dynamicB) {
        continue;
      }

      const delta = vecSubtract(bodyB.position, bodyA.position);
      const distance = vecLength(delta);
      if (distance <= 0.000001) {
        continue;
      }
      const direction = vecScale(delta, 1 / distance);
      const error = distance - constraint.restLength;
      if (Math.abs(error) <= 0.00001) {
        continue;
      }

      const correction = vecScale(direction, error * constraint.stiffness);
      if (dynamicA && dynamicB) {
        bodyA.position[0] += correction[0] * 0.5;
        bodyA.position[1] += correction[1] * 0.5;
        bodyA.position[2] += correction[2] * 0.5;
        bodyB.position[0] -= correction[0] * 0.5;
        bodyB.position[1] -= correction[1] * 0.5;
        bodyB.position[2] -= correction[2] * 0.5;
      } else if (dynamicA) {
        bodyA.position[0] += correction[0];
        bodyA.position[1] += correction[1];
        bodyA.position[2] += correction[2];
      } else {
        bodyB.position[0] -= correction[0];
        bodyB.position[1] -= correction[1];
        bodyB.position[2] -= correction[2];
      }

      if (constraint.damping > 0 && deltaTime > 0) {
        const relativeVelocity = vecSubtract(bodyB.velocity, bodyA.velocity);
        const alongConstraint = vecDot(relativeVelocity, direction);
        const dampingImpulse = alongConstraint * constraint.damping;
        if (dynamicA && dynamicB) {
          bodyA.velocity[0] += direction[0] * dampingImpulse * 0.5;
          bodyA.velocity[1] += direction[1] * dampingImpulse * 0.5;
          bodyA.velocity[2] += direction[2] * dampingImpulse * 0.5;
          bodyB.velocity[0] -= direction[0] * dampingImpulse * 0.5;
          bodyB.velocity[1] -= direction[1] * dampingImpulse * 0.5;
          bodyB.velocity[2] -= direction[2] * dampingImpulse * 0.5;
        } else if (dynamicA) {
          bodyA.velocity[0] += direction[0] * dampingImpulse;
          bodyA.velocity[1] += direction[1] * dampingImpulse;
          bodyA.velocity[2] += direction[2] * dampingImpulse;
        } else if (dynamicB) {
          bodyB.velocity[0] -= direction[0] * dampingImpulse;
          bodyB.velocity[1] -= direction[1] * dampingImpulse;
          bodyB.velocity[2] -= direction[2] * dampingImpulse;
        }
      }
    }
  }

  private syncTransformsFromBodies(): void {
    for (const [entityId, body] of this.bodies.entries()) {
      const transform = this.transforms.get(entityId);
      if (!transform) {
        continue;
      }
      transform.position = cloneVec3(body.position);
      if (!body.descriptor.lockRotation) {
        transform.rotation = cloneVec3(body.rotation);
      }
    }
  }

  private buildBroadphasePairs(aabbs: Map<string, Aabb>): Set<string> {
    const cellToEntities = new Map<string, string[]>();
    const cellSize = this.broadphaseCellSize;

    for (const [entityId, aabb] of aabbs.entries()) {
      const minX = cellCoord(aabb.min[0], cellSize);
      const minY = cellCoord(aabb.min[1], cellSize);
      const minZ = cellCoord(aabb.min[2], cellSize);
      const maxX = cellCoord(aabb.max[0], cellSize);
      const maxY = cellCoord(aabb.max[1], cellSize);
      const maxZ = cellCoord(aabb.max[2], cellSize);

      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          for (let z = minZ; z <= maxZ; z += 1) {
            const key = cellKey(x, y, z);
            const bucket = cellToEntities.get(key);
            if (bucket) {
              bucket.push(entityId);
            } else {
              cellToEntities.set(key, [entityId]);
            }
          }
        }
      }
    }

    const candidates = new Set<string>();
    for (const entries of cellToEntities.values()) {
      if (entries.length < 2) {
        continue;
      }
      for (let left = 0; left < entries.length - 1; left += 1) {
        for (let right = left + 1; right < entries.length; right += 1) {
          candidates.add(keyPair(entries[left], entries[right]));
        }
      }
    }

    return candidates;
  }

  private rebuildContacts(): void {
    const currentContacts = new Set<string>();
    const currentContactPoints = new Map<string, Vec3>();
    const colliderEntries = [...this.colliders.entries()];
    const aabbs = new Map<string, Aabb>();

    for (const [entityId, collider] of colliderEntries) {
      const transform = this.transforms.get(entityId);
      if (!transform) {
        continue;
      }
      const body = this.bodies.get(entityId);
      aabbs.set(entityId, computeColliderAabb(collider.descriptor, transform, body?.position));
    }

    const candidatePairs = this.buildBroadphasePairs(aabbs);
    for (const pairKey of candidatePairs) {
      const [aId, bId] = splitPair(pairKey);
      const aabbA = aabbs.get(aId);
      const aabbB = aabbs.get(bId);
      if (!aabbA || !aabbB || !aabbIntersects(aabbA, aabbB)) {
        continue;
      }

      const pointA = aabbCenter(aabbA);
      const pointB = aabbCenter(aabbB);
      const point: Vec3 = [(pointA[0] + pointB[0]) / 2, (pointA[1] + pointB[1]) / 2, (pointA[2] + pointB[2]) / 2];

      this.events.push({
        a: aId,
        b: bId,
        type: this.previousContacts.has(pairKey) ? "stay" : "enter",
        point
      });
      currentContacts.add(pairKey);
      currentContactPoints.set(pairKey, point);
    }

    for (const pairKey of this.previousContacts) {
      if (currentContacts.has(pairKey)) {
        continue;
      }
      const [a, b] = pairKey.split("|");
      const point = this.previousContactPoints.get(pairKey) ?? [0, 0, 0];
      this.events.push({
        a,
        b,
        type: "exit",
        point
      });
    }

    this.previousContacts = currentContacts;
    this.previousContactPoints = currentContactPoints;
  }
}
