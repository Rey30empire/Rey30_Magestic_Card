export type ComponentType =
  | "Transform"
  | "MeshRenderer"
  | "RigidBody"
  | "Collider"
  | "Animator"
  | "ParticleEmitter"
  | "Script"
  | "AudioSource"
  | "Light";

export type Vec3 = [number, number, number];

export type TransformComponent = {
  type: "Transform";
  enabled: boolean;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
};

export type MeshRendererComponent = {
  type: "MeshRenderer";
  enabled: boolean;
  meshId: string;
  materialId?: string;
  castShadow?: boolean;
  receiveShadow?: boolean;
};

export type RigidBodyComponent = {
  type: "RigidBody";
  enabled: boolean;
  mode: "dynamic" | "kinematic" | "fixed";
  mass: number;
  gravityScale: number;
  lockRotation: boolean;
  linearVelocity?: Vec3;
};

export type ColliderComponent = {
  type: "Collider";
  enabled: boolean;
  shape: "box" | "sphere" | "capsule" | "mesh";
  isTrigger: boolean;
  size?: Vec3;
  radius?: number;
  height?: number;
};

export type AnimatorComponent = {
  type: "Animator";
  enabled: boolean;
  clip: string;
  speed: number;
  loop: boolean;
};

export type ParticleEmitterComponent = {
  type: "ParticleEmitter";
  enabled: boolean;
  preset: "fire" | "smoke" | "energy" | "hologram" | "sparks";
  rate: number;
  lifetime: number;
};

export type ScriptComponent = {
  type: "Script";
  enabled: boolean;
  scriptId: string;
};

export type AudioSourceComponent = {
  type: "AudioSource";
  enabled: boolean;
  clipId: string;
  volume: number;
  loop: boolean;
};

export type LightComponent = {
  type: "Light";
  enabled: boolean;
  kind: "directional" | "point" | "spot";
  intensity: number;
  color: string;
};

export type EngineComponent =
  | TransformComponent
  | MeshRendererComponent
  | RigidBodyComponent
  | ColliderComponent
  | AnimatorComponent
  | ParticleEmitterComponent
  | ScriptComponent
  | AudioSourceComponent
  | LightComponent;

export function createDefaultTransformComponent(): TransformComponent {
  return {
    type: "Transform",
    enabled: true,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
  };
}
