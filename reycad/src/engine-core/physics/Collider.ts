import type { ColliderComponent, TransformComponent, Vec3 } from "../core/Component";

export type ColliderShape = ColliderComponent["shape"];

export type ColliderDescriptor = {
  shape: ColliderShape;
  isTrigger: boolean;
  size: Vec3;
  radius: number;
  height: number;
};

export type ColliderState = {
  entityId: string;
  descriptor: ColliderDescriptor;
};

export type Aabb = {
  min: Vec3;
  max: Vec3;
};

function cloneVec3(input: Vec3): Vec3 {
  return [input[0], input[1], input[2]];
}

function componentValue(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function normalizeSize(size: Vec3 | undefined): Vec3 {
  if (!size) {
    return [1, 1, 1];
  }
  return [Math.max(0.001, size[0]), Math.max(0.001, size[1]), Math.max(0.001, size[2])];
}

export function toColliderDescriptor(component: ColliderComponent): ColliderDescriptor {
  const size = normalizeSize(component.size);
  const radius = Math.max(0.001, componentValue(component.radius, 0.5));
  const height = Math.max(0.001, componentValue(component.height, 1));
  return {
    shape: component.shape,
    isTrigger: Boolean(component.isTrigger),
    size,
    radius,
    height
  };
}

export function createColliderState(entityId: string, component: ColliderComponent): ColliderState {
  return {
    entityId,
    descriptor: toColliderDescriptor(component)
  };
}

export function computeColliderAabb(collider: ColliderDescriptor, transform: TransformComponent, bodyPosition?: Vec3): Aabb {
  const center = bodyPosition ?? transform.position;
  const scale = transform.scale;

  if (collider.shape === "sphere") {
    const radius = collider.radius * Math.max(scale[0], scale[1], scale[2]);
    return {
      min: [center[0] - radius, center[1] - radius, center[2] - radius],
      max: [center[0] + radius, center[1] + radius, center[2] + radius]
    };
  }

  if (collider.shape === "capsule") {
    const radius = collider.radius * Math.max(scale[0], scale[2]);
    const halfHeight = Math.max(radius, (collider.height * scale[1]) / 2);
    return {
      min: [center[0] - radius, center[1] - halfHeight, center[2] - radius],
      max: [center[0] + radius, center[1] + halfHeight, center[2] + radius]
    };
  }

  const halfX = (collider.size[0] * Math.abs(scale[0])) / 2;
  const halfY = (collider.size[1] * Math.abs(scale[1])) / 2;
  const halfZ = (collider.size[2] * Math.abs(scale[2])) / 2;
  return {
    min: [center[0] - halfX, center[1] - halfY, center[2] - halfZ],
    max: [center[0] + halfX, center[1] + halfY, center[2] + halfZ]
  };
}

export function aabbIntersects(a: Aabb, b: Aabb): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

export function aabbCenter(aabb: Aabb): Vec3 {
  return [(aabb.min[0] + aabb.max[0]) / 2, (aabb.min[1] + aabb.max[1]) / 2, (aabb.min[2] + aabb.max[2]) / 2];
}

export function cloneAabb(aabb: Aabb): Aabb {
  return {
    min: cloneVec3(aabb.min),
    max: cloneVec3(aabb.max)
  };
}
