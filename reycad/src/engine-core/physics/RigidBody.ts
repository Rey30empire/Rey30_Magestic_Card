import type { RigidBodyComponent, TransformComponent, Vec3 } from "../core/Component";

export type PhysicsBodyMode = "dynamic" | "kinematic" | "fixed";

export type RigidBodyDescriptor = {
  mode: PhysicsBodyMode;
  mass: number;
  gravityScale: number;
  lockRotation: boolean;
  linearVelocity: Vec3;
};

export type PhysicsBodyState = {
  entityId: string;
  descriptor: RigidBodyDescriptor;
  position: Vec3;
  rotation: Vec3;
  velocity: Vec3;
};

function cloneVec3(input: Vec3): Vec3 {
  return [input[0], input[1], input[2]];
}

export function toRigidBodyDescriptor(component: RigidBodyComponent): RigidBodyDescriptor {
  return {
    mode: component.mode,
    mass: Number.isFinite(component.mass) && component.mass > 0 ? component.mass : 1,
    gravityScale: Number.isFinite(component.gravityScale) ? component.gravityScale : 1,
    lockRotation: Boolean(component.lockRotation),
    linearVelocity: component.linearVelocity ? cloneVec3(component.linearVelocity) : [0, 0, 0]
  };
}

export function createPhysicsBodyState(entityId: string, transform: TransformComponent, component: RigidBodyComponent): PhysicsBodyState {
  const descriptor = toRigidBodyDescriptor(component);
  return {
    entityId,
    descriptor,
    position: cloneVec3(transform.position),
    rotation: cloneVec3(transform.rotation),
    velocity: cloneVec3(descriptor.linearVelocity)
  };
}
